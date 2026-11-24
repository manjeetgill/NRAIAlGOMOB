/**
 * Chain ticks - what the ladder paints between prod's chain reads.
 *
 * /v1/option-chain prices a whole expiry in one read, and that read costs the broker seconds, so the
 * premiums on screen are only as fresh as the last one. The quotes stream the app already holds publishes a
 * price for any canonical instrument id the broker master resolves, and every chain row names its own id
 * (`OptionQuote.instrumentId`), so a screen can subscribe to the strikes it is showing and paint their
 * premiums from ticks instead of waiting for the next ladder.
 *
 * Only the visible band is ever asked for. Every message to the stream replaces the connection's whole
 * subscription set, and prod resolves each new option against the broker master before it streams it, so a
 * ladder that re-subscribed on each pixel of scroll would spend the same broker lane that places the
 * trader's orders. The band therefore moves only when a visible strike falls outside it.
 */

import type { OptionQuote, OptionRow } from "./hooks";
import type { QuoteTick } from "./websocket";

/** The sides of these strikes that prod actually quoted, in ladder order. */
function sides(rows: readonly OptionRow[]): OptionQuote[] {
  const listed: OptionQuote[] = [];
  for (const row of rows) {
    if (row.call) listed.push(row.call);
    if (row.put) listed.push(row.put);
  }
  return listed;
}

/** The ids to put on the stream for these strikes - real canonical identities only, never a label. */
export function strikeIds(rows: readonly OptionRow[]): string[] {
  return [...new Set(
    sides(rows)
      .map(side => side.instrumentId)
      .filter((id): id is string => typeof id === "string" && id.startsWith("instrument:v1:")),
  )];
}

/** The lines currently subscribed, as an inclusive index range over the rendered list. */
export interface Band {
  from: number;
  to: number;
}

/**
 * The band to hold for the lines the trader is looking at, padded so a small scroll costs nothing.
 *
 * `current` is kept whole whenever it still covers every visible line, which is what stops a scroll inside
 * the band from becoming a new subscription. When it no longer covers them the band moves to the visible
 * lines and their padding rather than growing: a set that only ever grows keeps pricing strikes the trader
 * scrolled away from.
 */
export function watchBand(
  viewable: readonly number[],
  total: number,
  current: Band | null,
  pad: number,
): Band | null {
  if (!viewable.length || total <= 0) return current;
  if (current && viewable.every(index => index >= current.from && index <= current.to)) return current;
  const from = Math.max(0, Math.min(...viewable) - pad);
  return { from, to: Math.min(total - 1, Math.max(...viewable) + pad) };
}

/**
 * The stream's prices for the subscribed ids, keyed by instrument, or `previous` itself when nothing moved.
 *
 * Returning the old map is the point: the screen keeps its own state object, so a frame that repeats prices
 * it has already painted does not redraw the ladder. The stream's snapshot is cumulative, so a strike that
 * went quiet keeps its last price here exactly as it keeps one on the server's book.
 */
export function tickByInstrument(
  quotes: readonly QuoteTick[],
  previous: Map<string, QuoteTick>,
): Map<string, QuoteTick> {
  const next = new Map(quotes.map(tick => [tick.id, tick]));
  const same =
    next.size === previous.size &&
    [...next].every(([id, tick]) => {
      const old = previous.get(id);
      return !!old && old.price === tick.price && old.at === tick.at && old.status === tick.status;
    });
  return same ? previous : next;
}

/** The server's own labels for a price that is not a live trade, in the words the chain already uses. */
const TICK_WORD: Record<string, string> = {
  DELAYED: "delayed price",
  STALE: "old price",
  FALLBACK: "price from a second source",
  MARKET_CLOSED: "last price",
};

/**
 * Why this ticked price is not a live price, or null when the stream calls it one.
 *
 * A number that moves is not automatically current: the stream also publishes stale and fallback bindings,
 * and the ladder has to say which of those it is showing rather than leave a live-looking premium beside an
 * IV that came from the last chain read.
 */
export function tickWord(tick: QuoteTick): string | null {
  const status = String(tick.status ?? "").toUpperCase();
  if (status === "LIVE") return null;
  if (!status) return tick.fresh ? null : "old price";
  return TICK_WORD[status] ?? (tick.fresh ? null : "old price");
}

/** One side of one strike, as the screen should paint it. */
export interface LiveSide {
  price: number;
  /** Why the stream's price is not a live trade; null for a live tick and for the chain read's own number. */
  word: string | null;
  /** True when this number came off the stream rather than out of the last chain read. */
  ticked: boolean;
}

/** The time the chain read stamped this price with, or null when it stamped nothing. */
function readAt(side: OptionQuote): string | null | undefined {
  return side.ltpAt ?? side.quote?.at;
}

/**
 * Whether a stream price may replace a price the screen already holds.
 *
 * A strike the exchange has gone quiet on keeps its last tick for as long as the socket lives, while the
 * chain underneath it is re-read every few seconds: painting the older of the two is how a number from
 * minutes ago starts looking live. A tick with no exchange time on it stands on the server's own freshness
 * flag instead, and a number with no stamp at all is not a reason to keep an older one.
 */
export function tickBeats(tick: QuoteTick | undefined, stamp: string | null | undefined): boolean {
  if (!tick || !(tick.price > 0)) return false;
  const at = Date.parse(String(stamp ?? ""));
  if (!Number.isFinite(at)) return true;
  return tick.at === null ? tick.fresh : tick.at >= at;
}

/**
 * The number to paint for one side of a strike, and where it came from.
 */
export function liveSide(side: OptionQuote | null, tick: QuoteTick | undefined): LiveSide | null {
  if (tick && tickBeats(tick, side ? readAt(side) : null)) {
    return { price: tick.price, word: tickWord(tick), ticked: true };
  }
  const listed = side ? Number(side.ltp) : Number.NaN;
  return Number.isFinite(listed) && listed > 0 ? { price: listed, word: null, ticked: false } : null;
}
