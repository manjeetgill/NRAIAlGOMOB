import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

/**
 * The stock screen carries three bodies under one header: the price snapshot, the chain and the candles. They
 * swap in place instead of pushing a route, so the header keeps naming the stock the trader tapped, Back still
 * means the screen they came from, and no chain or chart read is paid for on a segment nobody is looking at.
 */

const stock = readFileSync(resolve("apps/mobile/app/stock.tsx"), "utf8");
const chain = readFileSync(resolve("apps/mobile/app/(tabs)/option-chain.tsx"), "utf8");
const charts = readFileSync(resolve("apps/mobile/app/terminal-charts.tsx"), "utf8");

it("mounts both bodies from the route files themselves, so there is one copy of each screen", () => {
  expect(stock).toContain('import OptionChainScreen from "./(tabs)/option-chain";');
  expect(stock).toContain('import TerminalChartsScreen from "./terminal-charts";');
});

it("keeps the segment in local state and stops pushing a route for it", () => {
  expect(stock).toContain('const [segment, setSegment] = useState<Segment>("overview")');
  expect(stock).not.toContain("router.push");
});

it("selects the segment from the tab row and marks the body actually on screen", () => {
  expect(stock).toContain('onPress={() => setSegment("overview")}');
  expect(stock).toContain('onPress={() => setSegment("chain")}');
  expect(stock).toContain('onPress={() => setSegment("charts")}');
  expect(stock).toContain('body === "overview" && styles.tabLabelOn]}>Overview</Text>');
  expect(stock).toContain('body === "chain" && styles.tabLabelOn]}>Option Chain</Text>');
  expect(stock).toContain('body === "charts" && styles.tabLabelOn]}>Chart</Text>');
  expect(stock).toContain("styles.tabOn");
  expect(stock).toContain("styles.tabLabelOff");
});

/**
 * The derivatives master answers a second after the screen opens, so the chain can be on screen when the
 * answer says this symbol has no contracts. The tab greys and the snapshot takes the body back; a segment
 * nobody can press is left owning nothing.
 */
it("gives the snapshot back when the master refuses the chain it was showing", () => {
  expect(stock).toContain('const body: Segment = segment === "chain" && !chainTab ? "overview" : segment;');
});

/**
 * Mount-on-entry, unmount-on-exit is what keeps the idle cost at zero: the chain's ladder read and the chart's
 * candle window both run off a query the screen owns, so a body that is not rendered cannot be polling.
 */
it("renders exactly one body and tears the others down", () => {
  expect(stock).toContain('{body === "chain" ? <OptionChainScreen');
  expect(stock).toContain("{body === \"charts\" ? <TerminalChartsScreen");
  expect(stock).toContain('{body === "overview" ? (');
  expect(stock.match(/body === "(chain|charts)" \? </g)).toHaveLength(2);
});

/** The seeds are what the pushed routes used to carry in their query strings, in the same shapes. */
it("hands each body the instrument it opened with as a route", () => {
  expect(stock).toContain("<OptionChainScreen seed={symbol} />");
  expect(stock).toContain('<TerminalChartsScreen seed={`${exchange === "BSE" ? "BSE" : "NSE"}:${symbol}`} />');
});

/**
 * The pushed routes stay for every other entry point - the watchlist, the portfolio, the scanner and the
 * nraialgo:// deep links - so both screens must read a param when no caller handed them a symbol. `seed` is
 * optional and the route wins when it is absent, which is what keeps those callers working untouched.
 */
it("leaves the route params in charge when nothing is seeded", () => {
  expect(chain).toContain("export default function OptionChainScreen({ seed }: { seed?: string })");
  expect(chain).toContain('useLocalSearchParams<{ symbol?: string }>().symbol ?? "").trim().toUpperCase()');
  expect(chain).toContain("const seeded = String(seed ?? \"\").trim().toUpperCase() || routeSeed");
  expect(charts).toContain("export default function TerminalChartsScreen({ seed }: { seed?: string })");
  expect(charts).toContain('String(seed ?? seeded.symbol ?? "").trim().toUpperCase() || DEFAULT_SYMBOL');
});

/** The Buy/Sell box prices the cash instrument, so it stays with the snapshot rather than following the header. */
it("hides the order footer on the two bodies that are not the cash price", () => {
  expect(stock).toMatch(/body === "overview" \? \(\s*<View style=\{styles\.foot\}>/);
  expect(stock).toContain("<BuySheet ticket={ticket} />");
});
