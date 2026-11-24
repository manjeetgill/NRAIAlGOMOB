import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { evidenceRequest, type ScannerEvidence } from "../../packages/shared/src/api/hooks.ts";
import {
  asMs,
  evidenceCandles,
  scanMarkers,
  scanOverlays,
  scanPanes,
  SCAN_COLORS,
} from "../../apps/mobile/src/utils/scan-chart.ts";

/**
 * Clicking a scanner row opens the web scanner's chart: the saved scan's own candles with the level the rule
 * tested, the tolerance band around it, the studies the run stored and the HM entries it recorded.
 *
 * Every case below is a promise about served data. The evidence route files a level, an origin and a series
 * only for the scan's owner, so a member's copy of the same scan is a shorter payload — and a chart that
 * assumed those fields exist either throws or draws a level nobody measured.
 */

const DAY = 86_400_000;
const D1 = Date.UTC(2026, 10, 18);
const D2 = D1 + DAY;
const D3 = D2 + DAY;

const bar = (timestamp: number, close: number) => ({
  timestamp, open: close - 1, high: close + 2, low: close - 2, close, volume: 1_000,
});

/** A scan read by its owner: candles, the level, the band, the series the rule ran on and its pivots. */
function ownerEvidence(over: Partial<ScannerEvidence> = {}): ScannerEvidence {
  return {
    source: "technical-scanner",
    session: "2026-11-20",
    timeframe: "1d",
    candles: [bar(D1, 100), bar(D2, 105), bar(D3, 118)],
    events: [{ kind: "breakout", timestamp: D3, close: 118, level: 115, tolerance: 1.5, origin: D1 }],
    indicatorSeries: [
      { timestamp: D2, rsi14: 61.5, support: 98, resistance: 112, atr: 2.4, volumeMean20: 900 },
      { timestamp: D3, rsi14: 68.2, support: 100, resistance: 115, atr: 2.6, volumeMean20: 940 },
    ],
    context: { pivots: { high: { price: 121, originTimestamp: D1, confirmedAt: D2 }, low: null } },
    signalCompletedAt: D3,
    ...over,
  };
}

/** A member's copy of the same scan, stripped exactly the way `result_for(result, False)` strips it. */
const memberEvidence: ScannerEvidence = {
  source: "technical-scanner",
  session: "2026-11-20",
  timeframe: "1d",
  candles: [bar(D1, 100), bar(D2, 105), bar(D3, 118)],
  events: [{ kind: "breakout", timestamp: D3, close: 118 }],
};

it("charts the window the scan saved and drops a candle with no price", () => {
  const archived = ownerEvidence({ chartCandles: [bar(D1 - DAY * 2, 92), bar(D1 - DAY, 95)] });
  expect(evidenceCandles(archived).map((b) => b.timestamp)).toEqual([D1 - DAY * 2, D1 - DAY]);
  const torn: ScannerEvidence = { events: [], candles: [bar(D1, 100), { ...bar(D2, 105), close: NaN }] };
  expect(evidenceCandles(torn)).toHaveLength(1);
  expect(evidenceCandles(undefined)).toEqual([]);
});

it("draws the level, its band, the original break and the candle the scan finished on", () => {
  const overlays = scanOverlays(ownerEvidence());
  const flat = overlays.filter((o) => o.name === "horizontalStraightLine");
  expect(flat.map((o) => o.points[0].value)).toEqual([115, 113.5, 116.5]);
  expect(flat[0].color).toBe(SCAN_COLORS.level);
  expect(flat.slice(1).every((o) => o.color === SCAN_COLORS.band)).toBe(true);
  expect(overlays.filter((o) => o.name === "verticalStraightLine").map((o) => o.points[0].timestamp)).toEqual([D1, D3]);
  expect(overlays.find((o) => o.name === "rayLine")?.points)
    .toEqual([{ timestamp: D2, value: 121 }, { timestamp: D3, value: 121 }]);
});

it("draws a pivot from the candle that confirmed it, never before", () => {
  const afterTheTape = ownerEvidence({ context: { pivots: { high: { price: 121, originTimestamp: D1, confirmedAt: D3 } } } });
  expect(scanOverlays(afterTheTape).some((o) => o.name === "rayLine")).toBe(false);
});

it("leaves a level the server never filed off the chart instead of inventing one", () => {
  expect(scanOverlays(memberEvidence)).toEqual([
    { name: "verticalStraightLine", points: [{ timestamp: D3 }], color: SCAN_COLORS.scanCandle },
  ]);
  expect(scanPanes(memberEvidence).map((p) => p.id)).toEqual(["scan-volume"]);
});

it("files the range, RSI, ATR and volume the run stored", () => {
  const panes = scanPanes(ownerEvidence());
  expect(panes.map((p) => p.id)).toEqual(["scan-range", "scan-rsi", "scan-atr", "scan-volume"]);
  expect(panes[0].paneId).toBe("candle_pane");
  expect(panes[0].lines.map((l) => l.key)).toEqual(["support", "resistance"]);
  expect(panes[1].lines[0].points[D3]).toBe(68.2);
  expect(panes[1].minValue).toBe(0);
  expect(panes[1].maxValue).toBe(100);
  expect(panes[3].lines.map((l) => l.key)).toEqual(["volume", "volumeMean20"]);
  expect(panes[3].lines[1].points[D3]).toBe(940);
});

it("switches to the supertrend recipe and marks the entries for an HM signal", () => {
  const hm: ScannerEvidence = {
    session: "2026-11-20",
    timeframe: "1d",
    candles: [bar(D1, 100), bar(D2, 104)],
    events: [{ kind: "hm_rsi_supertrend_buy", timestamp: D2, close: 104 }],
    hmSeries: [
      { timestamp: D1, supertrend: 99, direction: 1, ema: 100.5, wma: 101, rsi: 45 },
      { timestamp: D2, supertrend: 101, direction: -1, ema: 102, wma: 101.5, rsi: 58 },
    ],
    hmSignals: [{ timestamp: D2, kind: "crossover", actions: ["buy_entry", "sell_exit"] }],
  };
  expect(scanOverlays(hm)).toEqual([]);
  expect(scanMarkers(hm)).toEqual([
    { timestamp: D2, value: 102, text: "BUY ENTRY", color: SCAN_COLORS.buy },
    { timestamp: D2, value: 106, text: "SELL EXIT", color: SCAN_COLORS.buy },
  ]);
  const panes = scanPanes(hm);
  expect(panes.map((p) => p.id)).toEqual(["scan-hm-supertrend", "scan-hm-rsi", "scan-volume"]);
  expect(panes[0].lines.map((l) => l.key)).toEqual(["stUp", "stDown"]);
  expect(panes[0].lines[0].points[D2]).toBe(101);
});

it("pins a marker on its own candle and ignores one the scan never filed", () => {
  const hm: ScannerEvidence = { events: [], candles: [bar(D2, 104)], hmSignals: [{ timestamp: D3, kind: "crossover", actions: ["buy_entry"] }] };
  expect(scanMarkers(hm)).toEqual([]);
});

it("follows the kind on the row that was tapped, not whichever event the scan listed first", () => {
  const mixed = ownerEvidence({ events: [{ kind: "breakout", timestamp: D3, level: 115 }, { kind: "hm_rsi_supertrend_buy", timestamp: D3 }] });
  expect(scanOverlays(mixed).length).toBeGreaterThan(0);
  expect(scanOverlays(mixed, "hm_rsi_supertrend_buy")).toEqual([]);
});

it("accepts a candle stamp as a number or as text and rejects everything else", () => {
  expect(asMs(D3)).toBe(D3);
  expect(asMs(String(D3))).toBe(D3);
  expect(asMs("2026-11-20T00:00:00.000Z")).toBe(Date.UTC(2026, 10, 20));
  expect(asMs("")).toBeNull();
  expect(asMs(0)).toBeNull();
  expect(asMs("yesterday")).toBeNull();
  expect(asMs(null)).toBeNull();
});

// ===== THE READ ON THE WIRE =====

it("asks the evidence route for the exact saved scan", () => {
  expect(evidenceRequest({ instrument: "NSE:RELIANCE", session: "2026-11-20", timeframe: "1d" })).toEqual({
    path: "/v1/technical-events/evidence?instrument=NSE%3ARELIANCE&session=2026-11-20&timeframe=1d",
    timeframe: "1d",
  });
  expect(evidenceRequest({ instrument: "NIFTY", session: "weekly", timeframe: "1w", runId: "7" }).path)
    .toContain("&timeframe=1w&run_id=7");
});

it("asks a period the route cannot store a scan under as daily rather than sending it", () => {
  // `timeframe` is a six-word Literal server-side; anything else answers 422 and the chart never draws.
  for (const bad of ["5m", "1h ", "", "day", "1W"]) {
    expect(evidenceRequest({ instrument: "X", session: "s", timeframe: bad })).toEqual({
      path: "/v1/technical-events/evidence?instrument=X&session=s&timeframe=1d",
      timeframe: "1d",
    });
  }
  for (const good of ["1d", "1w", "1M", "1h", "30m", "15m"]) {
    expect(evidenceRequest({ instrument: "X", session: "s", timeframe: good }).timeframe).toBe(good);
  }
});

// ===== THE SCREENS AND THE WEBVIEW =====

const scanner = readFileSync(resolve("apps/mobile/app/scanner.tsx"), "utf8");
const chart = readFileSync(resolve("apps/mobile/app/scanner-chart.tsx"), "utf8");
const webView = readFileSync(resolve("apps/mobile/src/components/KLineChart.tsx"), "utf8");

it("carries the saved scan's identity from the row to the chart", () => {
  expect(scanner).toContain("router.push(`/scanner-chart?instrument=${encodeURIComponent(signal.instrument)}`");
  expect(scanner).toContain('&session=${encodeURIComponent(signal.session)}&timeframe=${encodeURIComponent(signal.timeframe || "1d")}');
  expect(scanner).toContain('&kind=${encodeURIComponent(signal.kind)}');
  expect(scanner).toContain('&run_id=${encodeURIComponent(signal.runId)}');
  expect(scanner).toContain('runId: item.run_id ?? ""');
  /** The cards keep the figures they already showed, so the tap only adds a destination. */
  expect(scanner).toContain("Candle close");
  expect(scanner).toContain("Timeframe");
});

it("draws the evidence it was served and says what it was not served", () => {
  expect(chart).toContain("useScannerEvidence(identity)");
  expect(chart).toContain("evidenceCandles(evidence)");
  expect(chart).toContain("scanOverlays(evidence, focusKind || undefined)");
  expect(chart).toContain("scanPanes(evidence, focusKind || undefined)");
  expect(chart).toContain("scanMarkers(evidence)");
  /** The generic MA/VOL pair belongs to the terminal, not to a chart that names its own studies. */
  expect(chart).toContain("defaultIndicators={false}");
  expect(chart).toContain('"The server holds no candle history for this saved scan, so there is nothing to chart."');
  expect(chart).toContain("The saved scan filed no candles, so the chart has nothing to draw.");
  expect(chart).toContain("the server files only for its owner");
  expect(chart).toContain("not an executed trade");
});

it("paints a scan's studies over live candles without losing them to the next tick", () => {
  expect(webView).toContain("else if (message.type === 'scan') applyScan(message.scan);");
  expect(webView).toContain("if (lastScan) applyScan(lastScan);");
  expect(webView).toContain("chart.removeOverlay({ groupId: 'scan' })");
  expect(webView).toContain("chart.createIndicator(spec, true)");
  expect(webView).toContain("groupId: 'scan', lock: true");
  expect(webView).toContain("chart.setPaneOptions({ id: pane.paneId");
  /** An unchanged refetch of the same scan must not repaint every level. */
  expect(webView).toContain("postedScanRef.current === scanPayload");
});

it("keeps the terminal chart's own default studies working", () => {
  expect(webView).toContain("defaultIndicators = true");
  expect(webView).toContain("chart.createIndicator('MA', false, { id: 'candle_pane' })");
  const terminal = readFileSync(resolve("apps/mobile/app/terminal-charts.tsx"), "utf8");
  expect(terminal).toContain("<KLineChart");
  expect(terminal).not.toContain("defaultIndicators={false}");
});
