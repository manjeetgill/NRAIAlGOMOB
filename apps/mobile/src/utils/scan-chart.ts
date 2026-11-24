/**
 * The web scanner's chart recipe, written as data the mobile WebView can draw.
 *
 * `frontend/nextjs/app/components/alerts/scan-chart-model.ts` builds klinecharts overlay and indicator
 * objects directly; a WebView cannot be sent a function, so the same rules are expressed here as
 * timestamp→value tables and colour choices, and the WebView rebuilds the studies from them.
 *
 * Every study comes from fields the evidence route files for the owner only. When they are absent — a
 * member's copy of the same scan is stripped server-side — the list comes back empty and the chart shows
 * the saved candles alone, which is what the trader is actually entitled to see.
 */

import type { Candle, ScannerEvidence } from "@nraialgo/shared/api";

/** One study line: the title shown in the legend and the candles it was computed on. */
export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  points: Record<number, number>;
}

export interface ChartPane {
  id: string;
  /** `candle_pane` draws over the candles; any other id opens its own pane below them. */
  paneId: string;
  /** The registered study the pane borrows its axis behaviour from. */
  name: "MA" | "RSI" | "VOL";
  title: string;
  lines: ChartSeries[];
  minValue?: number;
  maxValue?: number;
  height?: number;
}

export interface ChartOverlay {
  name: "horizontalStraightLine" | "verticalStraightLine" | "rayLine";
  points: { timestamp?: number; value?: number }[];
  color: string;
}

export interface ChartMarker {
  timestamp: number;
  value: number;
  text: string;
  color: string;
}

/** The web dialog's own palette, so the same level reads the same colour on both surfaces. */
export const SCAN_COLORS = {
  level: "#d97706",
  band: "#64748b",
  origin: "#a855f7",
  scanCandle: "#d97706",
  pivot: "#0ea5e9",
  support: "#38bdf8",
  resistance: "#f59e0b",
  rsi: "#a855f7",
  atr: "#22d3ee",
  volume: "#94a3b8",
  volumeMean: "#f59e0b",
  supertrendUp: "#22c55e",
  supertrendDown: "#ef4444",
  ema: "#22c55e",
  wma: "#ef4444",
  buy: "#22c55e",
  sell: "#ef4444",
};

/** A scan can be filed as an epoch number or as its text; only a real instant may pick out a candle. */
export function asMs(value: number | string | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const ms = Number(trimmed) || Date.parse(trimmed);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  return null;
}

export function isHmKind(kind?: string): boolean {
  return kind === "hm_rsi_supertrend_buy" || kind === "hm_rsi_supertrend_sell";
}

/**
 * The window to draw: the saved scan extended with older archived history when the server attached it,
 * otherwise the candles the rule itself ran on. A candle missing a price is dropped rather than plotted
 * as a zero, because the archive can carry a session the broker never printed.
 */
export function evidenceCandles(evidence?: ScannerEvidence): Candle[] {
  const saved = evidence?.chartCandles?.length ? evidence.chartCandles : evidence?.candles ?? [];
  return saved.filter((bar) => bar
    && Number.isFinite(bar.timestamp)
    && Number.isFinite(bar.open) && Number.isFinite(bar.high)
    && Number.isFinite(bar.low) && Number.isFinite(bar.close));
}

const line = (key: string, label: string, color: string, points: Record<number, number>) =>
  Object.keys(points).length ? [{ key, label, color, points }] : [];

/** Timestamp→value table from one field of a served series, skipping the rows the scan left blank. */
function seriesOf<T extends { timestamp: number }>(rows: T[], pick: (row: T) => unknown): Record<number, number> {
  const points: Record<number, number> = {};
  for (const row of rows) {
    const value = pick(row);
    if (typeof value === "number" && Number.isFinite(value) && Number.isFinite(row.timestamp)) points[row.timestamp] = value;
  }
  return points;
}

/**
 * The rule as lines: the level it was tested against, the tolerance band around it, the earlier break a
 * retest is anchored to, the confirmed pivots and the candle the scan finished on.
 */
export function scanOverlays(evidence?: ScannerEvidence, focusKind?: string): ChartOverlay[] {
  const bars = evidenceCandles(evidence);
  const last = bars[bars.length - 1];
  const events = evidence?.events ?? [];
  if (isHmKind(focusKind ?? events[0]?.kind)) return [];

  const overlays: ChartOverlay[] = [];
  for (const event of events) {
    const level = typeof event.level === "number" && Number.isFinite(event.level) ? event.level : null;
    if (level === null) continue;
    const at = asMs(event.timestamp);
    const point = { ...(at ? { timestamp: at } : {}), value: level };
    overlays.push({ name: "horizontalStraightLine", points: [point], color: SCAN_COLORS.level });
    const tolerance = typeof event.tolerance === "number" && Number.isFinite(event.tolerance) ? event.tolerance : null;
    if (tolerance !== null) {
      overlays.push(
        { name: "horizontalStraightLine", points: [{ ...point, value: level - tolerance }], color: SCAN_COLORS.band },
        { name: "horizontalStraightLine", points: [{ ...point, value: level + tolerance }], color: SCAN_COLORS.band },
      );
    }
    const origin = asMs(event.origin);
    if (origin) overlays.push({ name: "verticalStraightLine", points: [{ timestamp: origin }], color: SCAN_COLORS.origin });
  }

  const pivots = evidence?.context?.pivots;
  if (pivots && last) {
    for (const side of ["high", "low"] as const) {
      const pivot = pivots[side];
      // Drawn from confirmation, not from the extremum itself: the level was not knowable earlier.
      if (!pivot || !Number.isFinite(pivot.confirmedAt) || pivot.confirmedAt >= last.timestamp) continue;
      overlays.push({
        name: "rayLine",
        points: [{ timestamp: pivot.confirmedAt, value: pivot.price }, { timestamp: last.timestamp, value: pivot.price }],
        color: SCAN_COLORS.pivot,
      });
    }
  }
  if (last) overlays.push({ name: "verticalStraightLine", points: [{ timestamp: last.timestamp }], color: SCAN_COLORS.scanCandle });
  return overlays;
}

/** HM entries and exits, pinned to the candle they were seen on, exactly as the web dialog places them. */
export function scanMarkers(evidence?: ScannerEvidence): ChartMarker[] {
  const byTime = new Map(evidenceCandles(evidence).map((bar) => [bar.timestamp, bar]));
  return (evidence?.hmSignals ?? []).flatMap((signal) => {
    const bar = byTime.get(asMs(signal.timestamp) ?? -1);
    if (!bar) return [];
    return (signal.actions ?? []).map((action) => ({
      timestamp: bar.timestamp,
      value: action.endsWith("entry") ? bar.low : bar.high,
      text: action.replace(/_/g, " ").toUpperCase(),
      color: action === "buy_entry" || action === "sell_exit" ? SCAN_COLORS.buy : SCAN_COLORS.sell,
    }));
  });
}

/** The studies beside the candles: the range the level came from, RSI, ATR and volume. */
export function scanPanes(evidence?: ScannerEvidence, focusKind?: string): ChartPane[] {
  const bars = evidenceCandles(evidence);
  const panes: ChartPane[] = [];

  if (isHmKind(focusKind ?? (evidence?.events ?? [])[0]?.kind)) {
    const rows = evidence?.hmSeries ?? [];
    const stUp = seriesOf(rows, (row) => (row.direction === -1 ? row.supertrend : null));
    const stDown = seriesOf(rows, (row) => (row.direction === -1 ? null : row.supertrend));
    const hmLines = [
      ...line("stUp", "ST green", SCAN_COLORS.supertrendUp, stUp),
      ...line("stDown", "ST red", SCAN_COLORS.supertrendDown, stDown),
      ...line("ema", "EMA3 RSI9", SCAN_COLORS.ema, seriesOf(rows, (row) => row.ema)),
      ...line("wma", "WMA21", SCAN_COLORS.wma, seriesOf(rows, (row) => row.wma)),
    ];
    const onCandles = hmLines.filter((series) => series.key.startsWith("st"));
    const rsiLines = hmLines.filter((series) => !series.key.startsWith("st"));
    if (onCandles.length) panes.push({ id: "scan-hm-supertrend", paneId: "candle_pane", name: "MA", title: "Supertrend 10:3", lines: onCandles });
    if (rsiLines.length) panes.push({ id: "scan-hm-rsi", paneId: "scan-hm-rsi", name: "RSI", title: "HM RSI9", lines: rsiLines, minValue: 0, maxValue: 100, height: 140 });
  } else {
    const rows = evidence?.indicatorSeries ?? [];
    const range = [
      ...line("support", "Support", SCAN_COLORS.support, seriesOf(rows, (row) => row.support)),
      ...line("resistance", "Resistance", SCAN_COLORS.resistance, seriesOf(rows, (row) => row.resistance)),
    ];
    if (range.length) panes.push({ id: "scan-range", paneId: "candle_pane", name: "MA", title: "Scan prior 20-candle range", lines: range });
    const rsi = line("rsi14", "RSI 14", SCAN_COLORS.rsi, seriesOf(rows, (row) => row.rsi14));
    if (rsi.length) panes.push({ id: "scan-rsi", paneId: "scan-rsi", name: "RSI", title: "Scan RSI14 · Wilder", lines: rsi, minValue: 0, maxValue: 100, height: 110 });
    const atr = line("atr", "ATR 14", SCAN_COLORS.atr, seriesOf(rows, (row) => row.atr));
    if (atr.length) panes.push({ id: "scan-atr", paneId: "scan-atr", name: "MA", title: "Scan prior ATR14 · simple", lines: atr, height: 80 });
  }

  const volume = [
    ...line("volume", "Volume", SCAN_COLORS.volume, seriesOf(bars, (bar) => bar.volume)),
    ...line("volumeMean20", "Prior 20 mean", SCAN_COLORS.volumeMean, seriesOf(evidence?.indicatorSeries ?? [], (row) => row.volumeMean20)),
  ];
  if (volume.length) panes.push({ id: "scan-volume", paneId: "scan-volume", name: "VOL", title: "Scan volume / prior mean20", lines: volume, minValue: 0, height: 80 });
  return panes;
}
