import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
  iciciAccountSection,
  iciciHoldings,
  iciciOpenPositions,
  type IciciAccountPayload,
} from "../../packages/shared/src/api/hooks.ts";

// Prod answers a cold account with HTTP 202 + {"detail":...}. The client treats 2xx as success, so
// the only thing a screen can branch on is this body. These cases pin the honest states.
const holdingsSection = (rows: unknown[], extra: Record<string, unknown> = {}) =>
  ({ sections: { portfolioholdings: { status: "available", rows, asOf: "2026-11-21T15:30:00+05:30", ...extra } } }) as IciciAccountPayload;

it("reports a cold first snapshot as cold, not as an empty book", () => {
  const cold = { detail: "Fetching the first broker snapshot." } as IciciAccountPayload;
  expect(iciciAccountSection(cold, "portfolioholdings")).toEqual({
    kind: "cold",
    reason: "Fetching the first broker snapshot.",
  });
  expect(iciciAccountSection(cold, "portfoliopositions").kind).toBe("cold");
  expect(iciciHoldings(cold)).toEqual([]);
});

it("surfaces the server's own reason for a degraded section instead of a blank", () => {
  const payload = {
    sections: { portfolioholdings: { status: "degraded", rows: [], reason: "ICICI returned a partial holding list." } },
  } as unknown as IciciAccountPayload;
  expect(iciciAccountSection(payload, "portfolioholdings")).toEqual({
    kind: "degraded",
    reason: "ICICI returned a partial holding list.",
  });
});

it("names an unavailable section and falls back to the account reason", () => {
  const payload = {
    staleReason: "Broker session expired.",
    sections: { portfoliopositions: { status: "unavailable", rows: null } },
  } as unknown as IciciAccountPayload;
  expect(iciciAccountSection(payload, "portfoliopositions")).toEqual({
    kind: "unavailable",
    reason: "Broker session expired.",
  });
});

it("flags a stale snapshot with the server's staleReason", () => {
  const payload = {
    stale: true,
    staleReason: "Snapshot older than the last broker read.",
    sections: { portfolioholdings: { status: "available", rows: [] } },
  } as unknown as IciciAccountPayload;
  expect(iciciAccountSection(payload, "portfolioholdings")).toEqual({
    kind: "stale",
    reason: "Snapshot older than the last broker read.",
  });
});

it("calls a live snapshot ready and a missing payload unavailable", () => {
  const fresh = {
    sections: { portfolioholdings: { status: "available", rows: [{ stock_code: "ITC", quantity: "10" }] } },
  } as unknown as IciciAccountPayload;
  expect(iciciAccountSection(fresh, "portfolioholdings")).toEqual({ kind: "ready", reason: null });
  expect(iciciAccountSection(null, "portfolioholdings").kind).toBe("unavailable");
});

it("maps an empty holding list to an empty array, not a zero portfolio", () => {
  expect(iciciHoldings(holdingsSection([]))).toEqual([]);
});

it("keeps a broker price the broker did not give as null", () => {
  const rows = [
    { stock_code: "BLANK", quantity: "1", current_market_price: "" },
    { stock_code: "ZERO", quantity: "1", current_market_price: "0" },
    { stock_code: "NEG", quantity: "1", current_market_price: "-2.5" },
    { stock_code: "MISSING", quantity: "1" },
  ];
  const bySymbol = Object.fromEntries(iciciHoldings(holdingsSection(rows)).map(h => [h.symbol, h]));
  expect(bySymbol.BLANK.currentPrice).toBeNull();
  expect(bySymbol.ZERO.currentPrice).toBeNull();
  expect(bySymbol.NEG.currentPrice).toBeNull();
  expect(bySymbol.MISSING.currentPrice).toBeNull();
});

it("parses comma-formatted broker strings", () => {
  const [holding] = iciciHoldings(holdingsSection([
    { stock_code: "TATAMOTRY", quantity: "1,200", average_price: "1,050.25", market_value: "12,60,300.00" },
  ]));
  expect(holding.quantity).toBe(1200);
  expect(holding.averagePrice).toBe(1050.25);
  expect(holding.marketValue).toBe(1260300);
});

it("drops a flat row before its coerced zeros can report a rupee portfolio", () => {
  const holdings = iciciHoldings(holdingsSection([
    { stock_code: "FLAT", quantity: "0", current_market_price: "0", market_value: "0", unrealized_holding_pnl: "0" },
    { stock_code: "LIVE", quantity: "5" },
  ]));
  expect(holdings.map(h => h.symbol)).toEqual(["LIVE"]);
});

it("reads holdings in rupees, which prod already converted from paise", () => {
  const [holding] = iciciHoldings(holdingsSection([
    {
      stock_code: "ITC",
      quantity: "100",
      investment_value: "27920.00",
      market_value: "28100.50",
      unrealized_holding_pnl: "180.50",
      today_holding_pnl_estimate: "12.25",
      booked_profit_loss: "-40.00",
    },
  ]));
  expect(holding.investedValue).toBe(27920);
  expect(holding.marketValue).toBe(28100.5);
  expect(holding.unrealizedPnl).toBe(180.5);
  expect(holding.todayPnl).toBe(12.25);
  expect(holding.bookedPnl).toBe(-40);
});

it("divides position P&L, which prod sends in paise", () => {
  const [position] = iciciOpenPositions({
    sections: { portfoliopositions: { status: "available", rows: [{ stock_code: "NIFTY24000CE", quantity: "25", action: "BUY", marked_pnl_paise: "-12500" }] } },
  } as unknown as IciciAccountPayload);
  expect(position.unrealizedPnl).toBe(-125);
});

it("never feeds the holdings list from demat identity rows", () => {
  const payload = {
    sections: {
      dematholdings: { status: "available", rows: [{ scrip_code: "XXXISIN", quantity: 999 }] },
      portfolioholdings: { status: "available", rows: [{ stock_code: "ITC", quantity: "10" }] },
    },
  } as unknown as IciciAccountPayload;
  expect(iciciHoldings(payload).map(h => h.symbol)).toEqual(["ITC"]);
});

it("reads both tabs from one account route so they cannot disagree for the same instant", () => {
  const source = readFileSync(
    resolve("packages/shared/src/api/hooks.ts"),
    "utf8",
  );
  const accountPath = "/v1/broker-auth/icici/account";
  const openPositions = source.slice(source.indexOf("const useOpenPositions"), source.indexOf("const useIciciAccount"));
  const account = source.slice(source.indexOf("const useIciciAccount"), source.indexOf("const useClosedPositions"));
  expect(openPositions).toContain(accountPath);
  expect(account).toContain(accountPath);
  expect(openPositions).not.toContain("/v1/hub/positions");
});
