import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
  derivativeCodes,
  markHoldings,
  markPositions,
  streamIdFor,
} from "../../packages/shared/src/api/account-quotes.ts";
import { iciciHoldings, iciciOpenPositions, type IciciAccountPayload } from "../../packages/shared/src/api/hooks.ts";
import type { QuoteTick } from "../../packages/shared/src/api/websocket.ts";

/**
 * The book is only live if the price on a row came from the stream, and the stream only accepts canonical
 * contract ids (brokers/shared/instrument_registry.py `contract()`). These cases pin the id grammar against
 * what prod's own key builder (core/quote_ids.py `icici_key`) makes from the same broker row, because an id
 * the server cannot parse closes the socket for the whole app - one bad leg would stop every other row
 * ticking.
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

const optionRow = {
  stock_code: "NIFTY26NOV25000CE",
  exchange_code: "NSE",
  product_type: "OPTIONS",
  expiry_date: "25-Nov-2026",
  strike_price: "25000.00",
  right: "CE",
  action: "BUY",
  quantity: "65",
  average_price: "120.35",
  ltp: "98.10",
  marked_pnl_paise: "-1446250",
};

const book = (positions: unknown[], holdings: unknown[]) =>
  ({
    accountId: "AG297134",
    asOf: "2026-11-23T03:40:00Z",
    sections: {
      portfoliopositions: { status: "available", rows: positions },
      portfolioholdings: { status: "available", rows: holdings },
    },
  }) as unknown as IciciAccountPayload;

it("builds the id prod parses for a cash holding", () => {
  expect(streamIdFor({ exchange: "NSE", symbol: "ITC", product: "CASH", expiry: null, strike: null, right: null }))
    .toBe("instrument:v1:NSE:EQ:ITC:CASH");
});

it("builds the option id from the broker row and the master's underlying, not from the broker code", () => {
  const rows = iciciOpenPositions(book([optionRow], []));
  expect(rows).toHaveLength(1);
  const [row] = rows;
  // ICICI's own code is not the exchange name for the contract: only the derivatives master says NIFTY.
  expect(derivativeCodes([row])).toEqual(["NIFTY26NOV25000CE"]);
  expect(streamIdFor(row, "NIFTY")).toBe("instrument:v1:NSE:FO:NIFTY:OPT:2026-11-25:25000:CE");
});

it("never subscribes a derivative whose underlying the master did not name", () => {
  const [row] = iciciOpenPositions(book([optionRow], []));
  expect(streamIdFor(row, null)).toBeNull();
  expect(streamIdFor(row, undefined)).toBeNull();
});

it("keeps a margin-labelled equity on the cash id it trades under", () => {
  const mis = { ...optionRow, product_type: "MIS", expiry_date: null, strike_price: null, right: null, stock_code: "ITC" };
  const [row] = iciciOpenPositions(book([mis], []));
  expect(streamIdFor(row)).toBe("instrument:v1:NSE:EQ:ITC:CASH");
});

it("marks a position from a fresh tick and recomputes the P&L against the broker's own cost", () => {
  const rows = iciciOpenPositions(book([optionRow], []));
  const marked = markPositions(rows, [tick("instrument:v1:NSE:FO:NIFTY:OPT:2026-11-25:25000:CE", 150)], { NIFTY26NOV25000CE: "NIFTY" });
  expect(marked[0].markPrice).toBe(150);
  expect(marked[0].live).toBe(true);
  // 65 lots bought at 120.35, now 150: the screen's unrealized figure moves with the tick, not with the poll.
  expect(marked[0].unrealizedPnl).toBeCloseTo((150 - 120.35) * 65, 2);
});

it("leaves a position on the broker's saved price when the stream says the tick is not fresh", () => {
  const rows = iciciOpenPositions(book([optionRow], []));
  const before = rows[0];
  const marked = markPositions(rows, [tick("instrument:v1:NSE:FO:NIFTY:OPT:2026-11-25:25000:CE", 150, false)], { NIFTY26NOV25000CE: "NIFTY" });
  expect(marked[0].markPrice).toBe(before.markPrice);
  expect(marked[0].unrealizedPnl).toBe(before.unrealizedPnl);
  expect(marked[0].live).toBe(false);
});

it("marks holdings too, since a tab the stream never subscribed can never tick", () => {
  const rows = iciciHoldings(book([], [{
    stock_code: "ITC", exchange_code: "NSE", quantity: "100", average_price: "279.20",
    current_market_price: "281.50", change_percentage: "0.82", today_holding_pnl_estimate: "230",
  }]));
  const marked = markHoldings(rows, [tick("instrument:v1:NSE:EQ:ITC:CASH", 300)]);
  expect(marked[0].currentPrice).toBe(300);
  expect(marked[0].marketValue).toBe(30000);
  expect(marked[0].unrealizedPnl).toBeCloseTo((300 - 279.2) * 100, 2);
  expect(marked[0].live).toBe(true);
});

it("does not invent a previous close for a holding, so the day's change stays the broker's", () => {
  const rows = iciciHoldings(book([], [{
    stock_code: "ITC", exchange_code: "NSE", quantity: "100", average_price: "279.20",
    current_market_price: "281.50", change_percentage: "0.82", today_holding_pnl_estimate: "230",
  }]));
  const marked = markHoldings(rows, [tick("instrument:v1:NSE:EQ:ITC:CASH", 300)]);
  // The stream frame carries no closing print, so a daily figure recomputed here would be arithmetic
  // the exchange never priced.
  expect(marked[0].changePercent).toBe(rows[0].changePercent);
  expect(marked[0].todayPnl).toBe(rows[0].todayPnl);
});

it("subscribes the book by instrument id, and covers both tabs", () => {
  const screen = readFileSync(resolve("apps/mobile/app/(tabs)/portfolio.tsx"), "utf8");
  expect(screen).toContain("const feed = useQuoteFeed(instruments, authenticated && instruments.length > 0)");
  expect(screen).toContain("markPositions(savedPositions, feed.quotes, underlyings)");
  expect(screen).toContain("markHoldings(savedHoldings, feed.quotes)");
  expect(screen).toContain("useContractUnderlyings(codes)");
  // The old path subscribed bare broker codes through a cash-only id builder and read the socket only for
  // its connection flag, so the numbers on screen never moved and a holdings tab had nothing to move them.
  expect(screen).not.toContain("useRealtimeQuotes");
  expect(screen).not.toContain("const symbols = positions.map");
});

it("says which price came off the stream instead of leaving the trader to guess", () => {
  const screen = readFileSync(resolve("apps/mobile/app/(tabs)/portfolio.tsx"), "utf8");
  expect(screen).toContain("{ticking ? \"LIVE\" : !authenticated ? \"SIGN IN\" : isConnected ? \"NO TICKS\" : \"CONNECTING\"}");
  expect(screen).toContain("item.live ? styles.streamValue : undefined");
});
