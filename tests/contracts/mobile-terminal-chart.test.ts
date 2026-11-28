import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
  chartFailureReason,
  chartInstrument,
  chartPickerSections,
  chartRequest,
  mergeOlderCandles,
  olderAhead,
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

// The intraday route answers for a session the caller names, and the archive of past NIFTY/BANKNIFTY
// sessions is only ever read when one is asked for. Without this the screen could never show a day that
// the server already held.
it("sends a recorded session to the intraday route and never to the history route", () => {
  expect(chartRequest("NSE:NIFTY", "5m", "2026-11-20")).toEqual({
    path: "/v1/charts/intraday",
    params: { instrument: "NSE:NIFTY", interval: "5m", day: "2026-11-20" },
  });
  expect(chartRequest("NSE:NIFTY", "1d", "2026-11-20").params).not.toHaveProperty("day");
  expect(chartRequest("NSE:NIFTY", "5m", null).params).not.toHaveProperty("day");
  expect(chartRequest("NSE:NIFTY", "5m").params).not.toHaveProperty("day");
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

// Switching charts used to rebuild the WebView, which re-parses the bundled chart library and is the single
// slowest thing on this screen. The ticker now travels as a message and the canvas is kept, so a switch is a
// post plus new bars — and the bars of the chart being replaced are wiped rather than relabelled.
it("switches charts by message instead of rebuilding the canvas", () => {
  const chart = readFileSync(resolve("apps/mobile/src/components/KLineChart.tsx"), "utf8");
  const screen = readFileSync(resolve("apps/mobile/app/terminal-charts.tsx"), "utf8");
  expect(chart).toContain('{ type: "symbol", ticker: symbol }');
  expect(chart).toContain("else if (message.type === 'symbol') requestSymbol(message.ticker);");
  expect(chart).toContain("chart._chartStore._addData([], 'init');");
  expect(chart).toContain("chart.removeOverlay({ groupId: 'user' });");
  expect(chart).toContain("prevLastRef.current = null;");
  // The page itself must stop depending on the symbol, or every switch re-parses the library again.
  expect(chart).not.toContain("${JSON.stringify(symbol)}");
  expect(chart).toContain("}, [resolvedTheme]);");
  // The canvas must not be keyed to the chart it draws: that is what rebuilt the WebView on every switch.
  // (The screen keys its own paged sessions by the chart they belong to, which never reaches the component.)
  expect(chart).not.toContain("chartKey");
  expect(screen).not.toContain("chartKey={");
  expect(screen).toContain("const [canvasUp, setCanvasUp] = useState(false);");
  expect(screen).toContain("if (canvasUp) body = chartNode;");
  expect(screen).toContain("<KLineChart data={chartDataPoints} height={chartHeight} symbol={symbol}");
});

// A stored session is a different thing from today's chart: the ticks are of another day, and the server's
// own list is the only honest source of which sessions exist.
it("charts a recorded session and leaves it alone once chosen", () => {
  const screen = readFileSync(resolve("apps/mobile/app/terminal-charts.tsx"), "utf8");
  expect(screen).toContain('const [day, setDay] = useState<string | null>(null);');
  expect(screen).toContain("const sessionDay = chartData?.day ?? day;");
  expect(screen).toContain("key?.[4] === (day ?? null)");
  expect(screen).toContain("refetchInterval: isDaily || pastPick ? false : 30_000");
  expect(screen).toContain("focused && !lookingBack");
  expect(screen).toContain("const availableDays = chartData?.availableDays;");
  expect(screen).toContain("onPress={() => chooseDay(entry)}");
  expect(screen).toContain("Today's prices are not drawn on an earlier day.");
});

// The intraday route answered one session, so 1h showed about seven candles of today and nothing else, even
// though the server holds NIFTY and BANKNIFTY at one-second resolution for months. The route now names the
// oldest bar it returned and takes it back as `before` to hand over the sessions behind it. A picked session
// is answered whole, so it is never asked for a page too.
it("asks the route for the bars behind what is on screen", () => {
  expect(chartRequest("NSE:NIFTY", "1h", null, 1_764_000_000_000).params).toEqual({
    instrument: "NSE:NIFTY",
    interval: "1h",
    before: 1_764_000_000_000,
  });
  // A daily page is the newest window the archive cut, not the whole record, so the sessions beneath it are
  // asked for the same way. Without this a daily chart stopped at its first bar and said nothing more existed.
  expect(chartRequest("NSE:NIFTY", "1d", null, 1_764_000_000_000).params).toEqual({
    instrument: "NSE:NIFTY",
    interval: "1d",
    before: 1_764_000_000_000,
  });
  expect(chartRequest("NSE:NIFTY", "1h", "2026-11-20").params).not.toHaveProperty("before");
  expect(chartRequest("NSE:NIFTY", "1h", null, 0).params.before).toBe(0);
});

// The two routes say "there is more behind this" in different words: the intraday one names the sessions it
// holds, the daily archive flags that its page was cut. A chart that reads only one of them stops early.
it("reads both routes' words for older bars", () => {
  expect(olderAhead({ hasMore: true })).toBe(true);
  expect(olderAhead({ moreHistory: true })).toBe(true);
  expect(olderAhead({ hasMore: false, moreHistory: true })).toBe(true);
  expect(olderAhead({ hasMore: false, moreHistory: false })).toBe(false);
  expect(olderAhead({ hasMore: true, moreHistory: false })).toBe(true);
  expect(olderAhead(null)).toBe(false);
  expect(olderAhead(undefined)).toBe(false);
});

// KLineChart v10 has no applyNewData in the bundled build, but prepending with the store's own 'forward'
// type leaves the view exactly where the trader put it. A page must go in that way or every scroll back
// would snap the chart to today.
it("prepends older sessions without moving the chart", () => {
  const chart = readFileSync(resolve("apps/mobile/src/components/KLineChart.tsx"), "utf8");
  expect(chart).toContain("else if (message.type === 'history') applyHistory(message);");
  expect(chart).toContain("chart._chartStore._addData(page, 'forward', { forward: moreAhead, backward: false });");
  // Only bars the canvas does not already hold, so a canvas rebuilt by a theme change is refilled once.
  expect(chart).toContain("const page = (request.bars || []).map(toBar).filter(function (item) { return item.timestamp < edge; });");
  expect(chart).toContain("if (list.length && request.nonce !== lastHistoryNonce) {");
  expect(chart).toContain("const list = chart.getDataList() || [];");
  // A chart switched to another instrument has no pages, and must not be asked for any either.
  expect(chart).toContain("pagerOn = false;\n            moreAhead = false;");
});

// Paging is driven by the chart's own left edge, which the library reports on a drag and on a zoom-out, so
// the trader never reaches the end of what was loaded. One page is in flight at a time.
it("asks for the next page as the oldest bar comes into view", () => {
  const chart = readFileSync(resolve("apps/mobile/src/components/KLineChart.tsx"), "utf8");
  expect(chart).toContain("chart.subscribeAction('onVisibleRangeChange', function (range) {");
  expect(chart).toContain("if (!pagerOn || !moreAhead || asking) return false;");
  expect(chart).toContain("return allOnScreen || range.from <= LEAD_BARS;");
  expect(chart).toContain("postApp({ type: 'needMore', before });");
  expect(chart).toContain("asking = true;");
  expect(chart).toContain('message.type === "needMore"');
  expect(chart).toContain("needMoreRef.current?.(message.before);");
});

// Seven hourly bars fit a phone screen with room to spare, so dragging them moves the empty margin and not a
// single candle: no range event, no request, and a chart that looks like it has no history at all. While the
// canvas shows every bar it owns, the fill has to come from the arm itself.
it("fills a chart that is too short to be scrolled", () => {
  const chart = readFileSync(resolve("apps/mobile/src/components/KLineChart.tsx"), "utf8");
  expect(chart).toContain("const allOnScreen = !range || typeof range.from !== 'number' || (range.to - range.from) >= list.length;");
  // The same check runs after a page is applied, so a chart that still cannot scroll asks again.
  expect(chart).toContain("if (needsOlder(chart.getVisibleRange && chart.getVisibleRange())) askForOlder();");
  // and it stops by itself: the record ending clears `more`, which the guard reads first.
  expect(chart).toContain("moreAhead = !!request.more;");
});

// A candle closing while the trader reads an older session used to replace the whole list, which threw the
// paged sessions away and re-anchored the view to today, at the right edge too. Each changed bar now goes
// through the library's single-bar update, which keeps the pages and follows the live bar only at the edge.
it("adds a closed candle to the end instead of redrawing the chart", () => {
  const chart = readFileSync(resolve("apps/mobile/src/components/KLineChart.tsx"), "utf8");
  expect(chart).toContain("if (previous.length > 0 && bars.length >= previous.length &&");
  expect(chart).toContain("for (const bar of bars.slice(previous.length - 1)) chart._chartStore._addData(bar);");
  expect(chart).not.toContain("rightEdgeVisible");
  expect(chart).toContain("chart._chartStore._addData(bars, 'init');");
  // The older pages reach the chart after its candles, or there is no left edge to put them behind.
  expect(chart.indexOf("postSymbol();")).toBeLessThan(chart.indexOf("postHistory();"));
});

// The screen holds the pages, not the chart: the window refetches every 30 seconds and would drop them. A
// chosen session is answered whole, so it is not offered history, and a page fetched for one chart is never
// put on another that the trader switched to mid-scroll. A daily chart pages by default: its first window is
// the newest sessions, and everything the archive holds sits behind them.
it("pages the terminal chart and says what it loaded", () => {
  const screen = readFileSync(resolve("apps/mobile/app/terminal-charts.tsx"), "utf8");
  expect(screen).toContain("const { useTerminalChart, useChainUnderlyings, readOlderCandles } = useApi();");
  expect(screen).toContain("const pagesBack = isDaily || day === null;");
  expect(screen).toContain("await readOlderCandles(symbol, interval, before);");
  expect(screen).toContain('const chartKey = `${symbol}|${interval}|${day ?? ""}`;');
  expect(screen).toContain("const older = paged.key === chartKey ? paged : noPages(chartKey);");
  expect(screen).toContain("if (currentKey.current !== chartKey) return;");
  expect(screen).toContain("history={pagesBack ? older : undefined} onNeedMore={askOlder}");
  // Both the page in hand and the page that came back are read the same way, so neither route's wording
  // silently disables the scroll.
  expect(screen).toContain("const ahead = pagesBack && olderAhead(chartData);");
  expect(screen).toContain("ahead = olderAhead(page);");
  // The trader is told the chart continues behind the first bar, and where the record actually stops — on
  // the daily chart too, whose source line used to end at the window it was served.
  expect(screen).toContain('" · scroll or zoom out for older sessions"');
  expect(screen).toContain('" · the record starts here"');
  expect(screen).toContain('of ${candles.length} sessions` : ""}${pagedLine}`');
  expect(screen).toContain("${sessionCount}${pagedLine}");
});

// Every bar stamp the screen prints is exchange time: the canvas is given the exchange's timezone, and the
// tick clock beside it is read the same way, so one is never a day ahead of the other.
it("prints the exchange's clock, not the phone's", () => {
  const screen = readFileSync(resolve("apps/mobile/app/terminal-charts.tsx"), "utf8");
  const chart = readFileSync(resolve("apps/mobile/src/components/KLineChart.tsx"), "utf8");
  expect(chart).toContain('timezone: "Asia/Kolkata",');
  expect(screen).toContain("const liveAt = lookingBack || live.at === null ? null : istClock(live.at);");
  expect(screen).toContain("new Date(at + IST_OFFSET_MS).toISOString().slice(11, 19)");
  // A label formatter that nothing calls is how a screen ends up with two clocks.
  expect(screen).not.toContain("function axisLabel");
});

// The scan levels belong to the instrument they were drawn for. A symbol switch wipes the bars, so it wipes
// them too, and the screen re-sends what it holds instead of skipping a payload it already posted.
it("drops the previous instrument's scan when the canvas is wiped", () => {
  const chart = readFileSync(resolve("apps/mobile/src/components/KLineChart.tsx"), "utf8");
  const wipe = chart.slice(chart.indexOf("function paintSymbol()"), chart.indexOf("const LEAD_BARS"));
  expect(wipe).toContain("clearScan();");
  expect(wipe).toContain("lastScan = null;");
  expect(chart.slice(chart.indexOf("const postSymbol"), chart.indexOf("const historyPayload"))).toContain(
    "postedScanRef.current = null;",
  );
});

// Two scrolls can land on the same session, and a chart scrolled far back must not grow without bound.
it("keeps one bar per timestamp, oldest first, up to a ceiling", () => {
  const bar = (timestamp: number, close: number) => ({ timestamp, open: close, high: close, low: close, close });
  expect(mergeOlderCandles([bar(30, 1), bar(10, 1)], [bar(20, 1), bar(10, 9)], 10)).toEqual([
    bar(10, 9),
    bar(20, 1),
    bar(30, 1),
  ]);
  expect(mergeOlderCandles([bar(30, 1), bar(20, 1)], [bar(10, 1)], 2)).toEqual([bar(20, 1), bar(30, 1)]);
  expect(mergeOlderCandles([], [], 1_500)).toEqual([]);
});

// The chart used to print an OHLC and volume table over the candles whatever the trader was looking at, plus
// the session's high and low on the price scale, and the library only hides those through `showRule` — an
// early attempt set `tooltip.show`, which this bundle does not read, so nothing changed. The last-price tag is
// the one mark that answers a question at a glance and it stays.
it("draws the readouts only while a finger is on the chart", () => {
  const chart = readFileSync(resolve("apps/mobile/src/components/KLineChart.tsx"), "utf8");
  expect(chart.match(/showRule: 'follow_cross'/g)).toHaveLength(2);
  expect(chart).toContain("tooltip: {\n                      showRule: 'follow_cross',\n                      title: { show: false, template: \"{ticker}\" },");
  expect(chart).toContain("indicator: {\n                    tooltip: { showRule: 'follow_cross', title: { show: false } },");
  expect(chart).toContain("high: { show: false, color: colors.up },");
  expect(chart).toContain("low: { show: false, color: colors.down },");
  expect(chart).toContain("last: { show: true, color: colors.text },");
  // Setting the title back on per symbol is what put the instrument's name back over the candles.
  expect(chart).not.toContain("title: { show: !!pendingSymbol }");
});

// Periods used to be printed as a static string next to a switch, so EMA could only ever be 6, 12, 20 and the
// trader had no way to ask for another. The sheet now edits them, and the numbers sent to the chart are the
// edited ones.
it("edits a study's periods and keeps them on the phone", () => {
  const screen = readFileSync(resolve("apps/mobile/app/terminal-charts.tsx"), "utf8");
  expect(screen).toContain('const STUDY_PARAM_STORAGE = "terminal-chart-study-params";');
  expect(screen).toContain("AsyncStorage.setItem(STUDY_PARAM_STORAGE, JSON.stringify(next))");
  expect(screen).toContain("calcParams: effectiveParams(option, studyParams)");
  expect(screen).toContain("const [editingStudy, setEditingStudy] = useState<string | null>(null);");
  expect(screen).toContain("onPress={applyParam}");
  expect(screen).toContain("onPress={resetParam}");
  // A study with no stored override still gets its numbers sent, or the editor would appear to do nothing.
  expect(screen).toContain("return Array.isArray(stored) && stored.length ? stored : option.calcParams;");
  // The old static string is gone: every entry now declares the periods it really opens with.
  expect(screen).not.toMatch(/params: "/);
  const declared = screen.slice(screen.indexOf("const STUDY_GROUPS"), screen.indexOf("const STUDY_OPTIONS"));
  expect(declared.match(/calcParams: \[/g)?.length).toBe(17);
});

// A study that draws a fixed number of lines cannot draw a fifth one, so typing four numbers into MACD would
// look accepted while the chart still drew three. The editor says what each study takes instead of failing
// quietly, and only the five that regenerate a figure per period may change count.
it("refuses a period list the study cannot draw and says why", () => {
  const screen = readFileSync(resolve("apps/mobile/app/terminal-charts.tsx"), "utf8");
  expect(screen).toContain("if (params.length > option.calcParams.length || (!option.variable && params.length !== option.calcParams.length)) {");
  expect(screen).toContain('return { params: [], error: paramRule(option) };');
  expect(screen).toContain('"Every period has to be a number above zero."');
  expect(screen).toContain("if (parsed.error) {");
  const variable = screen
    .slice(screen.indexOf("const STUDY_GROUPS"), screen.indexOf("const STUDY_OPTIONS"))
    .split("\n")
    .filter((line) => line.includes("variable: true"))
    .map((line) => /key: "(\w+)"/.exec(line)?.[1]);
  expect(variable).toEqual(["ma", "ema", "vol", "rsi", "wr"]);
});

// SMA and Supertrend were simply not offered: SMA is in the bundled library and nobody listed it, and
// Supertrend is not bundled at all, so it is registered the way ATR already is.
it("offers SMA and Supertrend over the candles", () => {
  const screen = readFileSync(resolve("apps/mobile/app/terminal-charts.tsx"), "utf8");
  const candlePane = screen.slice(screen.indexOf('title: "Over the candles"'), screen.indexOf('title: "In their own pane"'));
  expect(candlePane).toContain('{ key: "sma", name: "SMA"');
  expect(candlePane).toContain('{ key: "st", name: "SUPER_TREND", abbr: "ST"');
  const chart = readFileSync(resolve("apps/mobile/src/components/KLineChart.tsx"), "utf8");
  expect(chart).toContain("registerSuperTrend(colors);");
  expect(chart).toContain("name: 'SUPER_TREND'");
  expect(chart).toContain("{ key: 'upTrend', title: 'ST: ', type: 'line'");
  expect(chart).toContain("{ key: 'downTrend', title: 'ST: ', type: 'line'");
});

/**
 * The Supertrend arithmetic runs here exactly as the WebView runs it: the calc is lifted out of the page
 * script rather than rewritten, so this is the shipped code being checked. The compiled slice comes from this
 * repository's own source file, read at test time — nothing from outside the repo reaches it.
 */
function superTrendCalc() {
  const chart = readFileSync(resolve("apps/mobile/src/components/KLineChart.tsx"), "utf8");
  const start = chart.indexOf("calc: function (list, indicator)", chart.indexOf("name: 'SUPER_TREND'"));
  let depth = 0;
  let i = chart.indexOf("{", start);
  for (; i < chart.length; i++) {
    if (chart[i] === "{") depth += 1;
    else if (chart[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return new Function(`return function (list, indicator) ${chart.slice(chart.indexOf("{", start), i + 1)}`)();
}

const ST_BARS = (closes: number[]) =>
  closes.map((close, index) => ({
    timestamp: index,
    open: close,
    high: close + 12,
    low: close - 12,
    close,
    volume: 1,
  }));

it("walks Supertrend below a rising market and above a falling one", () => {
  const calc = superTrendCalc();
  const rising = calc(ST_BARS(Array.from({ length: 30 }, (_, i) => 1000 + i * 10)), { calcParams: [10, 3] });
  const printed = rising.filter((row: Record<string, number>) => row.upTrend !== undefined || row.downTrend !== undefined);
  expect(printed.length).toBe(21);
  expect(printed.every((row: Record<string, number>) => row.upTrend !== undefined && row.downTrend === undefined)).toBe(true);
  // Below price, and never loosening once price has moved away from it.
  expect(printed.every((row: Record<string, number>, i: number) => row.upTrend > (i ? printed[i - 1].upTrend : 0))).toBe(true);

  const falling = calc(ST_BARS(Array.from({ length: 30 }, (_, i) => 2000 - i * 10)), { calcParams: [10, 3] });
  const down = falling.filter((row: Record<string, number>) => row.downTrend !== undefined);
  expect(down.length).toBeGreaterThan(0);
  expect(down.every((row: Record<string, number>, i: number) => row.downTrend < (i ? down[i - 1].downTrend : Infinity))).toBe(true);
});

it("flips Supertrend only when a close loses the band it printed", () => {
  const calc = superTrendCalc();
  // Up, then a break deep enough to close under the lower band, then a recovery back over the upper one.
  const closes = [
    ...Array.from({ length: 16 }, (_, i) => 1000 + i * 12),
    ...Array.from({ length: 8 }, (_, i) => 1180 - i * 55),
    ...Array.from({ length: 10 }, (_, i) => 785 + i * 60),
  ];
  const rows = calc(ST_BARS(closes), { calcParams: [10, 3] });
  const trend = rows.map((row: Record<string, number>) => (row.upTrend !== undefined ? 1 : row.downTrend !== undefined ? -1 : 0));
  const flips = trend.filter((value, i) => value !== 0 && trend[i - 1] !== 0 && value !== trend[i - 1]).length;
  expect(flips).toBe(2);
  expect(trend.slice(0, 9).every((value) => value === 0)).toBe(true);
  expect(trend.filter((value) => value === 1).length).toBeGreaterThan(trend.filter((value) => value === -1).length);
});

it("keeps Supertrend off the candles until the period is warm", () => {
  const calc = superTrendCalc();
  const bars = ST_BARS(Array.from({ length: 12 }, (_, i) => 500 + i));
  const rows = calc(bars, { calcParams: [10, 3] });
  // Nothing is printed before the true-range average exists, so the line starts rather than inventing a band.
  expect(rows.slice(0, 9).every((row: Record<string, number>) => Object.keys(row).length === 0)).toBe(true);
  // The first printed band is the mid of that session less three times the average range over the period.
  const averageRange = bars.slice(0, 10).reduce((sum, bar) => sum + (bar.high - bar.low), 0) / 10;
  expect(rows[9].upTrend).toBeCloseTo((bars[9].high + bars[9].low) / 2 - 3 * averageRange, 6);
});


