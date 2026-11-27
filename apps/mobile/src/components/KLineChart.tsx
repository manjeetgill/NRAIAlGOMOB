/**
 * Professional KLine chart component using klinecharts library in WebView
 * Supports technical indicators (MA, EMA, RSI, MACD, Bollinger Bands, etc.)
 * Drawing tools (trend lines, horizontal lines, Fibonacci retracements)
 * Crosshair, zoom, pan, and theme switching
 * 
 * KLINECHARTS LIBRARY IS BUNDLED LOCALLY FOR OFFLINE USE
 */

import React, { useRef, useEffect, useCallback, useMemo, useState } from "react";
import { View, StyleSheet, ActivityIndicator, Text, Platform } from "react-native";
import { WebView } from "react-native-webview";
import type { WebViewMessageEvent } from "react-native-webview";
import { useTheme } from "@/components/ThemeProvider";
import { KLINECHARTS_LIB } from "./klinecharts_lib";
import type { Candle } from "@nraialgo/shared/api";
import type { ChartMarker, ChartOverlay, ChartPane } from "@/utils/scan-chart";

/**
 * One study the trader switched on. `pane: "candle"` stacks it over the candles; any other value is
 * used as the pane id, so each pane-bound study gets a lane of its own that can be dragged taller.
 */
export interface ChartStudy {
  key: string;
  /** A name the bundled library knows, or "ATR", which this file registers. */
  name: string;
  pane: "candle" | string;
  calcParams?: number[];
}

/** A drawing tool armed from the screen. `nonce` lets the same tool be pressed twice in a row. */
export interface ChartDraw {
  name: string | null;
  nonce: number;
}

/**
 * Sessions older than the left edge of the chart, as far as the app has paged them in.
 *
 * `bars` is the whole older set rather than the newest page, because a theme change rebuilds the canvas and
 * the rebuilt chart has to be handed everything again; the page only puts the bars it is missing in front of
 * the ones on screen. `more` is the server's own answer to "is there anything older", so the chart stops
 * asking at the end of the record instead of polling a wall. `nonce` applies one update once.
 */
export interface ChartHistory {
  bars: Candle[];
  more: boolean;
  nonce: number;
}

/** Action dispatched to control chart pan and zoom programmatically */
export interface ChartAction {
  type: "zoom_in" | "zoom_out" | "scroll_left" | "scroll_right" | "reset";
  nonce: number;
}

interface KLineChartProps {
  data: Candle[];
  height?: number;
  symbol?: string;
  /**
   * The scanner's own studies, drawn over the candles it was run on: `overlays` are the rule's levels,
   * `markers` its entries and exits, `panes` the series the scan saved. Sent as tables rather than
   * functions, because a WebView cannot be handed a callback.
   */
  overlays?: ChartOverlay[];
  markers?: ChartMarker[];
  panes?: ChartPane[];
  /** The trader's indicators. An empty list is a plain candle chart, which is what the desk opens with. */
  studies?: ChartStudy[];
  /** `name: null` erases every line drawn from the screen. */
  draw?: ChartDraw | null;
  /** Omitted on a chart that has no older record behind it, which is every chart but the Terminal's. */
  history?: ChartHistory | null;
  /** Called with the oldest bar on screen when the trader scrolls or zooms towards it. */
  onNeedMore?: (before: number) => void;
  /** Programmatic pan and zoom actions (e.g. from zoom/scroll buttons) */
  action?: ChartAction | null;
  /**
   * Called with true while a finger is on the chart and false when it lifts. A screen that puts the chart
   * inside a ScrollView turns its own scrolling off meanwhile, or the ScrollView takes the drag (Android
   * hands any slightly vertical move to the parent) and the chart never pans.
   */
  onTouchActive?: (active: boolean) => void;
}

type ChartMessage =
  | { type: "ready" }
  | { type: "needMore"; before: number }
  | { type: "error"; message: string };

export default function KLineChart({
  data,
  height = 400,
  symbol = "",
  overlays,
  markers,
  panes,
  studies,
  draw,
  history,
  onNeedMore,
  action,
  onTouchActive,
}: KLineChartProps) {
  const { resolvedTheme } = useTheme();
  const webViewRef = useRef<WebView>(null);
  const isReady = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const needMoreRef = useRef(onNeedMore);
  needMoreRef.current = onNeedMore;

  const chartHtml = useMemo(() => {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <script>${KLINECHARTS_LIB}</script>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          html, body { width: 100%; height: 100%; overflow: hidden; background: ${resolvedTheme === 'dark' ? '#0f172a' : '#ffffff'}; }
          #chart { width: 100%; height: 100%; }
          #error { display: none; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); text-align: center; color: ${resolvedTheme === 'dark' ? '#f1f5f9' : '#0f172a'}; font-family: sans-serif; padding: 20px; }
        </style>
      </head>
      <body>
        <div id="chart"></div>
        <div id="error">
          <p>⚠️ Chart failed to load</p>
          <p style="font-size: 12px; margin-top: 8px; color: #64748b;">Please reload the app</p>
        </div>
        <script>
          let chart = null;
          let lastDataKey = null;
          let lastScan = null;
          let scanPanes = [];
          let pagerOn = false;
          let moreAhead = false;
          let asking = false;
          let lastHistoryNonce = 0;
          let lastWindow = [];

          function postApp(message) {
            try { window.ReactNativeWebView.postMessage(JSON.stringify(message)); } catch (e) {}
          }

          function toBar(item) {
            return {
              timestamp: item.timestamp,
              open: item.open,
              high: item.high,
              low: item.low,
              close: item.close,
              volume: item.volume || 0,
            };
          }

          function showError(msg) {
            document.getElementById('error').style.display = 'block';
            document.getElementById('error').innerHTML = '<p>⚠️ ' + msg + '</p><p style="font-size: 12px; margin-top: 8px; color: #64748b;">Please reload</p>';
            document.getElementById('chart').style.display = 'none';
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', message: msg }));
          }
          
          function initChart() {
            if (typeof klinecharts === 'undefined') {
              showError('Chart library not loaded');
              return;
            }
            
            try {
              const isDark = ${resolvedTheme === 'dark'};
              const colors = isDark ? {
                background: '#0f172a', text: '#f1f5f9', grid: '#334155',
                crosshair: '#64748b', up: '#22c55e', down: '#ef4444',
              } : {
                background: '#ffffff', text: '#0f172a', grid: '#e2e8f0',
                crosshair: '#64748b', up: '#16a34a', down: '#dc2626',
              };

              if (chart) chart.dispose();

              chart = klinecharts.init('chart', {
                styles: {
                  grid: { show: true, horizontal: { color: colors.grid }, vertical: { color: colors.grid } },
                  candle: {
                    // The OHLC table used to sit over the candles permanently, and the high and low marks were
                    // printed on the price scale whatever the trader was looking at. Both now appear only while
                    // a crosshair is on the chart, which is the only moment either one answers a question.
                    tooltip: {
                      showRule: 'follow_cross',
                      title: { show: false, template: "{ticker}" },
                    },
                    priceMark: {
                      high: { show: false, color: colors.up },
                      low: { show: false, color: colors.down },
                      last: { show: true, color: colors.text },
                    },
                    bar: { upColor: colors.up, downColor: colors.down, noChangeColor: colors.text },
                  },
                  indicator: {
                    tooltip: { showRule: 'follow_cross', title: { show: false } },
                    text: { color: colors.text },
                  },
                  xAxis: { axisLine: { color: colors.grid }, tickText: { color: colors.text } },
                  yAxis: { axisLine: { color: colors.grid }, tickText: { color: colors.text } },
                  crosshair: { horizontal: { color: colors.crosshair }, vertical: { color: colors.crosshair } },
                },
                toolbar: { visible: 'always' },
              });

              registerAtr();
              registerSuperTrend(colors);
              watchLeftEdge();
              paintSymbol();
              if (pendingStudies) applyStudies(pendingStudies);

              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
            } catch (e) {
              showError('Init error: ' + e.message);
            }
          }

          // The ticker arrives as a message rather than as part of the page, because rebuilding the page means
          // re-parsing the chart library — which is what made switching symbols take seconds. Switching means
          // the old instrument's marks are gone: its drawn lines and its bars, not just its name.
          let pendingSymbol = '';

          function requestSymbol(ticker) {
            pendingSymbol = ticker || '';
            if (chart) paintSymbol();
          }

          function paintSymbol() {
            if (!chart) return;
            lastDataKey = null;
            pagerOn = false;
            moreAhead = false;
            asking = false;
            lastHistoryNonce = 0;
            lastWindow = [];
            try { chart.removeOverlay({ groupId: 'user' }); } catch (e) {}
            try {
              if (chart._chartStore && typeof chart._chartStore._addData === 'function') {
                chart._chartStore._addData([], 'init');
              }
            } catch (e) {
              console.error('Clear error:', e);
            }
            try {
              if (typeof chart.setSymbol === 'function') chart.setSymbol({ ticker: pendingSymbol });
            } catch (e) {
              console.error('Symbol error:', e);
            }
          }

          // The library reports the bar numbers on screen every time the trader drags or pinches. Asking when
          // the oldest loaded bar comes near the left edge, rather than after it touches it, is what keeps a
          // zoom-out from running into a wall; one page is in flight at a time, and a chart the app has not
          // offered history to never asks at all.
          const LEAD_BARS = 12;

          function oldestBar() {
            const list = chart.getDataList() || [];
            return list.length ? list[0].timestamp : null;
          }

          // Whether this chart is asking for a page it does not already have. A window that holds every bar
          // the chart owns cannot be dragged at all — the drag moves the empty margin, not the candles — so
          // the range event that would trigger a page never arrives. A seven-bar hour on a wide phone screen
          // is that chart: without filling on the arm alone, its history stays unreachable however hard it is
          // scrolled. Once the candles overflow the screen, dragging works and only a real scroll asks.
          function needsOlder(range) {
            if (!pagerOn || !moreAhead || asking) return false;
            const list = chart.getDataList() || [];
            if (!list.length) return false;
            const allOnScreen = !range || typeof range.from !== 'number' || (range.to - range.from) >= list.length;
            return allOnScreen || range.from <= LEAD_BARS;
          }

          function askForOlder() {
            const before = oldestBar();
            if (before === null) return;
            asking = true;
            postApp({ type: 'needMore', before });
          }

          function watchLeftEdge() {
            if (typeof chart.subscribeAction !== 'function') return;
            try {
              chart.subscribeAction('onVisibleRangeChange', function (range) {
                if (!needsOlder(range)) return;
                askForOlder();
              });
            } catch (e) {
              console.error('Edge watch error:', e);
            }
          }

          // Older sessions go in front of the candles on the canvas, which is the one thing the library does
          // without moving the view: the chart stays where the trader parked it and fills in behind it. The
          // bars already there are skipped, so a canvas rebuilt by a theme change is refilled, not doubled.
          function applyHistory(request) {
            if (!chart) return;
            pagerOn = true;
            moreAhead = !!request.more;
            asking = false;
            const list = chart.getDataList() || [];
            if (list.length && request.nonce !== lastHistoryNonce) {
              lastHistoryNonce = request.nonce;
              const edge = list[0].timestamp;
              const page = (request.bars || []).map(toBar).filter(function (item) { return item.timestamp < edge; });
              if (page.length) {
                try {
                  chart._chartStore._addData(page, 'forward', { forward: moreAhead, backward: false });
                } catch (e) {
                  console.error('History error:', e);
                }
              }
            }
            // Arm-to-arm: the first page arrives without any gesture, and while the chart still shows all it
            // holds, so does the next one. This stops on its own — the record running out clears the flag
            // that says more exists, and a chart long enough to scroll stops needing the free fill.
            if (needsOlder(chart.getVisibleRange && chart.getVisibleRange())) askForOlder();
          }

          function clearScan() {
            if (!chart) return;
            try { chart.removeOverlay({ groupId: 'scan' }); } catch (e) {}
            scanPanes.forEach(function (id) { try { chart.removeIndicator({ id: id }); } catch (e) {} });
            scanPanes = [];
          }

          // The bundled build has no ATR, so it is registered here as true range smoothed Wilder-style over
          // the period, which is the ATR every desk prints.
          let atrRegistered = false;
          function registerAtr() {
            if (atrRegistered || typeof klinecharts === 'undefined' || typeof klinecharts.registerIndicator !== 'function') return;
            atrRegistered = true;
            try {
              klinecharts.registerIndicator({
                name: 'ATR',
                shortName: 'ATR',
                series: 'price',
                precision: 2,
                calcParams: [14],
                figures: [{ key: 'atr', title: 'ATR: ', type: 'line' }],
                calc: function (list, indicator) {
                  const period = Math.max(1, (indicator.calcParams && indicator.calcParams[0]) || 14);
                  let seeded = 0;
                  let previousATR = 0;
                  let previousClose = null;
                  return list.map(function (bar, index) {
                    const row = {};
                    let range = bar.high - bar.low;
                    if (previousClose !== null) {
                      const up = Math.abs(bar.high - previousClose);
                      const down = Math.abs(bar.low - previousClose);
                      if (up > range) range = up;
                      if (down > range) range = down;
                    }
                    previousClose = bar.close;
                    if (index < period - 1) { seeded += range; return row; }
                    if (index === period - 1) {
                      seeded += range;
                      previousATR = seeded / period;
                    } else {
                      previousATR = (previousATR * (period - 1) + range) / period;
                    }
                    row.atr = previousATR;
                    return row;
                  });
                }
              });
            } catch (e) {
              console.error('ATR registration error:', e);
            }
          }

          // Supertrend is not in the bundled build either. It walks a band off the middle of each bar by a
          // multiple of Wilder-smoothed true range, and the band only ratchets while price is on its side of
          // it — which is why the final bands, not the raw ones, decide a flip. Green while price holds above
          // the lower band, red from the session that closes below the upper one.
          let superTrendRegistered = false;
          function registerSuperTrend(colors) {
            if (superTrendRegistered || typeof klinecharts === 'undefined' || typeof klinecharts.registerIndicator !== 'function') return;
            superTrendRegistered = true;
            try {
              klinecharts.registerIndicator({
                name: 'SUPER_TREND',
                shortName: 'ST',
                series: 'price',
                precision: 2,
                calcParams: [10, 3],
                figures: [
                  { key: 'upTrend', title: 'ST: ', type: 'line', styles: function () { return { color: colors.up, size: 2 }; } },
                  { key: 'downTrend', title: 'ST: ', type: 'line', styles: function () { return { color: colors.down, size: 2 }; } },
                ],
                calc: function (list, indicator) {
                  const params = indicator.calcParams || [];
                  const period = Math.max(1, params[0] || 10);
                  const multiplier = Math.max(0.1, params[1] || 3);
                  let seeded = 0;
                  let previousATR = 0;
                  let previousUpper = 0;
                  let previousLower = 0;
                  let previousClose = null;
                  let previousTrend = 1;
                  return list.map(function (bar, index) {
                    const row = {};
                    let range = bar.high - bar.low;
                    if (previousClose !== null) {
                      const up = Math.abs(bar.high - previousClose);
                      const down = Math.abs(bar.low - previousClose);
                      if (up > range) range = up;
                      if (down > range) range = down;
                    }
                    if (index < period - 1) { seeded += range; previousClose = bar.close; return row; }
                    if (index === period - 1) {
                      seeded += range;
                      previousATR = seeded / period;
                    } else {
                      previousATR = (previousATR * (period - 1) + range) / period;
                    }
                    const middle = (bar.high + bar.low) / 2;
                    let upper = middle + multiplier * previousATR;
                    let lower = middle - multiplier * previousATR;
                    if (previousClose !== null) {
                      if (!(upper < previousUpper || previousClose > previousUpper)) upper = previousUpper;
                      if (!(lower > previousLower || previousClose < previousLower)) lower = previousLower;
                    }
                    let trend = previousTrend;
                    if (previousTrend === 1 && bar.close < lower) trend = -1;
                    else if (previousTrend === -1 && bar.close > upper) trend = 1;
                    if (trend === 1) row.upTrend = lower; else row.downTrend = upper;
                    previousUpper = upper;
                    previousLower = lower;
                    previousTrend = trend;
                    previousClose = bar.close;
                    return row;
                  });
                }
              });
            } catch (e) {
              console.error('Supertrend registration error:', e);
            }
          }

          let studyIds = [];
          let pendingStudies = null;

          function clearStudies() {
            studyIds.forEach(function (id) { try { chart.removeIndicator({ id: id }); } catch (e) {} });
            studyIds = [];
          }

          // Rebuilt whole rather than diffed: the set is a handful of entries and the order the screen
          // lists them in is the order the panes should stack.
          function applyStudies(studies) {
            pendingStudies = studies || [];
            if (!chart) return;
            clearStudies();
            pendingStudies.forEach(function (study) {
              try {
                const paneId = study.pane === 'candle' ? 'candle_pane' : 'pane_' + study.key;
                const spec = { name: study.name, id: 'ind_' + study.key, paneId: paneId };
                if (study.calcParams && study.calcParams.length) spec.calcParams = study.calcParams;
                const created = chart.createIndicator(spec, true);
                if (created) {
                  studyIds.push(created);
                  if (paneId !== 'candle_pane') {
                    try { chart.setPaneOptions({ id: paneId, height: 72, minHeight: 56, dragEnabled: true }); } catch (e) {}
                  }
                }
              } catch (e) {
                console.error('Study error:', e);
              }
            });
          }

          function applyDraw(request) {
            if (!chart) return;
            try {
              // A tool picked while a line is still waiting for its next point would otherwise strand a
              // half-drawn overlay nobody asked for.
              (chart.getOverlays({ groupId: 'user' }) || []).forEach(function (overlay) {
                if (typeof overlay.isDrawing === 'function' && overlay.isDrawing()) {
                  try { chart.removeOverlay({ id: overlay.id }); } catch (e) {}
                }
              });
            } catch (e) {}
            if (!request || !request.name) {
              try { chart.removeOverlay({ groupId: 'user' }); } catch (e) {}
              return;
            }
            try { chart.createOverlay({ name: request.name, groupId: 'user' }); } catch (e) {
              console.error('Draw error:', e);
            }
          }

          // A WebView cannot be handed a calc function, so a scan's studies arrive as timestamp tables and
          // are rebuilt here. Overlay points resolve against the candles, so this runs after the data.
          function applyScan(scan) {
            if (!chart || !scan) return;
            lastScan = scan;
            clearScan();
            try {
              (scan.panes || []).forEach(function (pane) {
                const tables = {};
                pane.lines.forEach(function (item) { tables[item.key] = item.points; });
                const spec = {
                  name: pane.name, id: pane.id, paneId: pane.paneId, shortName: pane.title,
                  calcParams: [], regenerateFigures: null,
                  figures: pane.lines.map(function (item) {
                    return { key: item.key, title: item.label + ': ', type: 'line', styles: function () { return { color: item.color, size: 2 }; } };
                  }),
                  calc: function (bars) {
                    return bars.map(function (bar) {
                      const row = {};
                      pane.lines.forEach(function (item) {
                        const value = tables[item.key][bar.timestamp];
                        if (typeof value === 'number' && isFinite(value)) row[item.key] = value;
                      });
                      return row;
                    });
                  }
                };
                if (typeof pane.minValue === 'number') { spec.minValue = pane.minValue; spec.maxValue = pane.maxValue; }
                let created = false;
                try { created = !!chart.createIndicator(spec, true); } catch (e) { created = false; }
                if (created) {
                  // Tracked even on the candle pane: a refetch of another scan must not leave the previous
                  // study's line drawn over the candles.
                  scanPanes.push(pane.id);
                  if (pane.paneId !== 'candle_pane') {
                    try { chart.setPaneOptions({ id: pane.paneId, height: pane.height || 72, minHeight: 56, dragEnabled: true }); } catch (e) {}
                  }
                }
              });
              (scan.overlays || []).forEach(function (overlay) {
                try {
                  chart.createOverlay({ name: overlay.name, groupId: 'scan', lock: true, points: overlay.points, styles: { line: { color: overlay.color } } });
                } catch (e) {}
              });
              (scan.markers || []).forEach(function (marker) {
                try {
                  chart.createOverlay({
                    name: 'simpleAnnotation', groupId: 'scan', lock: true,
                    points: [{ timestamp: marker.timestamp, value: marker.value }],
                    extendData: marker.text,
                    styles: { line: { color: marker.color }, text: { color: marker.color } }
                  });
                } catch (e) {}
              });
            } catch (e) {
              console.error('Scan overlay error:', e);
            }
          }

          function updateData(data) {
            if (!chart || !data || !data.length) return;
            try {
              const bars = data.map(toBar);
              const first = bars[0];
              const last = bars[bars.length - 1];
              const dataKey = bars.length + "_" + (first ? first.timestamp : "") + "_" + (last ? last.timestamp + "_" + last.close : "");
              if (dataKey === lastDataKey) return;
              lastDataKey = dataKey;
              const previous = lastWindow;
              lastWindow = bars;
              // The same session grew (a candle closed) or its last bar moved. Feeding the changed bars one at
              // a time goes through the library's own update path: a bar with the last timestamp replaces it, a
              // newer one is added after it, the view follows the live bar only when it was already at the
              // right edge, and the older sessions paged in on the left stay. Replacing the whole list would
              // drop those pages and re-anchor the chart.
              if (previous.length > 0 && bars.length >= previous.length &&
                  bars[0].timestamp === previous[0].timestamp &&
                  chart._chartStore && typeof chart._chartStore._addData === 'function') {
                for (const bar of bars.slice(previous.length - 1)) chart._chartStore._addData(bar);
                if (lastScan) applyScan(lastScan);
                return;
              }
              if (typeof chart.applyNewData === 'function') {
                chart.applyNewData(bars);
              } else if (chart._chartStore && typeof chart._chartStore._addData === 'function') {
                chart._chartStore._addData(bars, 'init');
              } else if (typeof chart.setDataLoader === 'function') {
                chart.setDataLoader({
                  getBars: function (params) {
                    params.callback(bars);
                  }
                });
                chart.setSymbol('CHART');
                chart.setPeriod({ multiplier: 1, timespan: 'day' });
              }
              if (lastScan) applyScan(lastScan);
            } catch (e) {
              console.error('Update error:', e);
            }
          }

          function patchBar(item) {
            if (!chart || !item) return;
            try {
              const bar = {
                timestamp: item.timestamp,
                open: item.open,
                high: item.high,
                low: item.low,
                close: item.close,
                volume: item.volume || 0,
              };
              if (chart._chartStore && typeof chart._chartStore._addData === 'function') {
                chart._chartStore._addData(bar, 'forward');
              } else if (typeof chart.updateData === 'function') {
                chart.updateData(bar);
              }
            } catch (e) {
              console.error('Patch error:', e);
            }
          }

          function applyAction(act) {
            if (!chart || !act) return;
            try {
              const barSpace = (typeof chart.getBarSpace === 'function' && chart.getBarSpace().bar) || 10;
              if (act.type === 'zoom_in') {
                if (typeof chart.zoomAtCoordinate === 'function') chart.zoomAtCoordinate(1.25);
              } else if (act.type === 'zoom_out') {
                if (typeof chart.zoomAtCoordinate === 'function') chart.zoomAtCoordinate(0.8);
              } else if (act.type === 'scroll_left') {
                // Scroll backwards in time (towards earlier bars on left)
                if (typeof chart.scrollByDistance === 'function') chart.scrollByDistance(barSpace * 5);
              } else if (act.type === 'scroll_right') {
                // Scroll forwards in time (towards latest bars on right)
                if (typeof chart.scrollByDistance === 'function') chart.scrollByDistance(-barSpace * 5);
              } else if (act.type === 'reset') {
                if (typeof chart.scrollToRealTime === 'function') chart.scrollToRealTime();
              }
            } catch (e) {
              console.error('Action error:', e);
            }
          }

          function handleRawMessage(event) {
            try {
              const rawData = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
              const message = JSON.parse(rawData);
              if (message.type === 'init') initChart();
              else if (message.type === 'symbol') requestSymbol(message.ticker);
              else if (message.type === 'update') updateData(message.data);
              else if (message.type === 'patch') patchBar(message.bar);
              else if (message.type === 'history') applyHistory(message);
              else if (message.type === 'scan') applyScan(message.scan);
              else if (message.type === 'studies') applyStudies(message.studies);
              else if (message.type === 'draw') applyDraw(message);
              else if (message.type === 'action') applyAction(message.action);
            } catch (e) { 
              console.error('Message error:', e);
            }
          }

          window.addEventListener('message', handleRawMessage);
          document.addEventListener('message', handleRawMessage);

          window.addEventListener('DOMContentLoaded', () => {
            initChart();
          });
          window.addEventListener('load', () => {
            if (!chart) initChart();
          });
        </script>
      </body>
      </html>
    `;
  }, [resolvedTheme]);

  const prevLastRef = useRef<{ timestamp: number; close: number; len: number } | null>(null);

  // A theme change rebuilds the page, and the new page knows nothing the old one was sent. Forget what was
  // posted and wait for its "ready", so the ticker, studies and scan are sent again instead of skipped. A drawing
  // tool is not re-armed: the reload took its lines with it.
  useEffect(() => {
    isReady.current = false;
    prevLastRef.current = null;
    postedSymbolRef.current = null;
    postedScanRef.current = null;
    postedStudiesRef.current = null;
    postedHistoryRef.current = null;
  }, [chartHtml]);

  // The ticker is a message, not part of the page: see the chart's own paintSymbol(). Once the canvas exists
  // a switch costs a post, not a re-parse of the library.
  const symbolPayload = useMemo(() => JSON.stringify({ type: "symbol", ticker: symbol }), [symbol]);
  const postedSymbolRef = useRef<string | null>(null);
  const postSymbol = useCallback(() => {
    if (!isReady.current || !webViewRef.current || postedSymbolRef.current === symbolPayload) return;
    postedSymbolRef.current = symbolPayload;
    // The canvas is empty now, so the shortcut that sends one bar when only the forming close moved has to
    // be dropped — otherwise the new instrument's candles would never be sent.
    prevLastRef.current = null;
    // The chart forgot which pages it holds along with the candles, so the history is sent again even if the
    // screen has not fetched a new one since.
    postedHistoryRef.current = null;
    webViewRef.current.postMessage(symbolPayload);
  }, [symbolPayload]);

  // Older sessions are one message per change: the screen accumulates them, the chart decides what it lacks.
  const historyPayload = useMemo(
    () => (history
      ? JSON.stringify({ type: "history", bars: history.bars, more: history.more, nonce: history.nonce })
      : null),
    [history],
  );
  const postedHistoryRef = useRef<string | null>(null);
  const postHistory = useCallback(() => {
    if (!historyPayload || !isReady.current || !webViewRef.current || postedHistoryRef.current === historyPayload) return;
    postedHistoryRef.current = historyPayload;
    webViewRef.current.postMessage(historyPayload);
  }, [historyPayload]);

  // One string per study set: an identical refetch of the same scan must not redraw every level.
  const scanPayload = useMemo(
    () => JSON.stringify({ type: "scan", scan: { overlays: overlays ?? [], markers: markers ?? [], panes: panes ?? [] } }),
    [overlays, markers, panes],
  );
  const postedScanRef = useRef<string | null>(null);
  const postScan = useCallback(() => {
    if (!isReady.current || !webViewRef.current || postedScanRef.current === scanPayload) return;
    postedScanRef.current = scanPayload;
    webViewRef.current.postMessage(scanPayload);
  }, [scanPayload]);

  // Studies and drawings change on a tap, not on a poll, so each is posted once per distinct request.
  const studiesPayload = useMemo(() => JSON.stringify({ type: "studies", studies: studies ?? [] }), [studies]);
  const postedStudiesRef = useRef<string | null>(null);
  const postStudies = useCallback(() => {
    if (!isReady.current || !webViewRef.current || postedStudiesRef.current === studiesPayload) return;
    postedStudiesRef.current = studiesPayload;
    webViewRef.current.postMessage(studiesPayload);
  }, [studiesPayload]);

  const drawPayload = useMemo(() => (draw ? JSON.stringify({ type: "draw", name: draw.name, nonce: draw.nonce }) : null), [draw]);
  const postedDrawRef = useRef<string | null>(null);
  const postDraw = useCallback(() => {
    if (!drawPayload || !isReady.current || !webViewRef.current || postedDrawRef.current === drawPayload) return;
    postedDrawRef.current = drawPayload;
    webViewRef.current.postMessage(drawPayload);
  }, [drawPayload]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const message: ChartMessage = JSON.parse(event.nativeEvent.data);
      if (message.type === "ready") {
        isReady.current = true;
        setLoading(false);
        setError(null);
        // Ticker first: it wipes the canvas, and the candles sent below are the ones meant to be on it.
        postSymbol();
        // Send data to chart
        if (webViewRef.current && data.length > 0) {
          const last = data[data.length - 1];
          prevLastRef.current = { timestamp: last.timestamp, close: last.close, len: data.length };
          webViewRef.current.postMessage(JSON.stringify({ type: "update", data }));
        }
        postScan();
        postStudies();
        postDraw();
        postHistory();
      } else if (message.type === "needMore") {
        needMoreRef.current?.(message.before);
      } else if (message.type === "error") {
        setError(message.message);
        setLoading(false);
      }
    } catch (e) {
      console.error("Chart message error:", e);
    }
  }, [data, postSymbol, postScan, postStudies, postDraw, postHistory]);

  // Declared before the data effect so a switch that lands both in one commit clears the canvas first.
  useEffect(() => {
    postSymbol();
  }, [postSymbol]);

  useEffect(() => {
    if (!isReady.current || !webViewRef.current || !data.length) return;
    const last = data[data.length - 1];
    const prev = prevLastRef.current;
    if (prev && prev.len === data.length && prev.timestamp === last.timestamp) {
      if (prev.close === last.close) return;
      // Patch forming bar delta instead of serializing the full series
      prevLastRef.current = { timestamp: last.timestamp, close: last.close, len: data.length };
      webViewRef.current.postMessage(JSON.stringify({ type: "patch", bar: last }));
      return;
    }
    prevLastRef.current = { timestamp: last.timestamp, close: last.close, len: data.length };
    webViewRef.current.postMessage(JSON.stringify({ type: "update", data }));
  }, [data]);

  useEffect(() => {
    postScan();
  }, [postScan]);

  useEffect(() => {
    postStudies();
  }, [postStudies]);

  useEffect(() => {
    postDraw();
  }, [postDraw]);

  // Last, because a page of older sessions is put in front of the candles on the canvas — the canvas has to
  // hold this instrument's candles first or there is no edge to put them behind.
  useEffect(() => {
    postHistory();
  }, [postHistory]);

  // Dispatch pan/zoom action when nonce updates
  useEffect(() => {
    if (!isReady.current || !webViewRef.current || !action) return;
    webViewRef.current.postMessage(JSON.stringify({ type: "action", action }));
  }, [action]);

  return (
    <View style={[styles.container, { height }]}>
      {loading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color={resolvedTheme === "dark" ? "#38bdf8" : "#0284c7"} />
          <Text style={[styles.loadingText, { color: resolvedTheme === "dark" ? "#f1f5f9" : "#0f172a" }]}>
            Loading chart...
          </Text>
        </View>
      )}
      {error && !loading && (
        <View style={styles.errorOverlay}>
          <Text style={styles.errorText}>⚠️ {error}</Text>
          <Text style={styles.errorSubtext}>Pull down to refresh</Text>
        </View>
      )}
      {chartHtml && (
        <View
          style={styles.webview}
          onTouchStart={onTouchActive ? () => onTouchActive(true) : undefined}
          onTouchEnd={onTouchActive ? () => onTouchActive(false) : undefined}
          onTouchCancel={onTouchActive ? () => onTouchActive(false) : undefined}
        >
        <WebView
          ref={webViewRef as any}
          source={{ html: chartHtml }}
          style={styles.webview}
          onMessage={handleMessage}
          javaScriptEnabled
          domStorageEnabled
          originWhitelist={["*"]}
          scrollEnabled={false}
          bounces={false}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          startInLoadingState
          renderLoading={() => (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator size="large" color={resolvedTheme === "dark" ? "#38bdf8" : "#0284c7"} />
            </View>
          )}
        />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
    position: "relative",
  },
  webview: {
    flex: 1,
    backgroundColor: "transparent",
  },
  loadingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.05)",
    zIndex: 1,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
  },
  errorOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.8)",
    zIndex: 2,
    padding: 20,
  },
  errorText: {
    color: "#ef4444",
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
  errorSubtext: {
    color: "#94a3b8",
    fontSize: 13,
    marginTop: 8,
    textAlign: "center",
  },
});
