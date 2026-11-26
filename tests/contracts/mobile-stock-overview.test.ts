import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
  bookStamp,
  depthBook,
  quoteProvenance,
  rangePosition,
} from "../../packages/shared/src/api/stock-overview.ts";
import { formatISTDate } from "../../packages/shared/src/utils/index.ts";

/**
 * The Overview screen is allowed to show only what `GET /v1/equities/quote` publishes, so the arithmetic that
 * turns that payload into a ladder has to be exact. These cases hold the three rules the screen is built on:
 * a rung the broker did not price is never drawn as zero, a meter is only drawn when both sides exist, and a
 * price the server labelled stale or closing never reaches the screen looking live.
 */

const today = formatISTDate(new Date());
const yesterday = formatISTDate(new Date(Date.now() - 86_400_000));

const FULL_BOOK = {
  ltp: 6282.5,
  depth: {
    buy: [
      { price: 6282, quantity: 120 },
      { price: 6281.5, quantity: 340 },
      { price: 6281, quantity: 80 },
      { price: 6280.5, quantity: 250 },
      { price: 6280, quantity: 410 },
    ],
    sell: [
      { price: 6282.5, quantity: 71 },
      { price: 6283, quantity: 205 },
      { price: 6283.5, quantity: 18 },
      { price: 6284, quantity: 96 },
      { price: 6285, quantity: 312 },
    ],
  },
};

it("sums the five levels into the TBQ, TSQ and bid share the ladder prints", () => {
  const book = depthBook(FULL_BOOK);
  expect(book.bids).toHaveLength(5);
  expect(book.asks).toHaveLength(5);
  expect(book.tbq).toBe(1200);
  expect(book.tsq).toBe(702);
  expect(book.bidShare).toBeCloseTo(63.1, 1);
  expect(book.topOfBookOnly).toBe(false);
});

it("accepts the socket's own numeric text without turning a level into NaN", () => {
  const book = depthBook({ depth: { buy: [{ price: "6282.00", quantity: "120" }], sell: [] } });
  expect(book.bids[0]).toEqual({ price: 6282, quantity: 120, orders: null });
  expect(book.tbq).toBe(120);
  expect(book.tsq).toBeNull();
  // A one-sided book has no two-way split to draw, so the meter is skipped rather than shown as 100%.
  expect(book.bidShare).toBeNull();
});

it("drops a level the broker sent unpriced instead of drawing a zero", () => {
  const book = depthBook({ depth: { buy: [{ price: 0, quantity: 500 }, { quantity: 300 }, { price: 6280, quantity: 40 }], sell: null } });
  expect(book.bids.map(rung => rung.price)).toEqual([6280]);
});

it("falls back to the read's own best bid and ask, and says the ladder is top-of-book only", () => {
  const book = depthBook({ bid: 6282, ask: 6282.5, bidQuantity: 120, askQuantity: 71 });
  expect(book.topOfBookOnly).toBe(true);
  expect(book.bids[0].price).toBe(6282);
  expect(book.asks[0].price).toBe(6282.5);
  expect(book.bidShare).toBeCloseTo(62.8, 1);
});

it("draws no ladder at all when the server sent neither a book nor a two-way price", () => {
  const book = depthBook({ ltp: 6282.5, depthMessage: "Market depth is not available for this symbol." });
  expect(book.bids).toEqual([]);
  expect(book.asks).toEqual([]);
  expect(book.bidShare).toBeNull();
  expect(book.tbq).toBeNull();
});

it("places a price inside a range and refuses a range that has no room in it", () => {
  expect(rangePosition(6137.75, 6136, 6339.5)).toBe(0.9);
  expect(rangePosition(6339.5, 6136, 6339.5)).toBe(100);
  // A pre-open frame where high equals low is not a range the bar may claim to place a price inside.
  expect(rangePosition(6282.5, 6282.5, 6282.5)).toBeNull();
  expect(rangePosition(6282.5, null, 6339.5)).toBeNull();
  expect(rangePosition(null, 6136, 6339.5)).toBeNull();
});

it("clamps a price outside a range the server revised after the read", () => {
  expect(rangePosition(6600, 4244.5, 6599)).toBe(100);
  expect(rangePosition(4000, 4244.5, 6599)).toBe(0);
});

it("stamps the book with its own frame time and keeps the server's reason verbatim", () => {
  const stamp = bookStamp({ ...FULL_BOOK, depthAt: "2026-11-24T10:21:04Z", at: "2026-11-24T10:00:00Z",
    depthMessage: "Depth feed is delayed." });
  expect(stamp.live).toBe(true);
  expect(stamp.reason).toBe("Depth feed is delayed.");
  expect(stamp.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
});

it("marks a top-of-book fallback as not live, so the dot cannot read as a ticking ladder", () => {
  const stamp = bookStamp({ bid: 6282, ask: 6282.5, at: "2026-11-24T10:21:04Z" });
  expect(stamp.live).toBe(false);
  expect(stamp.time).toBe("15:51:04");
});

it("labels the price by the server's own quality and session", () => {
  // Every case here carries a figure: a badge that dates a price has to have one to date.
  expect(quoteProvenance({ ltp: 6282.5, quality: "live", priceDate: today })).toEqual({ word: "Live", live: true, date: today });
  expect(quoteProvenance({ ltp: 6282.5, quality: "delayed", priceDate: today }).word).toBe("Delayed");
  expect(quoteProvenance({ ltp: 6282.5, quality: "stale", priceDate: today }).word).toBe("Last known");
  expect(quoteProvenance({ ltp: 6282.5, quality: "eod", priceDate: yesterday }).word).toBe("Last close");
  expect(quoteProvenance({ ltp: null, quality: "unavailable" }).word).toBe("No price");
  // A live-labelled figure from an earlier session is still a closing price, whatever the flag says.
  expect(quoteProvenance({ ltp: 6282.5, quality: "live", priceDate: yesterday })).toEqual({ word: "Last close", live: false, date: yesterday });
});

it("answers a read with no quality word by its date alone", () => {
  expect(quoteProvenance({ ltp: 6282.5, priceDate: today })).toEqual({ word: "Today", live: true, date: today });
  expect(quoteProvenance({ ltp: 6282.5, priceDate: yesterday }).word).toBe("Last close");
});

/**
 * What the emulator sweep caught on RELIIND: `/v1/equities/quote` answered 503, the header printed a bare
 * "No price" under a green "Today" badge, and the server's reason vanished behind a spinner on every retry.
 * A badge describes the figure beside it, so it has no business dating a figure that never arrived.
 */
it("refuses to date a price that never arrived", () => {
  expect(quoteProvenance(null)).toEqual({ word: "No price", live: false, date: null });
  expect(quoteProvenance({ priceDate: today })).toEqual({ word: "No price", live: false, date: today });
  expect(quoteProvenance({ ltp: null, quality: "live", priceDate: today })).toEqual({ word: "No price", live: false, date: today });
});

// The screen is where these numbers either reach the trader or get quietly invented.
const screen = readFileSync(resolve("apps/mobile/app/stock.tsx"), "utf8");
const charts = readFileSync(resolve("apps/mobile/app/terminal-charts.tsx"), "utf8");

it("derives every figure from the read rather than a local guess", () => {
  for (const call of ["depthBook(quote ?? null)", "bookStamp(quote ?? null)", "quoteProvenance(quote ?? null)",
    "rangePosition(value, low, high)", "useEquityQuote(exchange, symbol, symbol.length > 0)"]) {
    expect(screen, call).toContain(call);
  }
});

it("names a field the server omitted and the reason a book is short", () => {
  expect(screen).toContain("Not sent");
  expect(screen).toContain("No range in this read");
  expect(screen).toContain("quote?.depthMessage ??");
  expect(screen).toContain("Top of book only");
});

/**
 * The three states the sweep found missing: the header admits it has no price yet instead of printing an
 * empty box, the refusal keeps its place while the query retries, and a session that aged out is named and
 * given the sign-in press rather than left as "Sign in required." on a dead screen.
 */
it("keeps the badge and the change line attached to a real price", () => {
  expect(screen).toContain("const price = shown(quote?.ltp);");
  expect(screen).toContain("{price === null ? null : (");
  expect(screen).toContain('price ?? (isLoading && !failure ? "Waiting for price" : "No price")');
});

it("holds the refusal on screen and offers the way back", () => {
  expect(screen).toContain("const failure = error ? readFailure(error,");
  // Both branches are gated on there being nothing to show, so a cached quote outranks a failed poll.
  expect(screen).toContain("isLoading && !quote && !failure");
  expect(screen).toContain("failure && price === null");
  expect(screen).toContain('router.replace("/login")');
  expect(screen).toContain("Sign in again");
  expect(screen).toContain("trying the broker again");
});

it("leaves out the figures this backend does not serve, rather than approximating them", () => {
  expect(screen.toLowerCase()).not.toContain("circuit");
  expect(screen.toLowerCase()).not.toContain("last traded");
  expect(screen.toLowerCase()).not.toContain("research");
});

it("keeps the ticket minimal and sends nothing by itself", () => {
  expect(screen).toContain("<BuySheet ticket={ticket} />");
  expect(screen).toContain('ticket.open({');
  expect(screen.toLowerCase()).not.toContain("order value");
  expect(screen.toLowerCase()).not.toContain("available limit");
});

it("prices the other venue from a second read of the same endpoint", () => {
  expect(screen).toContain('const other = exchange === "NSE" ? "BSE" : exchange === "BSE" ? "NSE" : null;');
  expect(screen).toContain('useEquityQuote(other ?? "NSE", symbol, !!other && symbol.length > 0)');
});

// A tap is only worth the route it lands on.
const watchlist = readFileSync(resolve("apps/mobile/app/(tabs)/watchlist.tsx"), "utf8");
const portfolio = readFileSync(resolve("apps/mobile/app/(tabs)/portfolio.tsx"), "utf8");
const linking = readFileSync(resolve("apps/mobile/src/utils/deepLinking.ts"), "utf8");

it("opens the Overview on a press and keeps the instant ticket on a long press", () => {
  expect(watchlist).toContain("onPress={() => openOverview(item)}");
  expect(watchlist).toContain('onLongPress={() => (tabKind === "predefined" ? (already ? openBuy(item, "BUY", true) : addTo(item)) : openBuy(item, "BUY", true))}');
  expect(watchlist).toContain('/stock?exchange=');
});

it("keeps adding to the list on its own button now a search row opens a screen", () => {
  expect(watchlist).toContain("onPress={() => openOverview(hit)}");
  expect(watchlist).toContain("onPress={() => addTo(hit)}");
});

it("gives a holding row the press it never had, carrying the broker's own quantity", () => {
  expect(portfolio).toContain("onRowPress={openHolding}");
  expect(portfolio).toContain("&held=${Math.abs(row.quantity)}");
  // Positions keep their existing meaning: a press there closes or adds to that position.
  expect(portfolio).toContain("onRowPress={handleOpenTicket}");
});

it("routes a stock link to the new screen with its venue", () => {
  expect(linking).toContain('"/stock"');
  expect(linking).toContain("`/stock?exchange=");
});

it("hands the symbol to the two screens that already exist for it", () => {
  const chain = readFileSync(resolve("apps/mobile/app/(tabs)/option-chain.tsx"), "utf8");
  expect(chain).toContain("setOptionChainUnderlying(seeded)");
  // The chart desk seeds from the link but still opens on NIFTY when nobody passed a symbol.
  expect(charts).toContain("String(seeded.symbol ?? \"\")");
  expect(charts).toContain("|| DEFAULT_SYMBOL");
});
