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
let reason: FeedReason = null;
let socket: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let failures = 0;

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
    quotes: [...published.values()].filter((q) => set.has(q.id)),
    states,
    connected,
    asOf,
  };
}

function publish() {
  for (const watcher of watchers) watcher.handler(snapshotFor(watcher.ids));
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
  if (frame.mode !== "delta") published = new Map();
  for (const quote of quotes) {
    const id = typeof quote.id === "string" ? quote.id : "";
    const price = Number(quote.price);
    if (!id || !(price > 0) || !Number.isFinite(price)) continue;
    published.set(quoteKey(quote), toTick(quote, id));
  }
  for (const key of Array.isArray(frame.removed) ? frame.removed : []) published.delete(key);
  if (frame.states && typeof frame.states === "object") states = frame.states;
  if (typeof frame.asOf === "string") asOf = frame.asOf;
  publish();
}

function scheduleConnect() {
  if (retry || !watchers.size) return;
  // A refusal is not an outage: the origin, the sign-in, the edition, the price provider or the three-tab cap
  // said no on purpose. Retrying it would be load, not a fix, so the screen keeps showing why until a
  // registration starts over.
  if (reason === "policy" || reason === "capacity") return;
  // A dropped socket is retried with backoff, then left alone: a screen keeps showing why
  // there are no live prices instead of the app hammering prod for the rest of the session.
  if (failures >= Constants.API.WS_MAX_RECONNECT_ATTEMPTS) return;
  const delay = Constants.API.WS_RECONNECT_DELAY * Math.min(2 ** failures, 8);
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
    publish();
  };
  ws.onmessage = (event) => {
    let value: WireFrame;
    try {
      value = JSON.parse(String(event.data)) as WireFrame;
    } catch {
      return;
    }
    accept(value);
  };
  ws.onclose = (event) => {
    connected = false;
    if (socket === ws) socket = null;
    published = new Map();
    // 1008 is a policy close: the origin, the sign-in, the edition or the price provider gate refused us.
    // 1013 means this workspace already holds its three tabs. Neither clears by hammering the server.
    reason = event.code === 1008 ? "policy" : event.code === 1013 ? "capacity" : "closed";
    publish();
    if (watchers.size) scheduleConnect();
  };
  ws.onerror = () => {
    // The close that follows carries the reason; RN reports no code here.
  };
}

function disconnect() {
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
 * Watch canonical instrument ids on the shared stream. The handler receives a snapshot of just those ids on
 * every frame, on connect and on close, so a screen can paint from the first callback without polling.
 */
export function watchQuotes(ids: readonly string[], handler: (feed: FeedSnapshot) => void): () => void {
  const first = watchers.size === 0;
  const watcher: Watcher = { ids, handler };
  watchers.add(watcher);
  handler(snapshotFor(ids));
  // A screen mounting after the app was closed, signed in, or simply left the tab open deserves a fresh try.
  if (first && !socket) {
    failures = 0;
    reason = null;
  }
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
  const ids = [...new Set(symbols)].sort();
  const key = ids.join(",");
  const [feed, setFeed] = useState<FeedSnapshot & { reason: FeedReason }>({ ...EMPTY_FEED, reason: null });

  useEffect(() => {
    if (!enabled || !key) return;
    let active = true;
    const stop = watchQuotes(key.split(","), (next) => {
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
    connectionState: feed.reason ? "refused" : feed.connected ? "connected" : ids.length ? "connecting" : "disconnected",
    lastTick: feed.quotes.at(-1) ?? null,
    error,
  };
}

/** Screens that only need the feed itself (latest prices and connection state), not per-tick callbacks. */
export function useQuoteFeed(symbols: readonly string[], enabled = true) {
  return useRegistration(symbols, enabled).feed;
}

