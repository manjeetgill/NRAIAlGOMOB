/**
 * Marking the owner's book and watchlists with prod's tick stream.
 *
 * The stream speaks canonical contract identities (brokers/shared/instrument_registry.py `contract()`), and a
 * broker row only carries them in pieces: `stock_code` is ICICI's own contract token, which is neither that
 * identity nor guessable from it (RELIND is RELIANCE, NIFTY is also the prefix of NIFTYNEXT50). So a cash row
 * builds its own id from the exchange and code the broker sent, and a derivative asks prod's derivatives master
 * for the underlying behind its code first. An id that cannot be built completely is never sent: the server
 * closes the whole socket on a subscription it cannot parse, so one malformed leg would stop every other row
 * on the screen from ticking.
 *
 * A price only marks a row when the server published it as fresh, positive and stamped by the exchange - the
 * same three conditions the chart applies to a candle.
 */

import { tickBarInput } from "./live-candles";
import type { QuoteTick } from "./websocket";

/** The parts of a broker row that decide its canonical identity. */
export interface RowIdentity {
  exchange: string;
  symbol: string;
  product: string;
  expiry: string | null;
  strike: string | number | null;
  right: string | null;
}

const VENUES: Record<string, string> = { NFO: "NSE", BFO: "BSE", CDS: "NSE", BCD: "BSE" };
const RIGHTS: Record<string, string> = { CALL: "CE", PUT: "PE", CE: "CE", PE: "PE" };

const enc = (value: string) => encodeURIComponent(value);

/**
 * Whether a row names a contract rather than a share.
 *
 * Prod's own key builder (core/quote_ids.py `icici_key`) only accepts CASH, FUTURES or OPTIONS, but a broker
 * also labels an equity position by its margin product. A row with no expiry, strike or right cannot be a
 * contract, so it is priced as the equity it is; a row with any of them is only ever priced as a contract.
 */
function isDerivative(row: RowIdentity): boolean {
  const product = (row.product ?? "").trim().toUpperCase();
  if (["FUTURES", "FUT", "OPTIONS", "OPT"].includes(product)) return true;
  return !!(row.expiry || row.strike || row.right);
}

/** `expiry_date()` in the registry: any of the broker's date shapes, normalised to an ISO day. */
function isoDay(value: string | null): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) return text;
  match = /^(\d{2})(\d{2})(\d{2})$/.exec(text);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(text) ?? /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4})$/.exec(text);
  if (!match) return null;
  const month = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
    .indexOf(match[2].toUpperCase()) + 1;
  if (month === 0) return null;
  return `${match[3]}-${String(month).padStart(2, "0")}-${String(Number(match[1])).padStart(2, "0")}`;
}

/** `Decimal.normalize()` then plain text: 25000.00 becomes "25000", 31.5 stays "31.5". */
function plainStrike(value: string | number | null): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const number = Number(text);
  if (!Number.isFinite(number) || number <= 0) return null;
  try {
    return String(Number(number.toFixed(10)));
  } catch {
    return null;
  }
}

/**
 * The canonical id the stream subscribes by, or null when the row does not carry a complete identity.
 * `underlying` is the exchange-facing name from prod's derivatives master; a cash row never needs it.
 */
export function streamIdFor(row: RowIdentity, underlying?: string | null): string | null {
  const exchange = (row.exchange ?? "").trim().toUpperCase();
  const venue = VENUES[exchange] ?? exchange;
  if (!["NSE", "BSE", "MCX"].includes(venue)) return null;
  const product = (row.product ?? "").trim().toUpperCase();

  if (!isDerivative(row)) {
    const symbol = (row.symbol ?? "").trim().toUpperCase();
    if (!symbol) return null;
    return `instrument:v1:${venue}:EQ:${enc(symbol)}:CASH`;
  }

  const symbol = (underlying ?? "").trim().toUpperCase();
  const expiry = isoDay(row.expiry);
  if (!symbol || !expiry) return null;
  if (product === "FUTURES" || product === "FUT") {
    return `instrument:v1:${venue}:FO:${enc(symbol)}:FUT:${enc(expiry)}`;
  }
  if (product !== "OPTIONS" && product !== "OPT") return null;
  const strike = plainStrike(row.strike);
  const right = RIGHTS[(row.right ?? "").trim().toUpperCase()];
  if (!strike || !right) return null;
  return `instrument:v1:${venue}:FO:${enc(symbol)}:OPT:${enc(expiry)}:${enc(strike)}:${right}`;
}

/**
 * One option's stream id through the same normalisers as streamIdFor (strike via Decimal.normalize,
 * expiry to an ISO day). The server closes the whole socket (1008) on an id that does not round-trip,
 * so a hand-built id with "11000.50" or "25000.00" took every screen's prices down.
 */
export function optionStreamId(venue: string, underlying: string, expiry: string | null, strike: string | number | null,
                               right: string | null): string | null {
  return streamIdFor({ exchange: venue, symbol: underlying, product: "OPT", expiry, strike, right }, underlying);
}

/** The broker contract codes a book holds that only prod's master can name. */
export function derivativeCodes(rows: readonly RowIdentity[]): string[] {
  return [...new Set(
    rows
      .filter(isDerivative)
      .map((row) => (row.symbol ?? "").trim().toUpperCase())
      .filter((code) => code.length > 0 && code.length <= 20 && /^[A-Z0-9&_-]+$/.test(code)),
  )].slice(0, 200);
}

/** The price a tick is allowed to report, or null when the server did not publish it as usable. */
function usable(tick: QuoteTick | undefined): number | null {
  const hit = tickBarInput(tick);
  return hit ? hit.price : null;
}

function byId(quotes: readonly QuoteTick[]): Map<string, QuoteTick> {
  const map = new Map<string, QuoteTick>();
  for (const quote of quotes) {
    if (quote.id) map.set(quote.id, quote);
    if (quote.subscriptionId) map.set(quote.subscriptionId, quote);
  }
  return map;
}

export interface Marked {
  /** True when the price on this row came from the stream rather than from the broker's saved snapshot. */
  live: boolean;
}

/**
 * The P&L one price implies against another, signed by the side the broker reported.
 *
 * Prod marks a position the same way - `services/account_valuation.py` `mark_icici_position`, and the web desk's
 * `calculateDailyMtm` - because the broker reports no P&L on most position rows: all 29 rows of the live book on
 * 2026-11-26 arrived with `marked_pnl_paise` absent. Either price missing or zero leaves the row unmarked rather
 * than guessed, and a side the broker did not call a buy or a sell has no direction to sign it with.
 */
function pnlBetween(row: { side: string; quantity: number }, from: number | null | undefined, to: number | null): number | null {
  const direction = row.side === "BUY" ? 1 : row.side === "SELL" ? -1 : null;
  if (direction === null || typeof from !== "number" || from <= 0 || typeof to !== "number" || to <= 0) return null;
  return Math.round((to - from) * row.quantity * direction * 100) / 100;
}

/** A position row with both figures the book is read for. */
export interface MarkedPosition extends Marked {
  /**
   * The move from the session's previous close to the price on screen.
   *
   * This endpoint lists no intraday quantity, so unlike the web desk a mobile row cannot be split into the part
   * opened today at its own average and the part that predates the session. Every day figure here is the whole
   * position measured from the previous close, so a contract bought today reads as if it had been held since
   * yesterday.
   */
  todayPnl: number | null;
}

/**
 * Positions with the stream's prices marked in.
 *
 * A row that has not ticked keeps the broker's own mark and is still drawn as not live, but it is no longer left
 * without a figure: the screen's totals add only rows that carry one, so a blank dropped that position from the
 * account's own total.
 */
export function markPositions<T extends RowIdentity & { side: string; quantity: number; entryPrice: number | null; markPrice: number | null; unrealizedPnl: number | null; previousClose?: number | null }>(
  rows: readonly T[],
  quotes: readonly QuoteTick[],
  underlyings: Readonly<Record<string, string>> = {},
): (T & MarkedPosition)[] {
  const ticks = byId(quotes);
  return rows.map((row) => {
    const id = streamIdFor(row, underlyings[row.symbol.trim().toUpperCase()] ?? null);
    const hit = id ? ticks.get(id) : undefined;
    const price = id ? usable(hit) : null;
    if (price === null) {
      return {
        ...row,
        live: false,
        unrealizedPnl: row.unrealizedPnl ?? pnlBetween(row, row.entryPrice, row.markPrice),
        todayPnl: pnlBetween(row, row.previousClose, row.markPrice),
      };
    }
    return {
      ...row,
      markPrice: price,
      unrealizedPnl: pnlBetween(row, row.entryPrice, price) ?? row.unrealizedPnl,
      todayPnl: pnlBetween(row, hit?.previousClose ?? row.previousClose, price),
      live: true,
    };
  });
}

/**
 * Holdings with the stream's prices marked in.
 *
 * Only the figures a current price genuinely re-derives move: the price itself, market value and the gap to the
 * broker's own average. Today's change and the day's percentage stay as the broker reported them, because the
 * stream carries no previous close here and inventing one would print a daily move the exchange never priced.
 */
export function markHoldings<T extends { symbol: string; exchange: string; quantity: number; averagePrice: number | null; currentPrice: number | null; marketValue: number | null; unrealizedPnl: number | null }>(
  rows: readonly T[],
  quotes: readonly QuoteTick[],
): (T & Marked)[] {
  const ticks = byId(quotes);
  return rows.map((row) => {
    const id = streamIdFor({ exchange: row.exchange, symbol: row.symbol, product: "CASH", expiry: null, strike: null, right: null });
    const price = id ? usable(ticks.get(id)) : null;
    if (price === null) return { ...row, live: false };
    return {
      ...row,
      currentPrice: price,
      marketValue: price * row.quantity,
      unrealizedPnl: typeof row.averagePrice === "number" ? (price - row.averagePrice) * row.quantity : row.unrealizedPnl,
      live: true,
    };
  });
}

/**
 * Watchlist rows with the stream's prices marked in.
 *
 * The day's figures are measured against a previous close the server named, never one this app inferred: the
 * tick's own closing print first, since that is the exchange's figure for the session the tick was stamped in,
 * then the close the list was read with. Prod computes the pair the same way - `change` is `ltp - close`
 * rounded to two paise (services/watchlist.py `quote_rows`) - so a ticked row carries the same arithmetic as
 * the read it replaced. A row with neither keeps the figures it came with rather than printing a move
 * measured against nothing.
 */
export function markWatchlist<T extends { exchange: string; symbol: string; ltp: number | null; close: number | null; change: number | null; changePct: number | null }>(
  rows: readonly T[],
  quotes: readonly QuoteTick[],
): (T & Marked)[] {
  const ticks = byId(quotes);
  return rows.map((row) => {
    const id = streamIdFor({ exchange: row.exchange, symbol: row.symbol, product: "CASH", expiry: null, strike: null, right: null });
    const hit = id ? ticks.get(id) : undefined;
    const price = hit ? usable(hit) : null;
    if (price === null) return { ...row, live: false };
    const previous = hit?.previousClose ?? row.close;
    if (typeof previous !== "number" || !Number.isFinite(previous) || previous <= 0) return { ...row, ltp: price, live: true };
    const change = Math.round((price - previous) * 100) / 100;
    return { ...row, ltp: price, close: previous, change, changePct: Math.round((change / previous) * 10000) / 100, live: true };
  });
}
