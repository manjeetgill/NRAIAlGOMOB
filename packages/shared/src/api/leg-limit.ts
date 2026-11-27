/**
 * A leg's price box, and the number the trader would have to be holding.
 *
 * The builder already prices every line off the broker's own book - a fresh tick's ask for a buy, its bid
 * for a sell, otherwise the chain's depth - and sends that as the limit. These two functions cover the one
 * thing the book cannot decide: the price the trader actually wants to pay or collect, which is the whole
 * point of a limit order.
 *
 * The shape of an acceptable number comes from prod rather than from taste. `OrderIn.price` is a
 * `Decimal(gt=0, decimal_places=2)`, and drafts copy the app's figure onto the broker's line unchanged, so
 * a typed price must be above zero and two decimals is the most of it that survives the round trip.
 */

/**
 * The number in a leg's price box, or null when it holds none yet.
 *
 * The box keeps the trader's text rather than a parsed number, because a field that rewrote "12." to
 * "12.00" mid-keystroke cannot be typed in. So the parse runs on every read instead, and an empty box, a
 * half-typed one and a nonsense one all answer null.
 */
export function typedLimit(text: string | undefined): number | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed || !/^\d*\.?\d*$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  // Two decimals, because that is the most prod's order model stores and the broker's line is built from it.
  return Math.round(parsed * 100) / 100;
}

/**
 * The price shown inside an empty box - the number that goes out while nothing has been typed.
 *
 * A placeholder rather than a value, so the box can still tell the trader they chose nothing, and so the
 * figure they see is the one the screen would have sent on its own.
 */
export function limitPlaceholder(book: number | null | undefined): string {
  return book === null || book === undefined || !Number.isFinite(book) || book <= 0 ? "" : book.toFixed(2);
}
