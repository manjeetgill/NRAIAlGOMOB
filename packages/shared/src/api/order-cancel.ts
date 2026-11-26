/**
 * Which order on the phone's Orders tab the app may honestly offer to cancel.
 *
 * The list shows ICICI's book, keyed by the broker's order id, while the server cancels by this app's own
 * instruction reference. The link already travels in the payload: every leg of a journaled instruction
 * carries the broker id the exchange stamped on it. So a row is only cancellable when the journal recognises
 * that id, and what gets cancelled is the whole instruction's unfilled half — the fills stay, which is why
 * the confirm sheet names every leg rather than only the one that was tapped.
 *
 * Nothing here decides by status word alone. A state the app cannot map to a route prod actually answers
 * with produces a reason instead of a button, so the screen never offers a control the server would refuse.
 */

import type { BrokerOrder, GttOrder, OrderIntent } from "./hooks";

/**
 * Statuses where prod still has work it can stop. `needs_manual` is absent on purpose: the worker already
 * gave up on that instruction and `repository.cancel` refuses a request for it, so the phone must not offer
 * the press. `blocked` and every terminal status are absent for the same reason.
 */
const STOPPABLE = new Set(["queued", "working", "unknown"]);

/** Leg states prod has confirmed as finished — of that leg there is nothing left to cancel. */
const SETTLED = new Set(["filled", "rejected", "cancelled", "skipped"]);

/** One leg of a journaled instruction, in the units the confirm sheet prints. */
export interface CancelLeg {
  tradingsymbol: string;
  side: string;
  quantity: number;
  unfilled: number;
  settled: boolean;
}

/** How many instructions the phone reads to resolve a broker row. The server clamps the range at 2,000. */
export const INTENT_WINDOW = 200;

const legOf = (leg: OrderIntent["orders"][number]): CancelLeg => {
  const quantity = Number(leg.quantity) || 0;
  const filled = Number(leg.filledQuantity) || 0;
  const settled = SETTLED.has(String(leg.state ?? "").trim().toLowerCase());
  return {
    tradingsymbol: String(leg.tradingsymbol ?? leg.symbol ?? "leg"),
    side: String(leg.side ?? ""),
    quantity,
    unfilled: Math.max(quantity - filled, 0),
    settled,
  };
};

/** Every leg of the instruction, filled ones included: the sheet has to say what a press leaves alone. */
export function cancelLegs(intent: OrderIntent): CancelLeg[] {
  return (intent.orders ?? []).map(legOf);
}

/** The legs a cancellation would actually stop, which is what the destructive press is named after. */
export function stoppableLegs(intent: OrderIntent): CancelLeg[] {
  return cancelLegs(intent).filter(leg => !leg.settled && leg.unfilled > 0);
}

/**
 * The instruction this broker row belongs to, found by the broker id on one of its legs.
 *
 * An instruction can hold several rows of the same contract, and two instructions can name the same
 * symbol, so only the id the exchange stamped is a match. A row with no id — ICICI returns one for a
 * few pre-acknowledgement states — resolves to nothing rather than to a symbol guess.
 */
export function intentForOrder(order: BrokerOrder, intents: readonly OrderIntent[]): OrderIntent | null {
  const id = String(order.orderId ?? "").trim();
  if (!id) return null;
  for (const intent of intents) {
    if ((intent.orders ?? []).some(leg => String(leg.orderId ?? "").trim() === id)) return intent;
  }
  return null;
}

export type CancelDecision =
  /** Journaled, still running, nothing asked yet: the press is live. */
  | { kind: "offer"; intent: OrderIntent; legs: CancelLeg[] }
  /** A cancellation is already authorized and prod is working through it; a second press is a no-op. */
  | { kind: "requested"; intent: OrderIntent; legs: CancelLeg[] }
  /** The journal no longer treats the instruction as running, so the unfilled half has already stopped. */
  | { kind: "stopped"; intent: OrderIntent; filled: number; quantity: number }
  /** Prod parked this one for a person and wrote its own reason on the row. */
  | { kind: "manual"; intent: OrderIntent }
  /** This row's own leg has nothing left, whatever the rest of the basket is doing. */
  | { kind: "filled"; intent: OrderIntent }
  /** ICICI's book carries the order and the app's journal does not. */
  | { kind: "outside"; truncated: boolean }
  /** The journal read has not answered, so the app cannot claim anything about the row. */
  | { kind: "unchecked" };

/**
 * The action line for one broker row, or the reason there is none.
 *
 * `intents` is null while the read is loading or has failed, which buys a "not checked" line rather than a
 * claim that the order was placed elsewhere. The button is gated on the row's own leg - a leg that has
 * finished has nothing left to stop - while the confirm sheet lists the whole instruction, because prod acts
 * on the instruction reference and the sibling legs stop with it.
 */
export function cancelDecision(
  order: BrokerOrder,
  intents: readonly OrderIntent[] | null,
): CancelDecision {
  if (intents === null) return { kind: "unchecked" };
  const id = String(order.orderId ?? "").trim();
  const intent = intentForOrder(order, intents);
  if (!intent) return { kind: "outside", truncated: intents.length >= INTENT_WINDOW };
  if (intent.status === "needs_manual") return { kind: "manual", intent };
  const own = (intent.orders ?? []).find(leg => String(leg.orderId ?? "").trim() === id);
  const leg = own ? legOf(own) : null;
  // A status the engine no longer treats as running means the unfilled half has already stopped with the
  // filled half kept - the fact the row must report instead of an offered button.
  if (!STOPPABLE.has(intent.status)) {
    return {
      kind: "stopped",
      intent,
      filled: Number(own?.filledQuantity) || 0,
      quantity: Number(own?.quantity ?? order.quantity) || 0,
    };
  }
  if (!leg || leg.settled || leg.unfilled === 0) return { kind: "filled", intent };
  if (intent.cancelRequested) return { kind: "requested", intent, legs: stoppableLegs(intent) };
  return { kind: "offer", intent, legs: stoppableLegs(intent) };
}

/** Prod's own refusal for a GTT its journal no longer controls, kept verbatim on the row. */
export const GTT_REFUSED_REASON = "This GTT is not active in the app. Check the broker's GTT list.";

/**
 * Whether the app may ask prod to take back one of its GTTs.
 *
 * `requested` is cancelled in prod's own journal before it was ever sent; `active` queues the delete the
 * pump then confirms. Anything else is a state prod refuses with GTT_REFUSED_REASON, and `cancelled` needs
 * no control at all.
 */
export function gttCancelState(gtt: GttOrder): "offer" | "waiting" | "closed" | "refused" {
  if (gtt.state === "requested" || gtt.state === "active") return "offer";
  if (gtt.state === "cancel_requested" || gtt.state === "cancelling") return "waiting";
  if (gtt.state === "cancelled") return "closed";
  return "refused";
}
