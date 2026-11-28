import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { offersChainTab } from "../../packages/shared/src/api/stock-overview.ts";

/**
 * The Overview offers an Option Chain tab, and the chain screen then refuses symbols the exchange lists no
 * contracts on. The gate has to be the server's own derivatives master, and it has to fail open: a catalogue
 * read that has not arrived may grey out nothing, because a trader cannot tell that apart from an outage.
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

it("greys the tab for a stock with no contracts listed", () => {
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

// The gate is only worth anything if the screen actually reads it and stops offering the press.
const screen = readFileSync(resolve("apps/mobile/app/stock.tsx"), "utf8");

it("asks the derivatives master the chain screen asks", () => {
  expect(screen).toContain("useChainUnderlyings({ queryKey: queryKeys.optionChain.underlyings() })");
  expect(screen).toContain("offersChainTab(catalogue?.underlyings, symbol)");
});

it("renders the tab as an unpressable label and names the symbol it cannot chain", () => {
  expect(screen).toContain('accessibilityState={{ disabled: true }}');
  expect(screen).toContain("<View style={styles.tab}");
  expect(screen).toContain("No listed options for ${exchange}:${symbol}. Option chains cover F&O stocks and indices.");
});

it("leaves the chart tab pressable, because every listed stock has candles", () => {
  expect(screen).toContain('onPress={() => setSegment("charts")}');
});
