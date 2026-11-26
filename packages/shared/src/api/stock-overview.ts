/**
 * What a stock's Overview screen is allowed to say, derived from prod's single-symbol read.
 *
 * `GET /v1/equities/quote` answers with the price, the day's statics and - only when the account's socket holds
 * that view - the five-level book. Prod omits a field it has no evidence for instead of sending a zero, so every
 * figure here is either something the server published or a stated reason it is absent. A screen cannot make a
 * missing circuit limit look like a real one by drawing a bar for it.
 */

import { formatISTTime, isTodayIST } from "../utils";

/** One rung as the broker sends it: numbers, or numeric text on a frame that came from the socket. */
export interface QuoteLevel {
  price?: number | string | null;
  quantity?: number | string | null;
  orders?: number | string | null;
}

/** The fields the Overview reads, shaped as a subset so a test can hand it a plain object. */
export interface OverviewQuote {
  ltp?: number | null;
  close?: number | null;
  change?: number | null;
  changePct?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  high52?: number | null;
  low52?: number | null;
  volume?: number | null;
  averagePrice?: number | null;
  bid?: number | null;
  ask?: number | null;
  bidQuantity?: number | null;
  askQuantity?: number | null;
  at?: string | null;
  depthAt?: string | null;
  priceDate?: string | null;
  quality?: string | null;
  source?: string | null;
  depthMessage?: string | null;
  depth?: { buy?: QuoteLevel[] | null; sell?: QuoteLevel[] | null } | null;
}

export interface Rung {
  price: number;
  quantity: number;
  orders: number | null;
}

export interface Book {
  bids: Rung[];
  asks: Rung[];
  /** Shares bid across the two sides shown, so a one-sided book reads as 100% rather than 50%. */
  bidShare: number | null;
  tbq: number | null;
  tsq: number | null;
  /** True when the ladder is the quote's top of book only, which the screen must label instead of passing off. */
  topOfBookOnly: boolean;
}

function positive(value: number | string | null | undefined): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Rungs the broker actually priced: no price, no rung - an empty level is not a zero-price level. */
function rungs(levels: QuoteLevel[] | null | undefined): Rung[] {
  if (!Array.isArray(levels)) return [];
  const kept: Rung[] = [];
  for (const level of levels) {
    const price = positive(level?.price);
    const quantity = positive(level?.quantity);
    if (price === null || quantity === null) continue;
    const orders = typeof level.orders === "number" && Number.isFinite(level.orders) ? level.orders : null;
    kept.push({ price, quantity, orders });
  }
  return kept;
}

/**
 * The ladder to draw, from the socket's five levels when prod has them and otherwise from the read's own
 * best bid and ask. A one-level book is still shown - it is the real top of book - but `topOfBookOnly` says so,
 * because a five-deep ladder that is actually two numbers would misrepresent the market.
 */
export function depthBook(quote: OverviewQuote | null | undefined): Book {
  const bids = rungs(quote?.depth?.buy);
  const asks = rungs(quote?.depth?.sell);
  const topOfBookOnly = bids.length === 0 && asks.length === 0;
  if (topOfBookOnly) {
    const bid = positive(quote?.bid);
    const ask = positive(quote?.ask);
    if (bid !== null) bids.push({ price: bid, quantity: positive(quote?.bidQuantity) ?? 0, orders: null });
    if (ask !== null) asks.push({ price: ask, quantity: positive(quote?.askQuantity) ?? 0, orders: null });
  }
  const tbq = bids.length ? bids.reduce((sum, rung) => sum + rung.quantity, 0) : null;
  const tsq = asks.length ? asks.reduce((sum, rung) => sum + rung.quantity, 0) : null;
  const both = (tbq ?? 0) + (tsq ?? 0);
  return {
    bids,
    asks,
    tbq,
    tsq,
    topOfBookOnly,
    bidShare: tbq === null || tsq === null || both <= 0 ? null : Math.round((tbq / both) * 1000) / 10,
  };
}

/**
 * Where a price sits inside a range, as a percentage for the bar.
 *
 * Null whenever the range is not real - a missing bound, or a high at or below the low, which is what a
 * pre-open frame and a halted stock both look like. The caller shows the numbers and no bar in that case.
 */
export function rangePosition(value: number | null | undefined, low: number | null | undefined,
  high: number | null | undefined): number | null {
  const point = positive(value);
  const floor = typeof low === "number" && Number.isFinite(low) ? low : null;
  const ceiling = typeof high === "number" && Number.isFinite(high) ? high : null;
  if (point === null || floor === null || ceiling === null || ceiling <= floor) return null;
  return Math.min(100, Math.max(0, Math.round(((point - floor) / (ceiling - floor)) * 1000) / 10));
}

export interface Stamp {
  /** The IST clock the figure was read at, or null when the server sent no stamp at all. */
  time: string | null;
  /** Green only for a book the socket is still delivering. */
  live: boolean;
  /** The server's own words for a book that is not full, kept verbatim rather than softened. */
  reason: string | null;
}

/**
 * How current the ladder is.
 *
 * The socket's frame time outranks the REST read's, and `depthMessage` is prod naming which link of the feed is
 * missing - so a partial book explains itself instead of leaving a short ladder to be interpreted.
 */
export function bookStamp(quote: OverviewQuote | null | undefined): Stamp {
  const raw = quote?.depthAt ?? quote?.at ?? null;
  return {
    time: raw ? formatISTTime(raw) : null,
    live: !depthBook(quote).topOfBookOnly,
    reason: quote?.depthMessage ?? null,
  };
}

export interface Provenance {
  /** Short label beside the price: what this number actually is. */
  word: string;
  /** Amber when the figure is not today's live trade. */
  live: boolean;
  /** The session the number belongs to, when the server named one. */
  date: string | null;
}

/**
 * What the price on the header is, in the server's own terms.
 *
 * `quality` is prod's word for the evidence behind a quote and `priceDate` the session it belongs to. A closing
 * snapshot served after the market is labelled as the last close rather than shown as if it were current -
 * the same rule the web desk follows. Named apart from basket-desk's `priceProvenance`, which describes a
 * basket's several leg marks in one sentence rather than one stock's single quote.
 */
export function quoteProvenance(quote: OverviewQuote | null | undefined): Provenance {
  const quality = (quote?.quality ?? "").toLowerCase();
  const date = quote?.priceDate ?? null;
  // A badge describes the figure beside it. With no figure there is nothing to date, so it must not fall
  // through to "Today" - which is what a refused read used to print, in green, over an empty price.
  if (quote?.ltp === null || quote?.ltp === undefined) return { word: "No price", live: false, date };
  const today = date ? isTodayIST(date) : true;
  if (quality === "live" && today) return { word: "Live", live: true, date };
  if (quality === "delayed") return { word: "Delayed", live: false, date };
  if (quality === "stale") return { word: "Last known", live: false, date };
  if (quality === "eod" || quality === "manual" || !today) return { word: "Last close", live: false, date };
  if (quality === "unavailable") return { word: "No price", live: false, date };
  return { word: today ? "Today" : "Last close", live: today, date };
}
