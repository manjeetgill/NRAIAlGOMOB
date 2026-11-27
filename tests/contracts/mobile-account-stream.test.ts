import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { queryKeys, rereadAccountOnFrame, throttleReread, applyOrderFrame, orderFrameIntents, orderFrameGtts, watchlistPoll } from "../../packages/shared/src/api/hooks.ts";

const hooks = readFileSync(resolve(__dirname, "../../packages/shared/src/api/hooks.ts"), "utf8");

afterEach(() => vi.useRealTimers());

// 25 Nov 2026 review: the account SSE sends {accounts: {...}, asOf} (raw display snapshot), not the
// /v1/broker-auth/icici/account body, so a frame written into the caches blanked Positions and Orders.
it("treats an account stream frame as a signal to re-read, never as the account body", () => {
  const stream = hooks.slice(hooks.indexOf("const useAccountStream"), hooks.indexOf("const accountPoll"));
  expect(stream).toContain("() => rereadAccountOnFrame(queryClient)");
  expect(stream).not.toContain("setQueryData");
  expect(hooks).not.toMatch(/JSON\.parse\(raw\) as IciciAccountPayload/);
});

/** Which keys a frame re-reads (refetchType active) and which it only marks stale. */
function frameOn(accountShown: boolean) {
  const qc = new QueryClient();
  const off = [new QueryObserver(qc, { queryKey: queryKeys.positions.open(), queryFn: async () => [], enabled: false }).subscribe(() => {})];
  if (accountShown) off.push(new QueryObserver(qc, { queryKey: queryKeys.brokerAccount.icici(), queryFn: async () => ({}), enabled: false }).subscribe(() => {}));
  const spy = vi.spyOn(qc, "invalidateQueries");
  rereadAccountOnFrame(qc);
  off.forEach((f) => f());
  const reads = spy.mock.calls.filter(([f]) => f?.refetchType !== "none").map(([f]) => f?.queryKey);
  const marked = spy.mock.calls.filter(([f]) => f?.refetchType === "none").map(([f]) => f?.queryKey);
  return { reads, marked };
}

it("costs one GET per frame when both screens are open: the account read, which seeds positions", () => {
  expect(frameOn(true)).toEqual({ reads: [queryKeys.brokerAccount.icici()], marked: [queryKeys.positions.open()] });
});

it("re-reads positions alone when no screen is showing the account body", () => {
  expect(frameOn(false)).toEqual({ reads: [queryKeys.positions.open()], marked: [queryKeys.brokerAccount.icici()] });
});

it("repaints a ticket from the order frame instead of re-reading the rows the frame just carried", () => {
  const ticket = hooks.slice(hooks.indexOf("const useOrderSnapshot"), hooks.indexOf("const useEquityQuote"));
  expect(ticket).toContain("i.client_id ?? i.clientId");
  expect(ticket).toContain("queryClient.setQueryData(key, applyOrderFrame(cached, intent))");
  // The frame is the execution row, so the stream is the source: no re-read per frame, and no timer at all
  // while it is delivering. The 60 s poll below the guard is only for a phone that lost the stream.
  expect(ticket).not.toContain("invalidateQueries");
  expect(ticket).toContain("if (orderStreamAlive()) return false;");
  expect(ticket).toContain("return state.data.orders.some(leg => UNSETTLED_LEG_STATES.has(leg.state)) ? ORDER_POLL_MS : false;");
});

/** The ticket body a cold `/v1/orders/{clientId}` read would have left in the cache. */
function cachedTicket() {
  return {
    clientId: "basket-1",
    basketName: "Nifty 24500/25000 straddle",
    status: "dispatching",
    phase: "legging",
    message: "waiting for the exchange",
    cancelRequested: false,
    orders: [
      { index: 0, exchange: "NFO", tradingsymbol: "NIFTY26NOV24500CE", side: "BUY" as const, quantity: 25, price: "120.50", state: "acknowledged", filledQuantity: 0, averagePrice: null, orderId: null, message: null },
      { index: 1, exchange: "NFO", tradingsymbol: "NIFTY26NOV25000PE", side: "SELL" as const, quantity: 25, price: "95.00", state: "queued", filledQuantity: 0, averagePrice: null, orderId: null, message: null },
    ],
  };
}

it("folds a frame onto the legs it names and leaves the ticket's own fields alone", () => {
  const next = applyOrderFrame(cachedTicket(), {
    client_id: "basket-1",
    status: "partially_filled",
    legs: [{ index: 0, state: "partially_filled", filledQuantity: "15", averagePrice: 121.25, brokerOrderId: "771" }],
  });
  // The frame carries execution, not the basket: name, phase and the cancel flag stay as REST read them.
  expect(next.basketName).toBe("Nifty 24500/25000 straddle");
  expect(next.phase).toBe("legging");
  expect(next.cancelRequested).toBe(false);
  expect(next.message).toBe("waiting for the exchange");
  expect(next.status).toBe("partially_filled");
  // ICICI reports quantity as text and price as a number, and the cache holds the opposite; both coerce.
  expect(next.orders[0]).toMatchObject({ state: "partially_filled", filledQuantity: 15, averagePrice: "121.25", orderId: "771" });
  // A leg the frame never names keeps its row rather than being blanked by a partial frame.
  expect(next.orders[1]).toMatchObject({ state: "queued", filledQuantity: 0, orderId: null });
});

it("writes only what a frame actually says, so a missing field cannot clear a known one", () => {
  const next = applyOrderFrame(cachedTicket(), { legs: [{ index: 0, state: "complete" }] });
  expect(next.status).toBe("dispatching");
  expect(next.orders[0]).toMatchObject({ state: "complete", filledQuantity: 0, averagePrice: null, orderId: null });
  expect(applyOrderFrame(cachedTicket(), {}).status).toBe("dispatching");
});

it("reads the two frames' shapes without trusting them", () => {
  expect(orderFrameIntents({ intents: [{ client_id: "a" }], asOf: 1 })).toEqual([{ client_id: "a" }]);
  expect(orderFrameIntents(null)).toEqual([]);
  expect(orderFrameIntents({ gtts: [] })).toEqual([]);
  expect(orderFrameGtts({ gtts: [{ id: 1 }] })).toEqual([{ id: 1 }]);
  expect(orderFrameGtts({ intents: [] })).toBe(null);
});

it("shares one order stream between the ticket, the GTT list and live trades", () => {
  // Three screens following the same execution used to hold three connections; the consumer list is keyed by
  // event name so one socket feeds all of them, and it closes when the last screen lets go.
  const open = hooks.slice(hooks.indexOf("const useOrderStream"), hooks.indexOf("const useOrderStream") + 2000);
  expect(open.match(/subscribeSSEEvents\(/g)).toHaveLength(1);
  expect(open).toContain("orderStreamHandlers.add(dispatch)");
  expect(open).toContain("if (orderStreamUsers === 0 && orderStream)");
  expect((hooks.match(/useOrderStream\(/g) ?? []).length).toBe(3);
});

it("polls a cold watchlist at the quote TTL for three tries, then lets the socket do the work", () => {
  expect(watchlistPoll(true, 1, true)).toBe(5_000);
  expect(watchlistPoll(true, 3, true)).toBe(5_000);
  // The fourth read still pending means the seed is not coming this session: fall back, do not keep seeding.
  expect(watchlistPoll(true, 4, true)).toBe(2 * 60 * 1000);
  expect(watchlistPoll(true, 4, false)).toBe(15_000);
  // Nothing pending: the ordinary cadence, whichever way the price socket is doing.
  expect(watchlistPoll(false, 1, true)).toBe(2 * 60 * 1000);
  expect(watchlistPoll(undefined, 0, false)).toBe(15_000);
});

it("holds a burst of order frames to one read at once and one trailing read per window", () => {
  vi.useFakeTimers();
  let reads = 0;
  const reread = throttleReread(() => { reads += 1; }, 2000);
  reread.request();
  expect(reads).toBe(1);
  for (let i = 0; i < 5; i += 1) { vi.advanceTimersByTime(200); reread.request(); }
  expect(reads).toBe(1);
  vi.advanceTimersByTime(1000);
  expect(reads).toBe(2); // the final state of the burst is still read
  vi.advanceTimersByTime(5000);
  expect(reads).toBe(2);
  reread.request();
  reread.cancel();
  expect(reads).toBe(3);
});
