import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
  chartFailureReason,
  chartInstrument,
  chartPickerSections,
  chartRequest,
} from "../../packages/shared/src/api/hooks.ts";

// Prod splits candles across two routes and takes the instrument as an exchange-prefixed key. The
// mobile screen used to ask the intraday route for a bare symbol, which is a 422 for every interval,
// so the chart could never draw. These cases pin the request that goes on the wire.
it("sends daily and weekly candles to the history route", () => {
  expect(chartRequest("NSE:NIFTY", "1d")).toEqual({
    path: "/v1/charts/history",
    params: { instrument: "NSE:NIFTY", interval: "1d" },
  });
  expect(chartRequest("NSE:NIFTY", "1w").path).toBe("/v1/charts/history");
  expect(chartRequest("NSE:NIFTY", "1M").path).toBe("/v1/charts/history");
});

it("sends minute and hour candles to the intraday route", () => {
  for (const interval of ["1m", "5m", "15m", "30m", "1h"]) {
    expect(chartRequest("NSE:RELIANCE", interval).path).toBe("/v1/charts/intraday");
  }
});

it("names the parameter the route declares, never the one the screen holds", () => {
  const request = chartRequest(chartInstrument("NIFTY"), "1d");
  expect(Object.keys(request.params)).toEqual(["instrument", "interval"]);
  expect(request.params).not.toHaveProperty("symbol");
});

it("prefixes a bare symbol with the exchange that actually lists it", () => {
  expect(chartInstrument("NIFTY")).toBe("NSE:NIFTY");
  expect(chartInstrument("reliance")).toBe("NSE:RELIANCE");
  expect(chartInstrument("  HDFCBANK ")).toBe("NSE:HDFCBANK");
  expect(chartInstrument("SENSEX")).toBe("BSE:SENSEX");
  expect(chartInstrument("BANKEX")).toBe("BSE:BANKEX");
});

it("leaves an already-prefixed key alone and answers nothing for a blank", () => {
  expect(chartInstrument("NSE:NIFTY")).toBe("NSE:NIFTY");
  expect(chartInstrument("NFO:NIFTY26NOV24000CE")).toBe("NFO:NIFTY26NOV24000CE");
  expect(chartInstrument("")).toBe("");
  expect(chartInstrument("   ")).toBe("");
});

it("shows prod's own reason instead of a generic failure", () => {
  const refusal = Object.assign(new Error("HTTP 503: Service Unavailable"), {
    status: 503,
    details: { detail: "Broker has no completed candles for today." },
  });
  expect(chartFailureReason(refusal)).toBe("Broker has no completed candles for today.");
  const wrongVenue = Object.assign(new Error("HTTP 422: Unprocessable Content"), {
    status: 422,
    details: { detail: "Only NSE cash symbols and indices are supported for intraday charts." },
  });
  expect(chartFailureReason(wrongVenue)).toContain("Only NSE cash symbols");
});

it("falls back to plain words when the server gave no reason", () => {
  expect(chartFailureReason(new Error("HTTP 500: Internal Server Error"))).toBe("The chart could not be loaded.");
  expect(chartFailureReason(undefined)).toBe("The chart could not be loaded.");
  expect(chartFailureReason(new Error("Network request failed"))).toBe("Network request failed");
});

it("opens the screen on daily candles for NIFTY", () => {
  const screen = readFileSync(resolve("apps/mobile/app/terminal-charts.tsx"), "utf8");
  expect(screen).toContain('const DEFAULT_SYMBOL = "NIFTY"');
  expect(screen).toContain('const DEFAULT_INTERVAL: IntervalId = "1d"');
  expect(screen).toContain("useState<IntervalId>(DEFAULT_INTERVAL)");
});

it("takes the picker list from the derivatives master, not a hardcoded array", () => {
  const screen = readFileSync(resolve("apps/mobile/app/terminal-charts.tsx"), "utf8");
  expect(screen).toContain("useChainUnderlyings()");
  expect(screen).not.toContain("WATCHLIST_SYMBOLS");
  expect(screen).not.toMatch(/data={\["/);
});

it("keeps one interval strip and no control that does nothing", () => {
  const screen = readFileSync(resolve("apps/mobile/app/terminal-charts.tsx"), "utf8");
  expect(screen.match(/INTERVALS\.map/g)).toHaveLength(1);
  expect(screen).not.toContain("onPress={() => {}}");
});

// The picker lists every index and F&O stock the derivatives master knows, so the grouping and the
// search box are the only thing between the trader and a long, unreadable list.
const UNDERLYINGS = [
  { name: "NIFTY", lotSize: 65, index: true },
  { name: "SENSEX", lotSize: 20, index: true },
  { name: "RELIANCE", lotSize: 1, index: false },
  { name: "HDFCBANK", lotSize: 1, index: false },
];

const titlesAndRows = (search: string) =>
  chartPickerSections(UNDERLYINGS, search).map((section) => [section.title, section.data.map((item) => item.name)]);

it("lists indices first and F&O stocks second", () => {
  expect(titlesAndRows("")).toEqual([
    ["Indices", ["NIFTY", "SENSEX"]],
    ["F&O stocks", ["RELIANCE", "HDFCBANK"]],
  ]);
});

it("narrows both groups by what the trader typed, ignoring case and spacing", () => {
  expect(titlesAndRows("  nifty ")).toEqual([["Indices", ["NIFTY"]]]);
  expect(titlesAndRows("bank")).toEqual([["F&O stocks", ["HDFCBANK"]]]);
});

it("drops a group with no rows instead of showing a heading over nothing", () => {
  expect(chartPickerSections(UNDERLYINGS, "reliance").map((section) => section.title)).toEqual(["F&O stocks"]);
  expect(chartPickerSections(UNDERLYINGS, "TATASTEEL")).toEqual([]);
  expect(chartPickerSections([], "")).toEqual([]);
});

it("commodity names never appear because the master only lists NSE and BSE derivatives", () => {
  expect(chartPickerSections(UNDERLYINGS, "OIL")).toEqual([]);
  expect(chartPickerSections(UNDERLYINGS, "GOLD")).toEqual([]);
});

it("wires the screen through the shared sectioning", () => {
  const screen = readFileSync(resolve("apps/mobile/app/terminal-charts.tsx"), "utf8");
  expect(screen).toContain("chartPickerSections(allUnderlyings, search)");
});
