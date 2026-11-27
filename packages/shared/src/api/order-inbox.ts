/**
 * The order inbox, as the phone reads it.
 *
 * Prod projects every committed order event into `order_notifications` on its own five-second pass
 * (`services/order_notifications.py`) and serves it at `GET /v1/alerts/orders` for the signed-in owner. The
 * same rows already drive the web desk and the WhatsApp messages, so the words on the phone are the server's:
 * this module reads them and never writes a sentence of its own.
 *
 * Two rules here come from the owner rather than from the route. The phone is a live-trading app, so every
 * paper row is dropped here even though the server still lists them for a workspace that has paper alerts
 * switched on. And nothing calls `POST /v1/alerts/orders/clear`: that route clears every row of the inbox,
 * the paper ones included, which is a change to a list this app has decided not to show.
 */

/** One projected order event. Only the fields the phone renders are typed; prod sends more. */
export interface OrderNotice {
  id: number;
  /** "live" or "paper", from the mode of the trade that made the row. */
  mode: string;
  /** "placed" | "executed" | "leg_filled" | "failed" | "attention" in today's projector. */
  event_kind: string;
  payload?: { title?: string | null; summary?: string | null } | null;
  occurred_at: string;
  read_at?: string | null;
}

/** The body of `GET /v1/alerts/orders`. */
export interface OrderInboxBody {
  notifications?: OrderNotice[] | null;
  /** Server-side unread count over every mode it chose to list, so the phone cannot use it as a badge. */
  unread?: number | null;
}

/** What one event_kind means, worded. Only reached when a row arrives with no title of its own. */
const KIND_WORDS: Record<string, string> = {
  placed: "Order placed",
  executed: "Order executed",
  leg_filled: "Basket leg executed",
  failed: "Order failed",
  attention: "Order needs attention",
};

/** The live rows only, in the order the server sent them (unread first, then newest). */
export function liveNotices(body: OrderInboxBody | undefined | null): OrderNotice[] {
  const rows = body?.notifications;
  if (!Array.isArray(rows)) return [];
  return rows.filter(row => row && row.mode === "live");
}

/** The unread ones among them - the number the Orders tab badge carries. */
export function unreadNotices(rows: readonly OrderNotice[]): OrderNotice[] {
  return rows.filter(row => !row.read_at);
}

/**
 * The line a notice is titled with.
 *
 * The server's own title wins. A row without one falls back to the event kind rather than to a blank, because
 * an empty headline on a fill notice tells the trader nothing about what happened.
 */
export function noticeTitle(row: OrderNotice): string {
  const title = String(row.payload?.title ?? "").trim();
  return title || KIND_WORDS[row.event_kind] || "Order notice";
}

/** The detail line, or an empty string when prod sent none. Callers hide the line rather than fill it in. */
export function noticeSummary(row: OrderNotice): string {
  return String(row.payload?.summary ?? "").trim();
}

/**
 * Which rows this phone has not announced yet.
 *
 * The first read after launch announces nothing on purpose: the inbox keeps history, and a banner for every
 * fill since yesterday would bury the one that just happened. Later reads show rows whose id the app has not
 * put on screen, newest first.
 */
export function unshownNotices(
  rows: readonly OrderNotice[],
  shown: readonly number[],
  firstRead: boolean,
): OrderNotice[] {
  if (firstRead) return [];
  const known = new Set(shown);
  return rows.filter(row => !known.has(row.id)).sort((a, b) => b.id - a.id);
}
