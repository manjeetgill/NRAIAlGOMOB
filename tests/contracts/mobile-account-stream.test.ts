import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryObserver, environmentManager } from "@tanstack/react-query";
import { queryKeys, rereadAccountOnFrame, throttleReread, applyOrderFrame, orderFrameIntents, orderFrameGtts, watchlistPoll, subscribeOrderStream, orderStreamCarries } from "../../packages/shared/src/api/hooks.ts";

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
  // The frame is the execution row, so the legs repaint from it and nothing is re-read per frame. The minute
  // timer underneath stays a real read, because the ticket also carries the basket's phase and its cancel
  // flag, which no frame names.
  expect(ticket).not.toContain("invalidateQueries");
  expect(ticket).toContain("queryFn: () => client.get<OrderSnapshot>(`/v1/orders/${clientId}`)");
  expect(ticket).not.toContain("orderStreamCarries");
  expect(ticket).toContain("return state.data.orders.some(leg => UNSETTLED_LEG_STATES.has(leg.state)) ? ORDER_POLL_MS : false;");
});

it("lets a ticket read the fields no frame names, and lets only the GTT list skip one", () => {
  // Skipping a read because frames arrive is right when the frame carries the whole row set and wrong when
  // it carries part of it. `gtt` sends the same rows GET /v1/orders/gtt returns; `order` sends the execution
  // rows only, so a ticket that skipped would never move its phase past "checking" and would hide a cancel
  // requested from another device until it was reopened.
  const ticket = hooks.slice(hooks.indexOf("const useOrderSnapshot"), hooks.indexOf("const useEquityQuote"));
  const gtt = hooks.slice(hooks.indexOf("const useGttOrders ="), hooks.indexOf("const useOrderInbox ="));
  expect(ticket).not.toContain("orderStreamCarries");
  expect(gtt).toContain('orderStreamCarries("gtt")');
  // Both keep their timer rather than answering false, which a stream that dies cannot restart.
  expect(ticket).toContain("ORDER_POLL_MS");
  expect(gtt).toContain("refetchInterval: ORDER_POLL_MS,");
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
  // Three screens following the same execution used to hold three connections; one is opened for all of them
  // and closes when the last screen lets go.
  const open = hooks.slice(hooks.indexOf("export function subscribeOrderStream"), hooks.indexOf("export function subscribeOrderStream") + 1800);
  expect(open.match(/subscribeSSEEvents\(/g)).toHaveLength(1);
  expect(open).toContain("orderStreamHandlers.add(onEvent)");
  expect(open).toContain("if (orderStreamUsers === 0 && orderStream)");
  expect((hooks.match(/^\s+useOrderStream\(/gm) ?? []).length).toBe(3);
});

/** The piece of `XMLHttpRequest` the SSE client touches, so a test can say what the server sent. */
class FakeStream {
  responseText = "";
  onprogress: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  open() {}
  setRequestHeader() {}
  withCredentials = false;
  abort() { this.onprogress = null; }
  send() {}
  /** One SSE frame, exactly as the wire delivers it. */
  push(frame: string) {
    this.responseText += frame;
    this.onprogress?.();
  }
}

let streams: FakeStream[] = [];
function fakeStreams() {
  streams = [];
  globalThis.XMLHttpRequest = class extends FakeStream {
    constructor() { super(); streams.push(this); }
  } as unknown as typeof XMLHttpRequest;
}
afterEach(() => { delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest; });

it("does not mistake a live connection for a stream that carries the event it waits for", () => {
  // The bug this guards: `alive` is true the moment any byte arrives, and prod keeps a connection open with
  // keepalives. A server that has no GTT frames yet (every build before PR 461) therefore looked like a
  // source, the screen switched its timer off, and a trigger that fired only reached the phone on a pull.
  fakeStreams();
  const seen: string[] = [];
  const detach = subscribeOrderStream((event) => { seen.push(event); });
  expect(streams).toHaveLength(1);
  streams[0].push(": keepalive\n\n");
  expect(orderStreamCarries("gtt")).toBe(false);
  expect(seen).toEqual([]);
  streams[0].push('event: gtt\ndata: {"gtts":[],"asOf":1}\n\n');
  expect(orderStreamCarries("gtt")).toBe(true);
  // Carrying one event is not carrying the other; the ticket keeps its own read until `order` arrives.
  expect(orderStreamCarries("order")).toBe(false);
  detach();
});

it("forgets what a connection carried the moment it is replaced", () => {
  // A reconnect is a fresh stream: the frames it has sent say nothing about the one that died, so a consumer
  // that had stopped reading has to be able to notice it is behind again.
  fakeStreams();
  const first = subscribeOrderStream(() => {});
  streams[0].push('event: order\ndata: {"intents":[]}\n\n');
  expect(orderStreamCarries("order")).toBe(true);
  first();
  const second = subscribeOrderStream(() => {});
  expect(streams).toHaveLength(2);
  expect(orderStreamCarries("order")).toBe(false);
  second();
});

it("cannot revive a timer it once switched off, which is why the fallback skips the read instead", async () => {
  // TanStack reads `refetchInterval` when its timer is (re)armed, which happens after a settled fetch. An
  // interval that answered false is therefore never asked again until the data changes — and a stream that
  // dies for good changes nothing. So the ticket and the GTT list keep a 60 s timer and skip only the read.
  environmentManager.setIsServer(() => false);
  vi.useFakeTimers();
  const qc = new QueryClient();
  let streamUp = true;

  let offReads = 0;
  const off = new QueryObserver(qc, {
    queryKey: ["interval-off"],
    queryFn: async () => { offReads += 1; return offReads; },
    refetchInterval: () => (streamUp ? false : 60_000),
  }).subscribe(() => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(offReads).toBe(1);
  streamUp = false; // the stream is gone for good; nothing tells this observer
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(offReads).toBe(1); // frozen: the false it answered once is never asked again
  off();

  let ticks = 0;
  const armed = new QueryObserver(qc, {
    queryKey: ["interval-skip"],
    queryFn: async () => { ticks += 1; return ticks; },
    refetchInterval: 60_000,
  }).subscribe(() => {});
  await vi.advanceTimersByTimeAsync(0); // the mount read
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  // Every tick still fires while the frames are the source; the read inside it is what the hook skips, so a
  // stream that dies leaves a timer that is already running and reads for real on its next tick.
  expect(ticks).toBe(6);
  armed();
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
