import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  INTENT_WINDOW, cancelDecision, cancelLegs, gttCancelState, intentForOrder, stoppableLegs,
} from "../../packages/shared/src/api/order-cancel.ts";

const root = resolve(__dirname, "../..");
const screen = readFileSync(resolve(root, "apps/mobile/app/(tabs)/orders.tsx"), "utf8");
const hooks = readFileSync(resolve(root, "packages/shared/src/api/hooks.ts"), "utf8");
const plan = readFileSync(resolve(root, "packages/shared/src/api/order-cancel.ts"), "utf8");
const index = readFileSync(resolve(root, "packages/shared/src/api/index.ts"), "utf8");

/**
 * Cancelling an open order from the phone.
 *
 * The Orders list is ICICI's book keyed by the broker's order id, while prod's cancel route is addressed by
 * this app's instruction reference. The join is the broker id prod already stores on each leg, so a card may
 * offer the press only when that join exists — and must say why it does not when it does not. A fill is never
 * reversed by a cancel, which is the one fact the confirm sheet exists to state before the press.
 */

const leg = (over = {}) => ({
  tradingsymbol: "NIFTY26NOV25600CE", side: "BUY", exchange: "NFO", product: "M", quantity: 130,
  price: "96.5", filledQuantity: 0, averagePrice: null, state: "acknowledged", orderId: "9001", ...over,
});

const instruction = (over = {}) => ({
  clientId: "c-1", provider: "icici", createdAt: "2026-11-26T10:00:00+05:30",
  basketName: "HEDGE-NOV-65", status: "working", orders: [leg()], ...over,
});

const row = (over = {}) => ({
  orderId: "9001", provider: "icici", exchange: "NFO", symbol: "NIFTY26NOV25600CE", side: "BUY",
  product: "M", orderType: "LIMIT", quantity: 130, price: 96.5, filledQuantity: 0, pendingQuantity: 130,
  status: "OPEN", timestamp: "26-Nov-2026 14:52:03", message: null, ...over,
});

describe("A broker row is matched to the instruction that placed it", () => {
  it("joins on the broker order id prod stamped on the leg", () => {
    const intents = [instruction()] as never[];
    expect(intentForOrder(row() as never, intents)?.clientId).toBe("c-1");
    // The same symbol under a different id is a different order: two baskets of NIFTY 25600 CE exist.
    expect(intentForOrder(row({ symbol: "NIFTY26NOV25600CE", orderId: "9002" }) as never, intents)).toBeNull();
  });

  it("finds the instruction behind any leg of a multi-leg basket", () => {
    const intents = [instruction({
      orders: [leg(), leg({ tradingsymbol: "NIFTY26NOV25400PE", side: "SELL", orderId: "9002" })],
    })] as never[];
    expect(intentForOrder(row({ orderId: "9002" }) as never, intents)?.clientId).toBe("c-1");
  });

  it("refuses to guess a row whose broker id is blank", () => {
    // ICICI leaves the id empty in a few pre-acknowledgement states; matching on symbol there would attach
    // a cancel to whichever instruction happened to trade that contract first.
    expect(intentForOrder(row({ orderId: "" }) as never, [instruction()] as never)).toBeNull();
  });
});

describe("The card's action line", () => {
  it("offers the press for a leg this app placed that has not finished", () => {
    const decision = cancelDecision(row() as never, [instruction()] as never);
    expect(decision.kind).toBe("offer");
    expect(decision.legs).toHaveLength(1);
    expect(decision.intent.basketName).toBe("HEDGE-NOV-65");
  });

  it("lists the sibling legs a press stops with the tapped row", () => {
    // The route is addressed by the instruction, so cancelling one card does cancel the basket's other
    // unfilled legs too — and the sheet has to show all of them before the press.
    const intents = [instruction({
      orders: [leg(), leg({ tradingsymbol: "NIFTY26NOV25400PE", orderId: "9002", filledQuantity: 65 })],
    })] as never[];
    const decision = cancelDecision(row() as never, intents);
    expect(decision.kind).toBe("offer");
    expect(decision.legs.map((l: { tradingsymbol: string; unfilled: number }) => [l.tradingsymbol, l.unfilled]))
      .toEqual([["NIFTY26NOV25600CE", 130], ["NIFTY26NOV25400PE", 65]]);
    expect(cancelLegs(decision.intent)).toHaveLength(2);
  });

  it("counts only unfilled quantity as stoppable", () => {
    const intents = [instruction({
      orders: [leg({ filledQuantity: 130, state: "filled" }), leg({ orderId: "9002", state: "rejected" }),
        leg({ orderId: "9003", state: "cancelled" }), leg({ orderId: "9004", state: "skipped" }),
        leg({ orderId: "9005", tradingsymbol: "NIFTY26NOV25400PE", state: "queued", quantity: 65, filledQuantity: 20 })],
    })] as never[];
    // A rejected or skipped leg has no live order to stop; a queued leg with 20 of 65 done still has 45.
    expect(stoppableLegs(intents[0])).toEqual([
      { tradingsymbol: "NIFTY26NOV25400PE", side: "BUY", quantity: 65, unfilled: 45, settled: false },
    ]);
    expect(cancelLegs(intents[0])).toHaveLength(5);
  });

  it("says a cancellation is already on its way instead of offering a dead press", () => {
    // Prod treats a repeat request as a no-op, so a second button would be a control that does nothing.
    const decision = cancelDecision(row() as never, [instruction({ cancelRequested: true })] as never);
    expect(decision.kind).toBe("requested");
  });

  it("reports what already stopped, with the filled half kept", () => {
    // Terminal for the engine is not flat for the trader: a cancelled basket can retain a partial fill.
    const decision = cancelDecision(row({ orderId: "9002" }) as never, [instruction({
      status: "cancelled", orders: [leg({ orderId: "9002", filledQuantity: 65 })],
    })] as never);
    expect(decision).toMatchObject({ kind: "stopped", filled: 65, quantity: 130 });
  });

  it("names a leg that has nothing left to cancel", () => {
    const decision = cancelDecision(row() as never, [instruction({
      orders: [leg({ filledQuantity: 130, state: "filled" }), leg({ orderId: "9002" })],
    })] as never);
    expect(decision.kind).toBe("filled");
  });

  it("keeps the press for an outcome the app cannot see", () => {
    // `unknown` is prod still reconciling, and its cancel route accepts it — the order may well be live.
    expect(cancelDecision(row() as never, [instruction({ status: "unknown" })] as never).kind).toBe("offer");
    expect(cancelDecision(row() as never, [instruction({ status: "queued" })] as never).kind).toBe("offer");
  });

  it("offers nothing where prod refuses, and prints the server's own sentence", () => {
    const parked = cancelDecision(row() as never, [instruction({
      status: "needs_manual", message: "The broker stopped answering for this order. Check it in the terminal.",
    })] as never);
    expect(parked.kind).toBe("manual");
    expect(parked.intent.message).toContain("Check it in the terminal");
    // `blocked` was never sent, so there is nothing at the broker to stop either.
    expect(cancelDecision(row() as never, [instruction({ status: "blocked" })] as never).kind).toBe("stopped");
  });

  it("separates an order the journal does not hold from a journal that never answered", () => {
    expect(cancelDecision(row() as never, [instruction({ orders: [leg({ orderId: "9111" })] })] as never).kind).toBe("outside");
    // "Not placed here" and "not checked" decide whether a cancel exists somewhere, so they cannot share a line.
    expect(cancelDecision(row() as never, null).kind).toBe("unchecked");
  });

  it("admits when the bounded journal window could have missed the order", () => {
    const intents = Array.from({ length: INTENT_WINDOW }, (_, i) => instruction({
      clientId: `c-${i}`, orders: [leg({ orderId: `other-${i}` })],
    })) as never[];
    expect(cancelDecision(row() as never, intents)).toEqual({ kind: "outside", truncated: true });
    expect(cancelDecision(row() as never, [])).toEqual({ kind: "outside", truncated: false });
  });
});

describe("GTT rows follow prod's own state machine", () => {
  it("offers the press for the two states the server acts on", () => {
    expect(gttCancelState({ state: "active" } as never)).toBe("offer");
    expect(gttCancelState({ state: "requested" } as never)).toBe("offer");
  });

  it("waits while the pump works and stays quiet once cancelled", () => {
    expect(gttCancelState({ state: "cancel_requested" } as never)).toBe("waiting");
    expect(gttCancelState({ state: "cancelling" } as never)).toBe("waiting");
    expect(gttCancelState({ state: "cancelled" } as never)).toBe("closed");
  });

  it("refuses the states the server rejects the request in", () => {
    // `placing` and `unknown` are mid-flight at the broker, and `failed` never got there; prod answers all
    // three with its own sentence rather than a second command.
    for (const state of ["placing", "failed", "unknown"]) {
      expect(gttCancelState({ state } as never)).toBe("refused");
    }
  });
});

describe("The cancel command is the server's own route", () => {
  it("posts the empty confirmation the web already sends", () => {
    // The active, MFA-verified session is the authorisation; a code would be an invented requirement.
    expect(hooks).toContain("client.post<OrderSnapshot>(`/v1/orders/${encodeURIComponent(clientId)}/cancel`, {})");
    expect(hooks).toContain("client.post<GttOrder>(`/v1/orders/gtt/${encodeURIComponent(id)}/cancel`, {})");
  });

  it("re-reads the journal and the affected snapshot from inside the mutation", () => {
    // Invalidation lives in mutationFn so a screen's own options cannot spread over it and leave a stale row.
    expect(hooks).toMatch(/useCancelOrder[\s\S]{0,400}queryKeys\.orders\.intents\(\)[\s\S]{0,200}queryKeys\.orders\.snapshot\(clientId\)/);
    expect(hooks).toMatch(/useCancelGtt[\s\S]{0,300}queryKeys\.orders\.gtt\(\)/);
  });

  it("is exposed on the api object the screens destructure", () => {
    expect(hooks).toMatch(/usePlaceOrder,\s*\n\s*useCancelOrder,\s*\n\s*useCancelGtt,/);
    expect(index).toContain('from "./order-cancel"');
  });
});

describe("The Orders screen wires the press", () => {
  it("reads the instruction journal on the same screen as the broker book", () => {
    expect(screen).toContain("useOrderIntents({ limit: INTENT_WINDOW }");
    expect(screen).toContain("subscribed: focused");
    // The journal is a database read, so resolving rows must not be billed as a broker call.
    expect(plan).toContain("export const INTENT_WINDOW = 200");
  });

  it("gates the action on the row ICICI still calls open", () => {
    expect(screen).toContain('if (normalizeStatus(order.status) !== "OPEN") return null;');
    expect(screen).toContain("cancelDecision(order, journal)");
  });

  it("names every leg before the press and counts what it stops", () => {
    expect(screen).toContain("Cancel the unfilled legs of ${orderSheet.basket}?");
    expect(screen).toContain("Legs already filled are not reversed — they stay in your positions.");
    expect(screen).toContain("Cancel ${orderSheet.stopping.length} unfilled leg${orderSheet.stopping.length === 1 ? \"\" : \"s\"}");
    expect(screen).toContain("orderSheet.legs.map");
  });

  it("keeps the sheet closed until a press and sends nothing on open", () => {
    expect(screen).toContain("<Modal visible={sheet !== null}");
    expect(screen).toContain("onPress={closeSheet}");
    expect(screen).toContain("onPress={sendCancel}");
    expect(screen).toContain("if (!sheet || cancelling) return;");
  });

  it("prints prod's refusal instead of a generic failure and keeps the row", () => {
    expect(screen).toContain("Cancellation was not confirmed. Orders may still be active. Check the broker order book before trying again.");
    expect(screen).toMatch(/onError: \(error\) => setCancelError\(error\.message \|\| cancelFallback\)/);
    // A failure leaves the sheet open so the reason is readable, and the list untouched so it can be retried.
    expect(screen).toMatch(/useCancelOrder\(\{[\s\S]{0,400}setSheet\(null\)[\s\S]{0,200}onError/);
  });

  it("marks the row as asked only once the server has journalled it", () => {
    expect(screen).toContain("setAsked(prev => ({ ...prev, [snapshot.clientId]: true }))");
    expect(screen).toContain("if (asked[intent.clientId]) return");
    expect(screen).toContain('\'The order stays on this screen as "cancel requested" until ICICI confirms it.');
  });

  it("gives the GTT tab its own press and its own refusal line", () => {
    expect(screen).toContain("gttCancelState(gtt)");
    expect(screen).toContain("Cancel GTT");
    expect(screen).toContain("{GTT_REFUSED_REASON}");
    expect(screen).toContain("An order the GTT already triggered stays in your book.");
  });

  it("states once where a cancel can come from", () => {
    expect(screen).toContain("An order placed in ICICI is cancelled in ICICI.");
    expect(screen).toContain("Not placed in this app — cancel it in ICICI.");
  });

  it("re-creates the row renderer when the journal lands", () => {
    // The action line closes over the journal read. A renderer memoised on styles alone would keep the first
    // render's closure, in which nothing has loaded, and freeze every card on "not checked".
    expect(screen).toContain("useCallback(({ item }: { item: BrokerOrder }) => renderOrderCard(item), [styles, colors, journal, asked])");
  });

  it("leaves modify out until the server has a durable amendment workflow", () => {
    // The broker adapter raises UNSUPPORTED_OPERATION for modify, so a phone-only press would be a dead
    // control. It ships with its own branch, after execution_amend exists.
    expect(screen).not.toContain("Change price");
    expect(plan).not.toMatch(/amend|modify/i);
  });

  it("keeps the screen read-only until a press", () => {
    // No route other than the two cancel commands is called from this screen.
    expect(screen).not.toMatch(/client\.post|api\.place|usePlaceOrder/);
    expect(screen.match(/\.mutate\(/g)).toHaveLength(2);
  });
});
