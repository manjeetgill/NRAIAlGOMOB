/**
 * Quotes socket - the one prod tick stream, shared by every screen.
 *
 * Wire contract (backend/python/nraialgo/api/quotes.py): the client sends
 * `{"type":"subscribe","instruments":[<canonical id>, ...]}` and the server answers with a full snapshot on
 * connect and bounded deltas afterwards - `{asOf, mode, states, quotes: [{id, price, exchangeTime, fresh,
 * dataStatus, ...}], removed}`. A frame carries prices with their exchange timestamps, never candles, so bars
 * are built from ticks by `live-candles.ts`.
 *
 * The socket is module-level on purpose: the server allows three tabs per workspace, so one app must hold one
 * connection and multiplex the screens' instrument sets over it.
 *
 * Handshake notes, both required by prod:
 * - the `origin` header must be one the API allows (`https://myalgodesk.in` in production), or the socket
 *   closes with 1008. React Native sends no browser origin, so it is declared from the configured base URL.
 *   The header is not a credential: identity still comes from the session cookie the native cookie jar
 *   replays, exactly as the REST calls do.
 * - every message is a subscription replace, never a delta, so a screen unmounting cannot drop another
 *   screen's instruments.
 *
 * Liveness is the client's own job, because the platform reports a healthy socket for a stream that has
 * stopped carrying frames and suspends the connection while the app is not showing: `armSilence` recycles a
 * pipe that goes quiet, and `recoverQuoteStream` starts the retry over when the app returns to the
 * foreground or the network comes back. Both retire the connection instead of papering over it, so a screen
 * keeps saying what the prices actually are.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Constants } from "../constants";

/** One published price. `at` is the exchange timestamp in ms epoch, null when the broker sent none. */
export interface QuoteTick {
  id: string;
  price: number;
  at: number | null;
  fresh: boolean;
  /** The server's own freshness label (LIVE, DELAYED, STALE, FALLBACK, MARKET_CLOSED, ...). */
  status: string | null;
  /** Which source published this price: a vendor, or a broker standing in for one. */
  source: string | null;
  broker: string;
  subscriptionId: string;
  /**
   * The exchange's previous close sent with this tick, when the broker's frame carried one. A screen may
   * measure a day's change against it; it is never filled in from another source, because a change computed
   * against the wrong close is a wrong number, not a fuller one.
   */
  previousClose?: number | null;
}

export interface FeedSnapshot {
  quotes: QuoteTick[];
  states: Record<string, string>;
  connected: boolean;
  asOf: string | null;
}

/** Why the stream is not carrying prices, in words the trader can read. */
export type FeedReason = "closed" | "policy" | "capacity" | null;

const EMPTY_FEED: FeedSnapshot = { quotes: [], states: {}, connected: false, asOf: null };

interface WireQuote {
  id?: string | null;
  broker?: string;
  accountId?: string;
  subscriptionId?: string;
  price?: number;
  exchangeTime?: string | null;
  dataStatus?: string;
  priceStatus?: string;
  priceSource?: string;
  previousClose?: number | string | null;
  fresh?: boolean;
}

interface WireFrame {
  asOf?: string;
  mode?: string;
  states?: Record<string, string>;
  quotes?: WireQuote[];
  removed?: string[];
}

interface Watcher {
  ids: readonly string[];
  handler: (feed: FeedSnapshot) => void;
}

const watchers = new Set<Watcher>();
/** The composite key the server deltas against: [broker, accountId, subscriptionId] as JSON. */
let published = new Map<string, QuoteTick>();
let states: Record<string, string> = {};
let asOf: string | null = null;
let connected = false;
/** When the socket last carried a price the server called fresh; 0 before the first one. */
let lastFreshTickAt = 0;
/** When each instrument id last carried a fresh price, so a screen can ask about its own rows only. */
const freshAtById = new Map<string, number>();
let reason: FeedReason = null;
let socket: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let failures = 0;
/** Armed while the socket is open and disarmed the moment a frame arrives. See `armSilence`. */
let silence: ReturnType<typeof setTimeout> | null = null;

function quoteKey(quote: WireQuote): string {
  return JSON.stringify([quote.broker ?? "", quote.accountId ?? "", quote.subscriptionId ?? ""]);
}

function positiveNumber(value: number | string | null | undefined): number | null {
  const number = typeof value === "string" ? Number(value.trim()) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0 ? number : null;
}

function toTick(quote: WireQuote, id: string): QuoteTick {
  const at = Date.parse(quote.exchangeTime ?? "");
  return {
    id,
    price: Number(quote.price),
    at: Number.isFinite(at) ? at : null,
    fresh: quote.fresh === true,
    status: quote.dataStatus ?? quote.priceStatus ?? null,
    source: quote.priceSource ?? quote.broker ?? null,
    broker: quote.broker ?? "",
    subscriptionId: quote.subscriptionId ?? "",
    previousClose: positiveNumber(quote.previousClose),
  };
}

function snapshotFor(ids: readonly string[]): FeedSnapshot {
  const set = new Set(ids);
  return {
    quotes: ids.length === 0 ? [...published.values()] : [...published.values()].filter((q) => set.has(q.id)),
    states,
    connected,
    asOf,
  };
}

let isSuspended = false;
/**
 * What the publishes buffered until the throttle window closes have to say. A connect, a close and a
 * snapshot frame each say "everything on this screen may have moved", which is not the same message as a
 * delta that moved nothing — so the two are held apart instead of both arriving as an empty set. Building
 * a set out of an absent argument yields an empty one, and an empty filter skips every watcher: the whole
 * feed would sit behind a screen that had already been told the truth.
 */
let pendingIds: Set<string> | undefined;
let pendingAll = false;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let lastPublishTime = 0;
const isTestEnv = typeof globalThis !== "undefined" && (globalThis as any).process?.env?.NODE_ENV === "test";
const THROTTLE_MS = isTestEnv ? 0 : 100;

/** Suspends UI state notifications from quote ticks (e.g. while scrolling a list). */
export function pauseQuoteDispatch() {
  isSuspended = true;
}

/** Resumes UI notifications and flushes the latest buffered quote snapshot. */
export function resumeQuoteDispatch() {
  if (!isSuspended) return;
  isSuspended = false;
  if (hasBuffered()) publishImmediate(takeBuffered());
}

function hasBuffered(): boolean {
  return pendingAll || pendingIds !== undefined;
}

function bufferPublish(changedIds: Set<string> | undefined) {
  if (changedIds === undefined) pendingAll = true;
  else if (!pendingAll) {
    if (pendingIds) for (const id of changedIds) pendingIds.add(id);
    else pendingIds = new Set(changedIds);
  }
}

function takeBuffered(): Set<string> | undefined {
  const all = pendingAll;
  const ids = pendingIds;
  pendingAll = false;
  pendingIds = undefined;
  return all ? undefined : ids;
}

function clearTimer() {
  if (throttleTimer) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
}

function discardBuffered() {
  clearTimer();
  pendingAll = false;
  pendingIds = undefined;
}

function publishImmediate(changedIds?: Set<string>) {
  lastPublishTime = Date.now();
  for (const watcher of watchers) {
    if (changedIds && watcher.ids.length > 0) {
      const affectsWatcher = watcher.ids.some((id) => changedIds.has(id));
      if (!affectsWatcher) continue;
    }
    watcher.handler(snapshotFor(watcher.ids));
  }
}

function publish(changedIds?: Set<string>) {
  bufferPublish(changedIds);
  if (isSuspended) return;
  const wait = THROTTLE_MS === 0 ? -1 : THROTTLE_MS - (Date.now() - lastPublishTime);
  if (wait <= 0) {
    const flushed = takeBuffered();
    clearTimer();
    publishImmediate(flushed);
    return;
  }
  if (throttleTimer) return;
  throttleTimer = setTimeout(() => {
    throttleTimer = null;
    if (!isSuspended && hasBuffered()) publishImmediate(takeBuffered());
  }, wait);
}

function desiredInstruments(): string[] {
  return [...new Set([...watchers].flatMap((watcher) => watcher.ids))].sort();
}

function sendSubscriptions() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "subscribe", instruments: desiredInstruments() }));
  }
}

function openSocket(url: string): WebSocket {
  // React Native's WebSocket takes the connection options as a third argument; the DOM typings do not declare it.
  const connect = WebSocket as unknown as new (
    url: string,
    protocols?: string | string[] | null,
    options?: { headers?: Record<string, string> },
  ) => WebSocket;
  return new connect(url, null, { headers: { origin: Constants.API.BASE_URL } });
}

function accept(frame: WireFrame) {
  const quotes = Array.isArray(frame.quotes) ? frame.quotes : [];
  const changedIds = new Set<string>();
  if (frame.mode !== "delta") published = new Map();
  for (const quote of quotes) {
    const id = typeof quote.id === "string" && quote.id ? quote.id : quote.subscriptionId ?? "";
    const price = Number(quote.price);
    if (!id || !(price > 0) || !Number.isFinite(price)) continue;
    const tick = toTick(quote, id);
    published.set(quoteKey(quote), tick);
    if (tick.fresh) {
      lastFreshTickAt = Date.now();
      freshAtById.set(id, lastFreshTickAt);
    }
    changedIds.add(id);
  }
  for (const key of Array.isArray(frame.removed) ? frame.removed : []) {
    const existing = published.get(key);
    if (existing) changedIds.add(existing.id);
    published.delete(key);
    changedIds.add(key);
  }
  if (frame.states && typeof frame.states === "object") states = frame.states;
  if (typeof frame.asOf === "string") asOf = frame.asOf;
  publish(frame.mode === "delta" ? changedIds : undefined);
}

function clearSilence() {
  if (silence) {
    clearTimeout(silence);
    silence = null;
  }
}

/**
 * Recycle a pipe the platform still calls open.
 *
 * Prod's stream can hold a connection that reports "icici: streaming" while its producer publishes nothing
 * (25 Nov 2026: no tick for the last hour of the session while REST stayed live). Only the client notices a
 * socket that is open and silent, so it closes it here: the ordinary close path clears the dead prices, names
 * the feed and schedules the retry, which is what a screen needs to start painting again.
 *
 * It is armed only while this app has actually asked for instruments — a stream subscribed to nothing answers
 * with nothing, and that is the correct answer rather than an outage.
 */
function armSilence() {
  clearSilence();
  if (desiredInstruments().length === 0) return;
  silence = setTimeout(() => {
    silence = null;
    const ws = socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.close();
    } catch {
      // A pipe the platform will not even close: retire it here, or the screen waits on a dead feed forever.
      if (socket === ws) socket = null;
      connected = false;
      published = new Map();
      reason = "closed";
      publish();
      scheduleConnect();
    }
  }, Constants.API.WS_SILENCE_MS);
}

function scheduleConnect() {
  if (retry || !watchers.size) return;
  // A policy close (1008) is a refusal of something the server will not change on a timer: the origin, the
  // sign-in, the edition or the price provider gate. Re-asking would be load, not a fix, so the screen keeps
  // showing why until the app comes back to the foreground or a screen re-registers, both of which clear it.
  if (reason === "policy") return;
  // A dropped socket, and a workspace at its three-tab cap (1013), both clear on their own — a tab closes,
  // the network comes back — so the retry slows to WS_RECONNECT_MAX_DELAY and never stops while a screen
  // is watching. Stopping after a fixed budget instead left a phone that lost the network for a minute
  // showing dead prices until the app was restarted.
  const delay = Math.min(
    Constants.API.WS_RECONNECT_DELAY * 2 ** failures,
    Constants.API.WS_RECONNECT_MAX_DELAY,
  );
  failures += 1;
  retry = setTimeout(() => {
    retry = null;
    connect();
  }, delay);
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (!watchers.size) return;
  const url = `${Constants.API.WS_URL}${Constants.ENDPOINTS.QUOTES_STREAM}`;
  let ws: WebSocket;
  try {
    ws = openSocket(url);
  } catch {
    scheduleConnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    failures = 0;
    connected = true;
    reason = null;
    sendSubscriptions();
    armSilence();
    publish();
  };
  ws.onmessage = (event) => {
    let value: WireFrame;
    try {
      value = JSON.parse(String(event.data)) as WireFrame;
    } catch {
      return;
    }
    armSilence();
    accept(value);
  };
  ws.onclose = (event) => {
    connected = false;
    clearSilence();
    if (socket === ws) socket = null;
    published = new Map();
    // 1008 is a policy close: the origin, the sign-in, the edition or the price provider gate refused us.
    // 1013 means this workspace already holds its three tabs, which a retry at the slow cadence outlasts.
    reason = event.code === 1008 ? "policy" : event.code === 1013 ? "capacity" : "closed";
    publish();
    if (watchers.size) scheduleConnect();
  };
  ws.onerror = () => {
    // The close that follows carries the reason; RN reports no code here.
  };
}

function disconnect() {
  clearSilence();
  discardBuffered();
  if (retry) {
    clearTimeout(retry);
    retry = null;
  }
  const ws = socket;
  socket = null;
  if (ws) {
    ws.onclose = null;
    ws.onmessage = null;
    ws.onopen = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // Already closed by the platform.
    }
  }
  connected = false;
  published = new Map();
  reason = "closed";
}

/**
 * Start the stream's recovery over, for the moments that genuinely change the answer: the app came back to
 * the foreground, or the network came back.
 *
 * A phone suspends a socket it is not showing, so the one a screen finds on return is usually open and
 * empty rather than closed, and a refusal the server issued against a tab that has since closed is not a
 * refusal this app should keep honouring. The budget and the refusal are both cleared and the connection is
 * replaced; a stream that is already carrying frames is recycled too, because the cost of one reconnect is
 * far less than the wait for a watchdog nobody knows has fired.
 */
export function recoverQuoteStream() {
  failures = 0;
  clearSilence();
  if (retry) {
    clearTimeout(retry);
    retry = null;
  }
  reason = null;
  if (!watchers.size) return;
  const ws = socket;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    try {
      ws.close();
    } catch {
      socket = null;
      connect();
    }
    return;
  }
  socket = null;
  connect();
}

/**
 * Watch canonical instrument ids on the shared stream. The handler receives a snapshot of just those ids on
 * every frame, on connect and on close, so a screen can paint from the first callback without polling.
 */
export function watchQuotes(ids: readonly string[], handler: (feed: FeedSnapshot) => void): () => void {
  const watcher: Watcher = { ids, handler };
  watchers.add(watcher);
  // A screen mounting after the app was closed, signed in, refused, or simply left the tab open deserves a
  // fresh try rather than the previous attempt's exhausted budget — and its first paint must not carry the
  // old refusal, which would tell the trader the stream said no when this one has not asked yet.
  if (!socket) {
    failures = 0;
    reason = null;
  }
  handler(snapshotFor(ids));
  if (socket && socket.readyState === WebSocket.OPEN) sendSubscriptions();
  else connect();
  return () => {
    watchers.delete(watcher);
    if (!watchers.size) disconnect();
    else if (socket && socket.readyState === WebSocket.OPEN) sendSubscriptions();
  };
}

/**
 * One screen's registration with the shared socket. The instrument set is declarative: when it changes this
 * effect re-runs and replaces the connection's subscription, so a screen never has to remember to re-send.
 */
function useRegistration(symbols: readonly string[], enabled: boolean) {
  const ids = useMemo(() => [...new Set(symbols)].sort(), [symbols]);
  const key = useMemo(() => ids.join(","), [ids]);
  const [feed, setFeed] = useState<FeedSnapshot & { reason: FeedReason }>({ ...EMPTY_FEED, reason: null });

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const instruments = key ? key.split(",") : [];
    const stop = watchQuotes(instruments, (next) => {
      if (active) setFeed({ ...next, reason });
    });
    return () => {
      active = false;
      stop();
    };
  }, [enabled, key]);

  return { ids, feed };
}

export interface UseQuotesStreamOptions {
  symbols: string[];
  enabled?: boolean;
  onMessage?: (tick: QuoteTick) => void;
  onError?: (error: Error) => void;
}

export interface UseQuotesStreamReturn {
  isConnected: boolean;
  connectionState: "connecting" | "connected" | "disconnected" | "refused";
  lastTick: QuoteTick | null;
  error: Error | null;
}

const REFUSAL_TEXT: Record<Exclude<FeedReason, null>, string> = {
  policy: "The live price stream refused this device.",
  capacity: "This account already has three live streams open.",
  closed: "The live price stream is not connected.",
};

/** The same stream as a hook: every tick this screen asked for, carried by the app's single socket. */
export function useQuotesStream(options: UseQuotesStreamOptions): UseQuotesStreamReturn {
  const { symbols, enabled = true, onMessage, onError } = options;
  const { ids, feed } = useRegistration(symbols, enabled);
  const callbacks = useRef({ onMessage, onError });
  callbacks.current = { onMessage, onError };

  useEffect(() => {
    for (const tick of feed.quotes) callbacks.current.onMessage?.(tick);
  }, [feed]);

  // One error object per refusal: a fresh one on every render would re-run the effect below for the same
  // closed socket and the screen would report a refusal it had already reported.
  const reason = feed.reason;
  const error = useMemo(
    () => (reason ? Object.assign(new Error(REFUSAL_TEXT[reason]), { name: "QuoteStreamRefused" }) : null),
    [reason],
  );
  useEffect(() => {
    if (error) callbacks.current.onError?.(error);
  }, [error]);

  return {
    isConnected: feed.connected,
    connectionState: feed.reason ? "refused" : feed.connected ? "connected" : "connecting",
    lastTick: feed.quotes.at(-1) ?? null,
    error,
  };
}

/** A socket that is open but has carried no fresh price for this long is not feeding the screens. */
const LIVE_TICK_MS = 30_000;

/**
 * Whether the live price socket is open AND has delivered a fresh price in the last 30 s. Polls read it
 * on every cycle, so a screen whose prices tick from the socket only re-reads REST as a slow safety net.
 * An open socket alone is not enough: on 25 Nov 2026 the server's feed froze while its keepalives went on,
 * and a screen that slowed its REST read on "connected" would have frozen with it. After the close no
 * fresh ticks arrive, so screens go back to their normal reads of the server's closing prices.
 */
export function quoteStreamConnected(): boolean {
  return connected && reason === null && Date.now() - lastFreshTickAt < LIVE_TICK_MS;
}

/**
 * Whether the live price socket is carrying THIS screen's prices: open, unrefused, and at least one of
 * `ids` ticked fresh in the last 30 s. `quoteStreamConnected()` is app-global - true when any instrument
 * anywhere ticked - so a screen whose ids are not carried would slow its REST read on prices it never
 * receives. With no ids there is nothing on the socket for the screen, so the answer is false.
 */
export function quoteStreamCarrying(ids: readonly string[]): boolean {
  if (!connected || reason !== null || ids.length === 0) return false;
  const now = Date.now();
  return ids.some((id) => now - (freshAtById.get(id) ?? 0) < LIVE_TICK_MS);
}

/** Screens that only need the feed itself (latest prices and connection state), not per-tick callbacks. */
export function useQuoteFeed(symbols: readonly string[], enabled = true) {
  return useRegistration(symbols, enabled).feed;
}

