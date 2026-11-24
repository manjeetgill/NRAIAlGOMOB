import { expect, it } from "vitest";
import {
  liveSide,
  strikeIds,
  tickBeats,
  tickByInstrument,
  tickWord,
  watchBand,
} from "../../packages/shared/src/api/chain-ticks.ts";
import type { OptionQuote, OptionRow } from "../../packages/shared/src/api/hooks.ts";
import type { QuoteTick } from "../../packages/shared/src/api/websocket.ts";

// A ladder read costs the broker seconds, so the strikes on screen also go on the price stream the app
// already holds. These cases pin which ids go on the wire, when the band that decides them moves, and which
// of the two prices a row is allowed to paint.
const CE = "instrument:v1:NSE:FO:NIFTY:OPT:2026-11-26:25500:CE";
const PE = "instrument:v1:NSE:FO:NIFTY:OPT:2026-11-26:25500:PE";

const side = (over: Partial<OptionQuote> = {}) =>
  ({
    symbol: "NIFTY26NOV25500CE",
    order: { exchange: "NFO", tradingsymbol: "NIFTY26NOV25500CE" },
    instrumentId: CE,
    ltp: "180.25",
    bid: "180.00",
    ask: "180.50",
    iv: 12.5,
    delta: 0.5,
    oi: 1000,
    oiChangePct: null,
    volume: 500,
    quote: { at: "2026-11-23T10:00:00Z", quality: "live" },
    ...over,
  }) as OptionQuote;

const row = (call: OptionQuote | null, put: OptionQuote | null): OptionRow =>
  ({ strike: "25500", isAtTheMoney: true, call, put });

const tick = (over: Partial<QuoteTick> = {}): QuoteTick =>
  ({
    id: CE,
    price: 181,
    at: Date.parse("2026-11-23T10:00:05Z"),
    fresh: true,
    status: "LIVE",
    source: "icici",
    broker: "icici",
    subscriptionId: "1234",
    ...over,
  });

it("asks the stream for the identities the rows carry, never for their labels", () => {
  expect(strikeIds([row(side(), side({ instrumentId: PE })), row(side({ instrumentId: PE }), null)])).toEqual([CE, PE]);
});

it("asks for nothing a broker cannot resolve", () => {
  expect(strikeIds([row(null, null)])).toEqual([]);
  expect(strikeIds([row(side({ instrumentId: "" }), side({ instrumentId: "NIFTY26NOV25500CE" }))])).toEqual([]);
});

it("holds the band while it still covers the screen, so reading the ladder costs no re-subscription", () => {
  const band = watchBand([2, 3, 4], 60, null, 6);
  expect(band).toEqual({ from: 0, to: 10 });
  // Still the same object: the state setter bails out and the socket is never re-asked.
  expect(watchBand([5, 6, 7], 60, band, 6)).toBe(band);
  expect(watchBand([], 60, band, 6)).toBe(band);
});

it("moves the band when a visible strike leaves it, and never past the ends of the list", () => {
  const band = watchBand([2, 3, 4], 60, null, 6);
  expect(watchBand([30, 31], 60, band, 6)).toEqual({ from: 24, to: 37 });
  expect(watchBand([0, 1], 3, null, 6)).toEqual({ from: 0, to: 2 });
});

it("keeps the same tick map when a frame repeats prices it already painted", () => {
  const first = tickByInstrument([tick(), tick({ id: PE, price: 90 })], new Map());
  expect(first.size).toBe(2);
  expect(tickByInstrument([tick(), tick({ id: PE, price: 90 })], first)).toBe(first);
  const moved = tickByInstrument([tick({ price: 182 }), tick({ id: PE, price: 90 })], first);
  expect(moved).not.toBe(first);
  expect(moved.get(CE)?.price).toBe(182);
});

it("names a price that is not a live trade in the words the chain already uses", () => {
  expect(tickWord(tick())).toBeNull();
  expect(tickWord(tick({ status: null, fresh: true }))).toBeNull();
  expect(tickWord(tick({ status: "DELAYED" }))).toBe("delayed price");
  expect(tickWord(tick({ status: "MARKET_CLOSED" }))).toBe("last price");
  expect(tickWord(tick({ status: "NOT-A-STATUS", fresh: false }))).toBe("old price");
  expect(tickWord(tick({ status: null, fresh: false }))).toBe("old price");
});

it("lets a stream price replace the ladder only when it is not the older of the two", () => {
  const stamp = "2026-11-23T10:00:00Z";
  expect(tickBeats(tick(), stamp)).toBe(true);
  expect(tickBeats(tick({ at: Date.parse(stamp) }), stamp)).toBe(true);
  expect(tickBeats(tick({ at: Date.parse("2026-11-23T09:59:00Z") }), stamp)).toBe(false);
  // A tick the broker stamped with no exchange time stands on the server's own freshness flag.
  expect(tickBeats(tick({ at: null }), stamp)).toBe(true);
  expect(tickBeats(tick({ at: null, fresh: false }), stamp)).toBe(false);
  // Nothing to be older than, and no price at all, decide the two remaining ways.
  expect(tickBeats(tick(), null)).toBe(true);
  expect(tickBeats(tick({ price: 0 }), stamp)).toBe(false);
  expect(tickBeats(undefined, stamp)).toBe(false);
});

it("paints the tick when it wins and the chain read when it does not", () => {
  expect(liveSide(side(), tick())).toEqual({ price: 181, word: null, ticked: true });
  expect(liveSide(side(), tick({ status: "STALE", fresh: false, at: Date.parse("2026-11-23T09:00:00Z") })))
    .toEqual({ price: 180.25, word: null, ticked: false });
  expect(liveSide(side(), tick({ status: "DELAYED" }))).toEqual({ price: 181, word: "delayed price", ticked: true });
  expect(liveSide(side({ ltp: null }), undefined)).toBeNull();
  // A row the chain left unpriced still takes a price the stream is carrying for it.
  expect(liveSide(null, tick({ price: 77 }))).toEqual({ price: 77, word: null, ticked: true });
});
