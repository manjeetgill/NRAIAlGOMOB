import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { offersChainTab } from "../../packages/shared/src/api/stock-overview.ts";

/**
 * The Overview used to open an Option Chain tab for every symbol and let the chain screen refuse the ones the
 * exchange lists no contracts on. The gate is the server's own derivatives master, and it fails open: a list
 * that has not arrived may flag nothing, because a trader cannot tell that apart from an outage. What it may
 * never do is take a working screen away, because the master is a separate read that can lag or miss a segment
 * while the chain itself still answers for that symbol.
 */

const CATALOGUE = [
  { name: "NIFTY", lotSize: 25, index: true },
  { name: "TATAMOTORS", lotSize: 700, index: false },
  { name: "BAJFINANCE", lotSize: 125, index: false },
];

it("keeps the tab for an underlying the master lists, stock or index", () => {
  expect(offersChainTab(CATALOGUE, "TATAMOTORS")).toBe(true);
  expect(offersChainTab(CATALOGUE, "NIFTY")).toBe(true);
});

it("greys the tab for a stock the list does not name", () => {
  expect(offersChainTab(CATALOGUE, "MANGLECODE")).toBe(false);
});

it("matches the name the way the chain's own picker does, ignoring case and stray space", () => {
  expect(offersChainTab(CATALOGUE, "tatamotors")).toBe(true);
  expect(offersChainTab([{ name: " BSE:INFY ", lotSize: 80, index: false }], "BSE:INFY")).toBe(true);
});

it("fails open on a list that has not answered", () => {
  // These three are the same screen state seen from the phone: still loading, refused, or empty.
  expect(offersChainTab(undefined, "TATAMOTORS")).toBe(true);
  expect(offersChainTab(null, "TATAMOTORS")).toBe(true);
  expect(offersChainTab([], "TATAMOTORS")).toBe(true);
  expect(offersChainTab(CATALOGUE, "  ")).toBe(true);
});

// The gate is only worth anything if the screen reads it -- and reads it as a hint, not a lock.
const screen = readFileSync(resolve("apps/mobile/app/stock.tsx"), "utf8");

it("asks the derivatives master the chain screen asks", () => {
  expect(screen).toContain("useChainUnderlyings({ queryKey: queryKeys.optionChain.underlyings() })");
  expect(screen).toContain("offersChainTab(catalogue?.underlyings, symbol)");
});

it("keeps the press and says what the list said, not what the symbol lacks", () => {
  expect(screen).toContain('onPress={() => setSegment("chain")}');
  expect(screen).not.toContain("accessibilityState={{ disabled: true }}");
  expect(screen).toContain("Not on the options list we have for ${exchange}:${symbol}. Open the chain to check.");
  expect(screen).not.toContain("No listed options for");
});

it("never takes the chain body back on a list that arrived late", () => {
  // The master answers after the screen, so a lock here once pulled a trader out of a ladder they were reading.
  expect(screen).not.toMatch(/segment === "chain" && !/);
  expect(screen).toContain('{segment === "chain" ? <OptionChainScreen seed={symbol} /> : null}');
});

it("leaves the chart tab pressable, because every listed stock has candles", () => {
  expect(screen).toContain('onPress={() => setSegment("charts")}');
});
