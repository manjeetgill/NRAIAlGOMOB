import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { markWatchlist, streamIdFor } from "../../packages/shared/src/api/account-quotes.ts";
import type { QuoteTick } from "../../packages/shared/src/api/websocket.ts";
import type { WatchlistRow } from "../../packages/shared/src/api/hooks.ts";

/**
 * A watchlist read prices the list once; the only way its rows move tick by tick is prod's quote stream.
 * These cases pin the two halves of that: the id the screen subscribes by, and what a tick is allowed to
 * change on a row. The figures come from prod's own arithmetic in services/watchlist.py `quote_rows`, where
 * `close` is the previous close and `change` is `ltp - close` rounded to two paise.
 */

const tick = (id: string, price: number, fresh = true): QuoteTick => ({
  id,
  price,
  at: Date.parse("2026-11-23T03:45:00Z"),
  fresh,
  status: fresh ? "LIVE" : "STALE",
  source: "icici",
  broker: "icici",
  subscriptionId: id,
});

const row = (over: Partial<WatchlistRow> = {}): WatchlistRow => ({
  exchange: "NSE",
  symbol: "ITC",
  name: "ITC Ltd",
  ltp: 281.5,
  close: 279.2,
  change: 2.3,
  changePct: 0.82,
  ...over,
});

it("subscribes a watchlist row by the cash id the stream parses", () => {
  expect(streamIdFor({ exchange: "NSE", symbol: "ITC", product: "CASH", expiry: null, strike: null, right: null }))
    .toBe("instrument:v1:NSE:EQ:ITC:CASH");
  // The F&O stock lists carry ampersands, and an unencoded id is one the server cannot parse - which closes
  // the socket for the whole app, not just this row.
  expect(streamIdFor({ exchange: "NSE", symbol: "M&M", product: "CASH", expiry: null, strike: null, right: null }))
    .toBe("instrument:v1:NSE:EQ:M%26M:CASH");
});

it("re-prices a row from a fresh tick and recomputes the day's change against the list's own close", () => {
  const marked = markWatchlist([row()], [tick("instrument:v1:NSE:EQ:ITC:CASH", 300)]);
  expect(marked[0].ltp).toBe(300);
  expect(marked[0].change).toBe(20.8);
  expect(marked[0].changePct).toBe(7.45);
  expect(marked[0].live).toBe(true);
});

it("leaves a row on the read's price when the stream says the tick is not fresh", () => {
  const before = row();
  const marked = markWatchlist([before], [tick("instrument:v1:NSE:EQ:ITC:CASH", 300, false)]);
  expect(marked[0].ltp).toBe(before.ltp);
  expect(marked[0].change).toBe(before.change);
  expect(marked[0].live).toBe(false);
});

it("shows a ticked price without inventing a daily move the list never gave a close for", () => {
  const marked = markWatchlist([row({ close: null, change: null, changePct: null })], [tick("instrument:v1:NSE:EQ:ITC:CASH", 300)]);
  expect(marked[0].ltp).toBe(300);
  expect(marked[0].live).toBe(true);
  expect(marked[0].change).toBeNull();
  expect(marked[0].changePct).toBeNull();
});

it("uses the closing print the tick itself carried, which is why a live list is not left with no change figure", () => {
  const marked = markWatchlist(
    [row({ close: null, change: null, changePct: null })],
    [{ ...tick("instrument:v1:NSE:EQ:ITC:CASH", 300), previousClose: 279.2 }],
  );
  expect(marked[0].close).toBe(279.2);
  expect(marked[0].change).toBe(20.8);
  expect(marked[0].changePct).toBe(7.45);
});

it("prefers the exchange's close on the tick over the one the list was read with", () => {
  // A list read before the open carries yesterday's close; the frame carries the session the tick was stamped
  // in. The server's own figure for that tick is the one a change may be measured against.
  const marked = markWatchlist(
    [row({ close: 270 })],
    [{ ...tick("instrument:v1:NSE:EQ:ITC:CASH", 300), previousClose: 279.2 }],
  );
  expect(marked[0].change).toBe(20.8);
});

it("prices the whole page, not only the row that happens to match first", () => {
  const marked = markWatchlist(
    [row({ symbol: "ITC" }), row({ symbol: "RELIANCE", ltp: 1400, close: 1390, change: 10, changePct: 0.72 })],
    [tick("instrument:v1:NSE:EQ:RELIANCE:CASH", 1500), tick("instrument:v1:NSE:EQ:ITC:CASH", 300)],
  );
  expect(marked.map(item => item.ltp)).toEqual([300, 1500]);
  expect(marked.map(item => item.live)).toEqual([true, true]);
});

it("carries the closing print off the wire instead of dropping it with the rest of the frame", () => {
  const feed = readFileSync(resolve("packages/shared/src/api/websocket.ts"), "utf8");
  expect(feed).toContain("previousClose: positiveNumber(quote.previousClose)");
});

it("subscribes the rendered list off the stream instead of only re-reading it", () => {
  const screen = readFileSync(resolve("apps/mobile/app/(tabs)/watchlist.tsx"), "utf8");
  expect(screen).toContain("const feed = useQuoteFeed(instruments, authenticated && instruments.length > 0)");
  expect(screen).toContain("markWatchlist(rows, feed.quotes)");
  expect(screen).toContain("data={liveRows}");
  // The state line used to cover an open socket with no ticks and a closed one with the same word.
  expect(screen).toContain('"ticking" : feed.connected ? "waiting for ticks" : "no live stream"');
});
