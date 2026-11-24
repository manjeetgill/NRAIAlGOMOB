import { afterEach, expect, it, vi } from "vitest";
import {
  applyTick,
  bucketStart,
  foldBucket,
  foldPriors,
  istDayStart,
  streamId,
  symbolFromStreamId,
  tickBarInput,
  tickLabel,
} from "../../packages/shared/src/api/live-candles.ts";

// The screen is only honest about a live market if the code that turns prod's price frames into candles agrees
// with the backend recorder (services/market_data/candles.py) and the web desk (components/chart/live-bar.ts) -
// both in github.com/manjeetgill/NRAIAlgo-Python, the repo that serves the API this app talks to.
// A frame carries a price and an exchange stamp, never a bar, so every rule below is a bar boundary the mobile
// app used to have no version of.

const IST = 19_800_000;
/** An IST wall-clock instant as epoch ms: `ist(2026, 11, 17, "09:15")` is 09:15:00 IST on that date. */
function ist(year: number, month: number, day: number, time: string): number {
  const [hh, mm, ss = "0"] = time.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hh, mm, ss) - IST;
}

const TUE = ist(2026, 11, 17, "12:00");
const OPEN = ist(2026, 11, 17, "09:15");
const CLOSE = ist(2026, 11, 17, "15:30");

it("puts intraday buckets on the 09:15 session grid", () => {
  expect(bucketStart(OPEN, "5m")).toBe(OPEN);
  expect(bucketStart(ist(2026, 11, 17, "09:19"), "5m")).toBe(OPEN);
  expect(bucketStart(ist(2026, 11, 17, "09:20"), "5m")).toBe(ist(2026, 11, 17, "09:20"));
  expect(bucketStart(ist(2026, 11, 17, "09:14"), "5m")).toBeNull();
  expect(bucketStart(ist(2026, 11, 17, "15:31"), "5m")).toBeNull();
});

it("folds the 15:30 closing print into the last bucket instead of opening a bar after the session", () => {
  expect(bucketStart(CLOSE, "5m")).toBe(ist(2026, 11, 17, "15:25"));
  expect(bucketStart(CLOSE, "1m")).toBe(ist(2026, 11, 17, "15:29"));
  // The hour grid is measured from the 09:15 open, so the last session hour runs 15:15 to 15:30.
  expect(bucketStart(CLOSE, "1h")).toBe(ist(2026, 11, 17, "15:15"));
});

it("starts a daily, weekly and monthly bar on the IST boundary, never the UTC one", () => {
  expect(bucketStart(TUE, "1d")).toBe(istDayStart(TUE));
  expect(bucketStart(TUE, "1d")).toBe(ist(2026, 11, 17, "00:00"));
  // 2026-11-17 is a Tuesday; the IST week it belongs to opened on Monday the 16th.
  expect(bucketStart(TUE, "1w")).toBe(ist(2026, 11, 16, "00:00"));
  expect(bucketStart(ist(2026, 11, 15, "10:00"), "1w")).toBe(ist(2026, 11, 9, "00:00"));
  expect(bucketStart(TUE, "1M")).toBe(ist(2026, 11, 1, "00:00"));
});

it("refuses to build a bar outside the session or from a time it cannot read", () => {
  expect(bucketStart(ist(2026, 11, 17, "03:00"), "1d")).toBeNull();
  expect(bucketStart(Number.NaN, "1m")).toBeNull();
});

it("opens a new bar with the first price of its bucket and only extends the bar it belongs to", () => {
  const five = ist(2026, 11, 17, "09:20");
  const first = applyTick(undefined, "5m", 24_500.35, ist(2026, 11, 17, "09:22"));
  expect(first).toEqual({ timestamp: five, open: 24_500.35, high: 24_500.35, low: 24_500.35, close: 24_500.35 });
  const next = applyTick(first, "5m", 24_490, ist(2026, 11, 17, "09:23"));
  expect(next).toEqual({ ...first, low: 24_490, high: 24_500.35, close: 24_490 });
  const higher = applyTick(next, "5m", 24_600, ist(2026, 11, 17, "09:24"));
  expect(higher?.high).toBe(24_600);
  // The next bucket is a new bar, not a wider one: the previous bar's open stays where the session left it.
  expect(applyTick(higher, "5m", 24_700, ist(2026, 11, 17, "09:27"))).toEqual({
    timestamp: ist(2026, 11, 17, "09:25"), open: 24_700, high: 24_700, low: 24_700, close: 24_700,
  });
});

it("drops the prices that must not move a candle", () => {
  expect(applyTick(undefined, "5m", 0, TUE)).toBeNull();
  expect(applyTick(undefined, "5m", -100, TUE)).toBeNull();
  expect(applyTick(undefined, "5m", Number.NaN, TUE)).toBeNull();
  expect(applyTick(undefined, "5m", 24_500, ist(2026, 11, 17, "08:00"))).toBeNull();
  // An out-of-order tick can never rewind a bar that already moved past it.
  const late = { timestamp: ist(2026, 11, 17, "11:00"), open: 1, high: 2, low: 0.5, close: 1.5 };
  expect(applyTick(late, "5m", 999, ist(2026, 11, 17, "10:00"))).toBeNull();
});

it("gives a daily candle its true open from the session bars, not from the first price this device saw", () => {
  const session = [
    { timestamp: OPEN, open: 24_400, high: 24_450, low: 24_380, close: 24_430 },
    { timestamp: ist(2026, 11, 17, "09:20"), open: 24_430, high: 24_500, low: 24_420, close: 24_460, volume: 10 },
    { timestamp: ist(2026, 11, 16, "15:25"), open: 24_000, high: 24_010, low: 23_990, close: 24_005 },
  ];
  expect(foldBucket(session, "1d", TUE)).toEqual({
    timestamp: ist(2026, 11, 17, "00:00"),
    open: 24_400,
    high: 24_500,
    low: 24_380,
    close: 24_460,
  });
  expect(foldBucket(session, "1d", ist(2026, 11, 16, "12:00"))?.open).toBe(24_000);
  expect(foldBucket([], "1d", TUE)).toBeNull();
  expect(foldBucket(session, "1d", ist(2026, 11, 17, "08:00"))).toBeNull();
});

it("sums volume only when every folded bar carries one, so a partial record never reports a false total", () => {
  const partial = [
    { timestamp: OPEN, open: 1, high: 2, low: 1, close: 2 },
    { timestamp: ist(2026, 11, 17, "09:20"), open: 2, high: 3, low: 2, close: 2, volume: 10 },
  ];
  expect(foldBucket(partial, "1d", TUE)?.volume).toBeUndefined();
  const both = [
    { timestamp: OPEN, open: 1, high: 2, low: 1, close: 2, volume: 5 },
    { timestamp: ist(2026, 11, 17, "09:20"), open: 2, high: 3, low: 2, close: 2, volume: 10 },
  ];
  expect(foldBucket(both, "1d", TUE)?.volume).toBe(15);
});

// A bar's high and low are the prices that actually traded in its bucket, and the record is only polled every
// few seconds. A re-seed that forgot what this device saw between two polls would draw a candle narrower than
// the market made, so the two priors have to be joined before the next price extends them.
it("joins the polled record with what this device's own ticks saw in the same bucket", () => {
  const bucket = ist(2026, 11, 17, "09:25");
  const record = { timestamp: bucket, open: 24_500, high: 24_560, low: 24_500, close: 24_555 };
  const carried = { timestamp: bucket, open: 24_500, high: 24_610, low: 24_490, close: 24_555 };
  expect(foldPriors(record, carried)).toEqual({ ...record, high: 24_610, low: 24_490 });

  // A bucket the record no longer covers is not this tick's bucket, so nothing folds across it.
  expect(foldPriors(record, { ...carried, timestamp: ist(2026, 11, 17, "09:20") })).toEqual(record);

  // Either half on its own stays what it is: a bucket with no record still keeps the extremes its ticks saw,
  // and a record this device has not ticked in yet is not widened by a bar from somewhere else.
  expect(foldPriors(undefined, carried)).toEqual(carried);
  expect(foldPriors(record, undefined)).toEqual(record);
  expect(foldPriors(undefined, undefined)).toBeUndefined();
});

it("never paints a candle behind the live price after a record load", () => {
  const bucket = ist(2026, 11, 17, "09:25");
  const ticked = applyTick(undefined, "5m", 24_610, ist(2026, 11, 17, "09:26"));
  const record = { timestamp: bucket, open: 24_500, high: 24_560, low: 24_500, close: 24_555 };
  const merged = applyTick(foldPriors(record, ticked ?? undefined), "5m", 24_540, ist(2026, 11, 17, "09:29"));
  expect(merged).toEqual({ timestamp: bucket, open: 24_500, high: 24_610, low: 24_500, close: 24_540 });
});

// Prod subscribes by canonical instrument id (brokers/shared/instrument_registry.py) and closes the socket when
// an id fails to parse, so a wrong guess is a dead stream for the whole app, not one empty chart.
it("builds the canonical id for the symbols the stream publishes", () => {
  expect(streamId("NIFTY")).toBe("instrument:v1:NSE:INDEX:NIFTY%2050:INDEX");
  expect(streamId("BANKNIFTY")).toBe("instrument:v1:NSE:INDEX:NIFTY%20BANK:INDEX");
  expect(streamId("NIFTY BANK")).toBe("instrument:v1:NSE:INDEX:NIFTY%20BANK:INDEX");
  expect(streamId("FINNIFTY")).toBe("instrument:v1:NSE:INDEX:NIFTY%20FIN%20SERVICE:INDEX");
  expect(streamId("INDIA VIX")).toBe("instrument:v1:NSE:INDEX:INDIA%20VIX:INDEX");
  expect(streamId("RELIANCE")).toBe("instrument:v1:NSE:EQ:RELIANCE:CASH");
});

it("declines an id for anything the stream never publishes", () => {
  expect(streamId("SENSEX")).toBeNull();
  expect(streamId("BANKEX")).toBeNull();
  expect(streamId("MCX:GOLD")).toBeNull();
  expect(streamId("")).toBeNull();
});

it("reads a listed symbol back out of the id it was subscribed with", () => {
  expect(symbolFromStreamId(streamId("NIFTY") ?? "")).toBe("NIFTY 50");
  expect(symbolFromStreamId(streamId("RELIANCE") ?? "")).toBe("RELIANCE");
  expect(symbolFromStreamId("not-an-id")).toBe("");
});

it("only lets a price the server published as fresh and exchange-stamped move a bar", () => {
  const tick = { id: "a", price: 24_500, at: TUE, fresh: true, status: "LIVE", source: "vendor", broker: "icici", subscriptionId: "s" };
  expect(tickBarInput(tick)).toEqual({ price: 24_500, at: TUE });
  expect(tickBarInput({ ...tick, fresh: false })).toBeNull();
  expect(tickBarInput({ ...tick, at: null })).toBeNull();
  expect(tickBarInput({ ...tick, price: 0 })).toBeNull();
  expect(tickBarInput(undefined)).toBeNull();
});

it("says what the stream actually means, so a quiet screen never reads as a broken one", () => {
  const tick = { id: "a", price: 24_500.35, at: TUE, fresh: true, status: "LIVE", source: "vendor", broker: "icici", subscriptionId: "s" };
  expect(tickLabel(tick, true)).toBe("Live price 24500.35");
  expect(tickLabel({ ...tick, status: "MARKET_CLOSED" }, true)).toBe("Market closed price 24500.35");
  expect(tickLabel(null, true)).toBe("Waiting for a live tick");
  expect(tickLabel(null, false)).toBe("Connecting to live prices");
  expect(tickLabel(tick, false, "closed")).toBe("Connecting to live prices");
  expect(tickLabel(null, true, "policy")).toBe("The live price stream refused this device");
  expect(tickLabel(null, true, "capacity")).toBe("This account already has three live streams open");
});

// ===== the socket itself =====

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeSocket.instances.push(this);
  }

  send(text: string) { this.sent.push(text); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  frame(value: unknown) { this.readyState = 1; this.onmessage?.({ data: JSON.stringify(value) }); }
  refuse(code: number) { this.readyState = 3; this.onclose?.({ code }); }
}

const RELIANCE = "instrument:v1:NSE:EQ:RELIANCE:CASH";
const NIFTY = "instrument:v1:NSE:INDEX:NIFTY%2050:INDEX";

async function loadSocket() {
  vi.resetModules();
  FakeSocket.instances = [];
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  return import("../../packages/shared/src/api/websocket.ts");
}

function wire(id: string, price: number, at: string, extra: Record<string, unknown> = {}) {
  return { id, broker: "icici", accountId: "live", subscriptionId: `s-${id}`, price, exchangeTime: at, fresh: true, ...extra };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("sends one replace frame with exactly the instruments this screen asked for", async () => {
  const { watchQuotes } = await loadSocket();
  watchQuotes([NIFTY, RELIANCE], () => {});
  const socket = FakeSocket.instances[0];
  socket.open();
  expect(JSON.parse(socket.sent[0])).toEqual({ type: "subscribe", instruments: [RELIANCE, NIFTY] });
});

it("keeps every screen's instruments in one subscription when a frame replaces the set", async () => {
  const { watchQuotes } = await loadSocket();
  watchQuotes([RELIANCE], () => {});
  watchQuotes([NIFTY], () => {});
  const socket = FakeSocket.instances[0];
  socket.open();
  // Every registration replaces, so the server always holds the union rather than the last screen's list.
  expect(JSON.parse(socket.sent.at(-1) ?? "").instruments).toEqual([RELIANCE, NIFTY]);
});

it("replaces the published prices on a snapshot frame and merges a delta frame", async () => {
  const { watchQuotes } = await loadSocket();
  const feeds: { ids: string[]; connected: boolean }[] = [];
  watchQuotes([RELIANCE, NIFTY], (feed) => feeds.push({ ids: feed.quotes.map((q) => q.id), connected: feed.connected }));
  const socket = FakeSocket.instances[0];
  socket.open();
  const stamp = "2026-11-17T04:30:00Z"; // 10:00 IST
  socket.frame({ mode: "snapshot", quotes: [wire(RELIANCE, 1400, stamp), wire(NIFTY, 24_500, stamp)] });
  expect(feeds.at(-1)?.ids).toEqual([RELIANCE, NIFTY]);
  socket.frame({ mode: "snapshot", quotes: [wire(NIFTY, 24_510, stamp)] });
  expect(feeds.at(-1)?.ids).toEqual([NIFTY]);
  socket.frame({ mode: "delta", quotes: [wire(RELIANCE, 1402, stamp)] });
  expect(feeds.at(-1)?.ids).toEqual([NIFTY, RELIANCE]);
  socket.frame({ mode: "delta", removed: [JSON.stringify(["icici", "live", `s-${NIFTY}`])] });
  expect(feeds.at(-1)?.ids).toEqual([RELIANCE]);
});

it("carries the exchange stamp, the freshness flag and the server status onto the tick", async () => {
  const { watchQuotes } = await loadSocket();
  const seen: Record<string, unknown>[] = [];
  watchQuotes([RELIANCE], (feed) => feed.quotes.forEach((tick) => seen.push({ ...tick })));
  const socket = FakeSocket.instances[0];
  socket.open();
  socket.frame({
    mode: "snapshot",
    quotes: [wire(RELIANCE, 1400.5, "2026-11-17T04:30:00Z", { dataStatus: "LIVE", priceSource: "vendordata", fresh: false })],
  });
  expect(seen[0]).toMatchObject({
    id: RELIANCE,
    price: 1400.5,
    at: Date.parse("2026-11-17T04:30:00Z"),
    fresh: false,
    status: "LIVE",
    source: "vendordata",
  });
});

it("ignores a frame's unsigned and non-positive prices instead of publishing a zero", async () => {
  const { watchQuotes } = await loadSocket();
  const feeds: string[][] = [];
  watchQuotes([RELIANCE, NIFTY], (feed) => feeds.push(feed.quotes.map((q) => q.id)));
  const socket = FakeSocket.instances[0];
  socket.open();
  socket.frame({ mode: "snapshot", quotes: [wire(RELIANCE, 0, "2026-11-17T04:30:00Z"), wire(NIFTY, 24_500, "not-a-time")] });
  expect(feeds.at(-1)).toEqual([NIFTY]);
  socket.frame({ mode: "delta", quotes: [wire(RELIANCE, 1401, "2026-11-17T04:31:00Z")] });
  expect(feeds.at(-1)).toEqual([NIFTY, RELIANCE]);
});

it("does not notify disjoint watchers when only unrelated instruments tick (M1)", async () => {
  const { watchQuotes } = await loadSocket();
  let relianceCalls = 0;
  let niftyCalls = 0;
  watchQuotes([RELIANCE], () => {
    relianceCalls++;
  });
  watchQuotes([NIFTY], () => {
    niftyCalls++;
  });
  const socket = FakeSocket.instances[0];
  socket.open();
  const stamp = "2026-11-17T04:30:00Z";
  // Initial snapshot frame delivers to both
  socket.frame({ mode: "snapshot", quotes: [wire(RELIANCE, 1400, stamp), wire(NIFTY, 24_500, stamp)] });
  const relianceBefore = relianceCalls;
  const niftyBefore = niftyCalls;
  // Delta frame only for RELIANCE should NOT notify NIFTY watcher
  socket.frame({ mode: "delta", quotes: [wire(RELIANCE, 1402, stamp)] });
  expect(relianceCalls).toBe(relianceBefore + 1);
  expect(niftyCalls).toBe(niftyBefore);
});

it("does not retry a refusal, but does retry a dropped connection", async () => {
  vi.useFakeTimers();
  const { watchQuotes } = await loadSocket();
  const feeds: { connected: boolean }[] = [];
  watchQuotes([RELIANCE], (feed) => feeds.push({ connected: feed.connected }));
  const first = FakeSocket.instances[0];
  first.open();
  first.refuse(1008);
  expect(feeds.at(-1)?.connected).toBe(false);
  vi.advanceTimersByTime(120_000);
  expect(FakeSocket.instances).toHaveLength(1);

  vi.useRealTimers();
  vi.useFakeTimers();
  const mod2 = await loadSocket();
  const seen: { connected: boolean }[] = [];
  mod2.watchQuotes([RELIANCE], (feed) => seen.push({ connected: feed.connected }));
  const opened = FakeSocket.instances[0];
  opened.open();
  opened.refuse(1006); // a plain drop: no gate refused us, so it is worth trying again
  vi.advanceTimersByTime(2000);
  expect(FakeSocket.instances.length).toBeGreaterThan(1);
});

it("clears the published prices when the socket goes down, so no screen paints a dead tick as live", async () => {
  const { watchQuotes } = await loadSocket();
  const feeds: { count: number; connected: boolean }[] = [];
  watchQuotes([RELIANCE], (feed) => feeds.push({ count: feed.quotes.length, connected: feed.connected }));
  const socket = FakeSocket.instances[0];
  socket.open();
  socket.frame({ mode: "snapshot", quotes: [wire(RELIANCE, 1400, "2026-11-17T04:30:00Z")] });
  expect(feeds.at(-1)).toEqual({ count: 1, connected: true });
  socket.refuse(1006);
  expect(feeds.at(-1)).toEqual({ count: 0, connected: false });
});

it("returns all published quotes when a watcher subscribes with no specific instrument ids", async () => {
  const { watchQuotes } = await loadSocket();
  const feeds: { ids: string[]; connected: boolean }[] = [];
  watchQuotes([], (feed) => feeds.push({ ids: feed.quotes.map((q) => q.id), connected: feed.connected }));
  const socket = FakeSocket.instances[0];
  socket.open();
  const stamp = "2026-11-17T04:30:00Z";
  socket.frame({ mode: "snapshot", quotes: [wire(RELIANCE, 1400, stamp), wire(NIFTY, 24_500, stamp)] });
  expect(feeds.at(-1)?.ids).toEqual([RELIANCE, NIFTY]);
});

it("accepts quotes when id is omitted but subscriptionId is present", async () => {
  const { watchQuotes } = await loadSocket();
  const feeds: { count: number; prices: number[] }[] = [];
  watchQuotes([], (feed) => feeds.push({ count: feed.quotes.length, prices: feed.quotes.map((q) => q.price) }));
  const socket = FakeSocket.instances[0];
  socket.open();
  const stamp = "2026-11-17T04:30:00Z";
  socket.frame({
    mode: "snapshot",
    quotes: [
      { id: null, broker: "icici", accountId: "live", subscriptionId: "icici:NSE|ITC|CASH", price: 470.5, exchangeTime: stamp, fresh: true },
    ],
  });
  expect(feeds.at(-1)?.count).toBe(1);
  expect(feeds.at(-1)?.prices).toEqual([470.5]);
});
