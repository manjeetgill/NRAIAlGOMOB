import { expect, it } from "vitest";
import { markHoldings, markPositions, streamIdFor } from "../../packages/shared/src/api/account-quotes.ts";
import { iciciHoldings, iciciOpenPositions, type IciciAccountPayload } from "../../packages/shared/src/api/hooks.ts";
import type { QuoteTick } from "../../packages/shared/src/api/websocket.ts";

/**
 * The book ticks on the identity prod named, not one the phone assembled.
 *
 * While the vendor feed is streaming and the market is open, the account route blanks `ltp` and
 * `previous_close` on every position row (services/live_valuation.py `quarantine_icici_prices`) because a
 * broker snapshot must not read as market data, and it then stamps each row with the canonical contract it
 * resolved from the broker's own code (services/account_valuation.py: `row['instrument_id']`). The web desk
 * subscribes by that stamp and reads the blanked price back from `broker_reported_ltp`. A phone that does
 * neither gets no tick on the row and no price for it either, so the row drops out of both totals.
 */

const NIFTY_CALL = "instrument:v1:NSE:FO:NIFTY:OPT:2026-11-25:25000:CE";
const NIFTY_CALL_LOWER = "instrument:v1:NSE:FO:NIFTY:OPT:2026-11-25:24500:CE";
const ITC = "instrument:v1:NSE:EQ:ITC:CASH";

const tick = (id: string, price: number, previousClose: number | null = null): QuoteTick => ({
  id,
  price,
  at: Date.parse("2026-11-27T03:45:00Z"),
  fresh: true,
  status: "LIVE",
  source: "vendor",
  broker: "vendor",
  subscriptionId: id,
  previousClose,
});

/** One in-session ICICI position row: no `ltp`, no `previous_close`, and no expiry/strike/right to rebuild from. */
const sessionPosition = {
  stock_code: "NIFTY265225000CE",
  exchange_code: "NSE",
  product_type: "MARGIN",
  action: "BUY",
  quantity: "65",
  average_price: "132.55",
  ltp: null,
  previous_close: null,
  marked_pnl_paise: null,
  pnl: null,
  broker_reported_ltp: "148.30",
  broker_reported_previous_close: "121.10",
  instrument_id: NIFTY_CALL,
};

const sessionHolding = {
  stock_code: "ITC",
  stock_name: "ITC Limited",
  exchange_code: "NSE",
  quantity: "100",
  average_price: "300.00",
  current_market_price: null,
  market_value: null,
  unrealized_holding_pnl: null,
  today_holding_pnl_estimate: null,
  instrument_id: ITC,
};

const book = (positions: unknown[] = [], holdings: unknown[] = []): IciciAccountPayload => ({
  accountId: "ICICI-1",
  asOf: "2026-11-27T03:45:00Z",
  sections: {
    portfoliopositions: { status: "available", rows: positions },
    portfolioholdings: { status: "available", rows: holdings },
  },
});

it("carries the contract identity prod stamped onto each account row", () => {
  expect(iciciOpenPositions(book([sessionPosition]))[0]?.instrumentId).toBe(NIFTY_CALL);
  expect(iciciHoldings(book([], [sessionHolding]))[0]?.instrumentId).toBe(ITC);
});

it("subscribes the stamped id for a row whose parts it was never sent", () => {
  const [row] = iciciOpenPositions(book([sessionPosition]));
  expect(row).toBeDefined();
  // MARGIN is not a contract product and the broker sent no expiry, strike or right, so a rebuilt id reads this
  // option as a share. The server accepts that shape and prices nothing, so the row sat still all session while
  // the same position ticked on the web desk.
  expect(streamIdFor({ ...row, instrumentId: null }, null)).toBe("instrument:v1:NSE:EQ:NIFTY265225000CE:CASH");
  expect(streamIdFor(row)).toBe(NIFTY_CALL);
});

it("keeps rebuilding an id when prod could not name the contract", () => {
  const parts = {
    exchange: "NSE", symbol: "NIFTY265225000CE", product: "OPTIONS",
    expiry: "25-Nov-2026", strike: "25000.00", right: "CE", instrumentId: null,
  };
  expect(streamIdFor(parts, "NIFTY")).toBe(NIFTY_CALL);
});

it("refuses a stamped value that is not a canonical id, so one bad row cannot close the socket", () => {
  expect(streamIdFor({ ...sessionPosition, instrumentId: "NIFTY265225000CE" } as never, null)).toBeNull();
  expect(streamIdFor({ ...sessionPosition, instrumentId: "  " } as never, null)).toBeNull();
});

it("marks a position live off the stamped id and gives both figures", () => {
  const [row] = iciciOpenPositions(book([sessionPosition]));
  const [marked] = markPositions([row], [tick(NIFTY_CALL, 151.00, 121.10)]);
  expect(marked.live).toBe(true);
  expect(marked.markPrice).toBe(151.00);
  expect(marked.unrealizedPnl).toBe(1199.25);
  expect(marked.todayPnl).toBe(1943.50);
});

it("keeps the broker's own mark on a row that has not ticked yet", () => {
  const [row] = iciciOpenPositions(book([sessionPosition]));
  const [marked] = markPositions([row], []);
  expect(marked.live).toBe(false);
  // Without the quarantined copy this row would have no price at all, and the totals would quietly sum 0 of 1.
  expect(marked.markPrice).toBe(148.30);
  expect(marked.unrealizedPnl).toBe(1023.75);
  expect(marked.todayPnl).toBe(1768.00);
});

it("derives a holding's day figure from the tick's previous close", () => {
  const [row] = iciciHoldings(book([], [sessionHolding]));
  const [marked] = markHoldings([row], [tick(ITC, 312.00, 305.00)]);
  expect(marked.live).toBe(true);
  expect(marked.currentPrice).toBe(312.00);
  expect(marketValue(marked)).toBe(31200);
  expect(marked.unrealizedPnl).toBe(1200);
  expect(marked.todayPnl).toBe(700);
});

const marketValue = (row: { marketValue: number | null }): number | null => row.marketValue;

it("counts every row of the book in both totals", () => {
  const rows = iciciOpenPositions(book([sessionPosition, { ...sessionPosition, stock_code: "NIFTY265224500CE", instrument_id: NIFTY_CALL_LOWER }]));
  const marked = markPositions(rows, [tick(NIFTY_CALL, 151.00, 121.10)]);
  // One leg ticking and one not: both still carry a figure, so neither total is a partial sum of the book.
  expect(marked.filter((row) => row.unrealizedPnl !== null)).toHaveLength(2);
  expect(marked.filter((row) => row.todayPnl !== null)).toHaveLength(2);
  expect(marked.reduce((sum, row) => sum + (row.todayPnl ?? 0), 0)).toBe(3711.50);
});
