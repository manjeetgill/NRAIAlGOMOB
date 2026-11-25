/**
 * The prices this phone has already seen, kept for the reads that come back unpriced.
 *
 * Prod's list reads arrive without prices more often than they arrive without rows: `/v1/watchlist/builtin`
 * answers a page of symbols with `ltp: null` while the price read is still running, and a chain read carries
 * the strikes the exchange quoted and nothing for the ones it did not. The stream the app holds prices a
 * contract by its canonical id, so a price seen once — on the strip, in the book, on the ladder, or on the
 * tick stream — is a fact this phone already owns about that same id on another screen. It belongs on the
 * row that is missing one, with the minute it was seen printed beside it.
 *
 * Two rules keep that honest, and both are held by tests/contracts/mobile-quote-memory.test.ts:
 *
 * - A remembered number never outranks a number prod or the stream just sent. It fills gaps only.
 * - A remembered number always says when it was seen. Cash prices age for days because a close is still the
 *   last price the exchange printed; a premium ages for hours because yesterday's 25000 CE is a different
 *   contract's number today, so a contract's remembered price only paints on the day it was printed.
 *
 * Storage is the mobile layer's job (see apps/mobile/src/hooks/useQuoteMemory.ts); everything here is pure so
 * the rules can be tested without a device.
 */

import { LAST_KNOWN_PREFIX } from "./last-known";
import { streamIdFor } from "./account-quotes";
import type { OptionQuote } from "./hooks";
import type { LiveSide } from "./chain-ticks";
import type { QuoteTick } from "./websocket";
import type { StorageAdapter } from "../utils";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One price this phone saw for one canonical instrument id. */
export interface RememberedQuote {
  price: number;
  /** The closing print that price was seen against, when its source named one. */
  close: number | null;
  /** When the price itself was stamped — the exchange's time when it carried one, otherwise the moment this
   *  phone saw it. It is the minute the label reports, so it must never be the app's clock when the source
   *  knew better. */
  at: string;
}

export type QuoteMemory = Record<string, RememberedQuote>;

/** What a screen offers the memory. An id the stream could not have produced is not offered at all. */
export interface QuoteEntry {
  id: string;
  price: number;
  close?: number | null;
  at?: number | string | null;
}

/** Under the account keys, so ending a session forgets the prices with the book they belong to. */
export const QUOTE_MEMORY_KEY = `${LAST_KNOWN_PREFIX}quotes`;

/** A ladder is a couple of hundred legs and the app's lists are a few dozen symbols; past that the oldest
 *  prices go, since the freshest ones are the only ones a label can still stand behind. */
export const QUOTE_MEMORY_MAX = 600;

/** How long a remembered price may paint. Cash ages for days; a contract only for its own trading day. */
export const QUOTE_MEMORY_CASH_MAX_AGE_MS = 3 * DAY_MS;

/** The segments the stream publishes an id for: a share, an index, or a contract. */
const KNOWN_SEGMENTS = new Set(["EQ", "INDEX", "FO"]);

/** Whether this id names a contract, whose premium decays while the market sleeps. */
function isContract(id: string): boolean {
  return id.split(":")[3] === "FO";
}

/** The ms a stamp means, or null when it names no moment at all. */
export function stampMs(at: string | number | null | undefined): number | null {
  if (at === null || at === undefined || at === "") return null;
  if (typeof at === "number") return Number.isFinite(at) ? at : null;
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Whether this price may still be painted where one is missing.
 *
 * Both halves are honesty, not tidiness: nothing without a time on it can be labelled, and a premium from an
 * earlier day would print a number the exchange no longer quotes for that strike.
 */
export function paintable(id: string, entry: RememberedQuote | undefined, now: number = Date.now()): boolean {
  if (!entry || !id.startsWith("instrument:v1:")) return false;
  if (!KNOWN_SEGMENTS.has(id.split(":")[3])) return false;
  const at = stampMs(entry.at);
  if (at === null || at > now) return false;
  if (isContract(id)) return sameIstDay(at, now);
  return now - at <= QUOTE_MEMORY_CASH_MAX_AGE_MS;
}

/** The exchange's zone, spelled as a fixed offset: IST has no daylight saving, so no Date API local-zone call
 *  belongs in a rule that decides whether a premium is still today's. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** The trading day a stamp falls on, in the exchange's own zone, so midnight there — not the phone's — ends it. */
function istDay(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function sameIstDay(a: number, b: number): boolean {
  return istDay(a) === istDay(b);
}

/**
 * Offer prices to the memory, newest wins.
 *
 * The reference is kept when nothing was learned, which is what lets a screen call this on every tick batch
 * without invalidating the rows it just painted. A stamp the source did not carry becomes the phone's clock,
 * because "this is the price I had at 14:58" is still a true sentence about it.
 */
export function rememberQuotes(memory: QuoteMemory, entries: readonly QuoteEntry[], now: number = Date.now()): QuoteMemory {
  let next: QuoteMemory | null = null;
  for (const entry of entries) {
    const id = (entry.id ?? "").trim();
    const price = Number(entry.price);
    if (!id.startsWith("instrument:v1:") || !Number.isFinite(price) || price <= 0) continue;
    const at = stampMs(entry.at) ?? now;
    const held = memory[id];
    const close = entry.close === null || entry.close === undefined
      ? (held?.close ?? null)
      : (Number(entry.close) > 0 ? Number(entry.close) : null);
    if (held) {
      const heldAt = stampMs(held.at);
      if (heldAt !== null && heldAt > at) continue;
      if (held.price === price && held.close === close && stampMs(held.at) === at) continue;
    }
    next = next ?? { ...memory };
    next[id] = { price, close, at: new Date(at).toISOString() };
  }
  if (!next) return memory;
  const ids = Object.keys(next);
  if (ids.length <= QUOTE_MEMORY_MAX) return next;
  // Over the cap, the oldest prices leave first: the entry a trader is looking at is the one just seen.
  const keeper = new Set(
    ids.sort((a, b) => (stampMs(next![a].at) ?? 0) - (stampMs(next![b].at) ?? 0)).slice(-QUOTE_MEMORY_MAX),
  );
  const trimmed: QuoteMemory = {};
  for (const id of ids) if (keeper.has(id)) trimmed[id] = next[id];
  return trimmed;
}

const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/**
 * The minute a remembered price was seen, in the words that go beside it.
 *
 * A number on a trading screen is a claim about the market, so it carries its own time rather than a bare
 * price: the trader reads "seen 14:58" as yesterday's number before they read it as a quote.
 */
export function seenLine(at: string | null | undefined, now: Date = new Date()): string | null {
  const ms = stampMs(at);
  if (ms === null) return null;
  const then = new Date(ms);
  const clock = `${String(then.getHours()).padStart(2, "0")}:${String(then.getMinutes()).padStart(2, "0")}`;
  if (dayKey(then) === dayKey(now)) return `seen ${clock}`;
  const yesterday = new Date(now.getTime() - DAY_MS);
  if (dayKey(then) === dayKey(yesterday)) return `seen yesterday ${clock}`;
  return `seen on ${String(then.getDate()).padStart(2, "0")}/${String(then.getMonth() + 1).padStart(2, "0")} ${clock}`;
}

/** What a screen marks on a row it painted from memory. */
export interface Remembered {
  /** The minute the painted price was seen, or null while the number came from prod or the stream. */
  seen: string | null;
}

/**
 * Unpriced watchlist rows painted from memory.
 *
 * `markWatchlist` has already had its chance: a row that reaches here with no price has neither a fresh tick
 * nor a number from prod's read. The day's figures follow the same pair rule the live path uses — the close
 * the price was seen with first, then the close prod sent beside the row — so a remembered row carries an
 * arithmetic the server would agree with rather than a move measured against nothing.
 */
export function paintWatchlist<T extends {
  exchange: string;
  symbol: string;
  ltp: number | null;
  close: number | null;
  change: number | null;
  changePct: number | null;
}>(rows: readonly T[], seen: (id: string | null) => RememberedQuote | null): (T & Remembered)[] {
  return rows.map((row) => {
    if (row.ltp !== null && Number.isFinite(row.ltp)) return { ...row, seen: null };
    const id = streamIdFor({ exchange: row.exchange, symbol: row.symbol, product: "CASH", expiry: null, strike: null, right: null });
    const hit = seen(id);
    if (!hit) return { ...row, seen: null };
    const previous = hit.close ?? row.close;
    if (typeof previous !== "number" || !Number.isFinite(previous) || previous <= 0) {
      return { ...row, ltp: hit.price, seen: seenLine(hit.at) };
    }
    const change = Math.round((hit.price - previous) * 100) / 100;
    return {
      ...row,
      ltp: hit.price,
      close: previous,
      change,
      changePct: Math.round((change / previous) * 10000) / 100,
      seen: seenLine(hit.at),
    };
  });
}

/**
 * One leg painted from memory because neither the stream nor the chain read priced it.
 *
 * `word` is the age, not a status: a remembered premium is not a delayed quote from the exchange, it is the
 * number this phone had at a minute it can name.
 */
export function rememberedSide(entry: RememberedQuote | null | undefined): LiveSide | null {
  if (!entry || !(entry.price > 0)) return null;
  return { price: entry.price, word: seenLine(entry.at), ticked: false };
}

/** The prices the stream just published, offered to memory with the exchange's own stamp. */
export function tickEntries(quotes: readonly QuoteTick[]): QuoteEntry[] {
  const entries: QuoteEntry[] = [];
  for (const tick of quotes) {
    const price = Number(tick.price);
    if (!tick.id || !tick.id.startsWith("instrument:v1:") || !Number.isFinite(price) || price <= 0) continue;
    // A tick with no exchange time is the phone's own knowledge, and the label says so rather than claiming
    // a stamp the server never sent.
    entries.push({ id: tick.id, price, close: tick.previousClose ?? null, at: tick.at ?? null });
  }
  return entries;
}

/** The prices prod put on these ladder legs itself, so a quoted strike is remembered even off-hours. */
export function legEntries(sides: readonly (OptionQuote | null | undefined)[]): QuoteEntry[] {
  const entries: QuoteEntry[] = [];
  for (const side of sides) {
    const id = side?.instrumentId;
    const price = side ? Number(side.ltp) : Number.NaN;
    if (!id || !id.startsWith("instrument:v1:") || !Number.isFinite(price) || price <= 0) continue;
    entries.push({ id, price, close: null, at: side!.ltpAt ?? side!.quote?.at ?? null });
  }
  return entries;
}

/** The prices prod put on these cash rows itself, so a list it did price is still remembered an hour later,
 *  when the next read of the same page comes back with the symbols and not the numbers. */
export function cashEntries<T extends { exchange: string; symbol: string; ltp: number | null; close: number | null }>(
  rows: readonly T[],
): QuoteEntry[] {
  const entries: QuoteEntry[] = [];
  for (const row of rows) {
    const price = Number(row.ltp);
    if (!Number.isFinite(price) || price <= 0) continue;
    const id = streamIdFor({ exchange: row.exchange, symbol: row.symbol, product: "CASH", expiry: null, strike: null, right: null });
    if (id) entries.push({ id, price, close: row.close, at: null });
  }
  return entries;
}

/** The saved prices, or an empty memory when nothing was ever kept, the copy is unreadable, or every entry
 *  has aged past what its own label could still stand behind. */
export async function readQuoteMemory(storage: StorageAdapter, now: number = Date.now()): Promise<QuoteMemory> {
  let raw: string | null = null;
  try {
    raw = await storage.getItem(QUOTE_MEMORY_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as QuoteMemory;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const clean: QuoteMemory = {};
    for (const [id, entry] of Object.entries(parsed)) {
      const price = Number((entry as RememberedQuote)?.price);
      const at = (entry as RememberedQuote)?.at;
      if (!id.startsWith("instrument:v1:") || !Number.isFinite(price) || price <= 0 || stampMs(at) === null) continue;
      const close = Number((entry as RememberedQuote)?.close);
      if (paintable(id, { price, close: Number.isFinite(close) && close > 0 ? close : null, at }, now)) {
        clean[id] = { price, close: Number.isFinite(close) && close > 0 ? close : null, at };
      }
    }
    return clean;
  } catch {
    return {};
  }
}

/** Keep the prices the app has just been shown. An empty memory never overwrites a saved one. */
export function writeQuoteMemory(storage: StorageAdapter, memory: QuoteMemory): Promise<void> {
  if (Object.keys(memory).length === 0) return Promise.resolve();
  return storage.setItem(QUOTE_MEMORY_KEY, JSON.stringify(memory));
}
