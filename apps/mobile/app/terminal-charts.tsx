/**
 * Terminal Charts - candles for any listed index or F&O underlying, moving tick by tick in the live market.
 * Minutes and hours come from the sessions the server has stored, daily and weekly candles from the stored NSE
 * end-of-day archive; that record only has to cover the completed bars. The bar being watched is then extended
 * by prod's quote stream, the same stream the web desk uses, so the candle on this screen is the current price
 * rather than the last poll. A session older than today is read from the archive and is not extended.
 *
 * The chart opens as candles and nothing else. Indicators are the trader's to switch on, and each symbol
 * remembers the set it was last shown with.
 */

import React, { useMemo, useState, useCallback, useEffect, useRef } from "react";
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import { useTheme } from "@/components/ThemeProvider";
import { useApi } from "@/hooks/useApi";
import { useScreenFocused } from "@/hooks/useScreenFocused";
import {
  chartFailureReason,
  chartInstrument,
  chartPickerSections,
  mergeOlderCandles,
  olderAhead,
  tickLabel,
  useLiveCandles,
  type Candle,
  type ChartBucket,
} from "@nraialgo/shared/api";
import { formatRupees } from "@nraialgo/shared/utils";
import KLineChart, { type ChartDraw, type ChartStudy } from "@/components/KLineChart";

const INTERVALS = [
  { id: "1m", label: "1m" },
  { id: "5m", label: "5m" },
  { id: "15m", label: "15m" },
  { id: "30m", label: "30m" },
  { id: "1h", label: "1h" },
  { id: "1d", label: "1d" },
  { id: "1w", label: "1w" },
] as const;

type IntervalId = (typeof INTERVALS)[number]["id"];

const DAILY_INTERVALS = new Set<IntervalId>(["1d", "1w"]);
const DEFAULT_SYMBOL = "NIFTY";
// Daily candles are the default: one bar per completed session, read from stored history rather than
// from a live broker session, so the chart is never blank because the market happens to be shut.
const DEFAULT_INTERVAL: IntervalId = "1d";
const DAILY_CANDLES_SHOWN = 120;
const INTRADAY_CANDLES_SHOWN = 375;
/**
 * How much of the older record the screen keeps to hand the chart. The server holds about 60 sessions, which is
 * 22,500 bars at 1m, so this never trims a real record. A smaller cap dropped each new (oldest) page as soon as it
 * arrived, and scrolling back stalled at about 4 sessions on 1m and 20 on 5m.
 */
const OLDER_BARS_HELD = 25_000;
const STUDY_STORAGE = "terminal-chart-studies";
/** Periods are a habit rather than a property of the instrument, so they are stored once for the phone. */
const STUDY_PARAM_STORAGE = "terminal-chart-study-params";
/** Past three, the panes squeeze the candles into a strip nobody can read a trend in. */
const MAX_PANES = 3;

/**
 * Every entry is a study the bundled chart library really has: `pane: "candle"` draws over the candles,
 * any other value names the entry's own pane. `calcParams` is what the study opens with — for every entry
 * below it is the number the bundled library itself defaults to, so switching on shows the usual setting —
 * and the trader can edit it from the sheet. ATR and Supertrend are the exceptions: neither is bundled, and
 * KLineChart registers both before the first use.
 */
interface StudyOption {
  key: string;
  name: string;
  /** What the chip prints; the library's own name is sometimes too long for one. */
  abbr: string;
  label: string;
  pane: "candle" | string;
  calcParams: number[];
  /** Says what the numbers mean when they are not all plain periods. */
  paramHint?: string;
  /** Whether the library draws one line per number, so the count itself can change. */
  variable?: boolean;
}

const STUDY_GROUPS: { title: string; note: string; options: StudyOption[] }[] = [
  {
    title: "Over the candles",
    note: "Drawn on the price pane",
    options: [
      { key: "ma", name: "MA", abbr: "MA", label: "Moving average", pane: "candle", calcParams: [5, 10, 20, 60], variable: true },
      { key: "ema", name: "EMA", abbr: "EMA", label: "Exponential MA", pane: "candle", calcParams: [6, 12, 20], variable: true },
      { key: "sma", name: "SMA", abbr: "SMA", label: "Simple moving average", pane: "candle", calcParams: [12, 2], paramHint: "the period, then its weight" },
      { key: "st", name: "SUPER_TREND", abbr: "ST", label: "Supertrend", pane: "candle", calcParams: [10, 3], paramHint: "the ATR period, then how wide the band is" },
      { key: "boll", name: "BOLL", abbr: "BOLL", label: "Bollinger bands", pane: "candle", calcParams: [20, 2], paramHint: "the period, then the width in std deviations" },
      { key: "sar", name: "SAR", abbr: "SAR", label: "Parabolic SAR", pane: "candle", calcParams: [2, 2, 20], paramHint: "start factor, step, max step" },
    ],
  },
  {
    title: "In their own pane",
    note: `Up to ${MAX_PANES} at a time`,
    options: [
      { key: "vol", name: "VOL", abbr: "VOL", label: "Volume", pane: "vol", calcParams: [5, 10, 20], variable: true },
      { key: "atr", name: "ATR", abbr: "ATR", label: "ATR", pane: "atr", calcParams: [14], paramHint: "the period, smoothed Wilder-style" },
      { key: "rsi", name: "RSI", abbr: "RSI", label: "RSI", pane: "rsi", calcParams: [6, 12, 24], variable: true },
      { key: "macd", name: "MACD", abbr: "MACD", label: "MACD", pane: "macd", calcParams: [12, 26, 9], paramHint: "fast, slow, signal" },
      { key: "kdj", name: "KDJ", abbr: "KDJ", label: "Stochastic", pane: "kdj", calcParams: [9, 3, 3], paramHint: "the period, then two smoothing periods" },
    ],
  },
  {
    title: "More",
    note: "Also drawn in a pane of their own",
    options: [
      { key: "cci", name: "CCI", abbr: "CCI", label: "CCI", pane: "cci", calcParams: [20] },
      { key: "dmi", name: "DMI", abbr: "DMI", label: "DMI / ADX", pane: "dmi", calcParams: [14, 6], paramHint: "the period, then the smoothing" },
      { key: "obv", name: "OBV", abbr: "OBV", label: "On-balance volume", pane: "obv", calcParams: [30], paramHint: "the moving-average period" },
      { key: "roc", name: "ROC", abbr: "ROC", label: "Rate of change", pane: "roc", calcParams: [12, 6] },
      { key: "wr", name: "WR", abbr: "WR", label: "Williams %R", pane: "wr", calcParams: [6, 10, 14], variable: true },
      { key: "bbi", name: "BBI", abbr: "BBI", label: "Bull bear index", pane: "bbi", calcParams: [3, 6, 12, 24] },
    ],
  },
];

const STUDY_OPTIONS = new Map(STUDY_GROUPS.flatMap((group) => group.options).map((option) => [option.key, option]));

/** The periods in force for a study: the trader's own if they set one, otherwise the usual setting. */
function effectiveParams(option: StudyOption, overrides: Record<string, number[]>): number[] {
  const stored = overrides[option.key];
  return Array.isArray(stored) && stored.length ? stored : option.calcParams;
}

/**
 * One study's periods read back as text. A study that draws a line per period says so, because typing a
 * fourth number into MACD would otherwise look like it worked while the chart still drew three.
 */
function paramRule(option: StudyOption): string {
  const count = option.calcParams.length;
  const shape = option.variable
    ? `one number per line, up to ${count}`
    : `${count} number${count === 1 ? "" : "s"}`;
  return `${option.abbr} takes ${shape}${option.paramHint ? ` — ${option.paramHint}` : ""}.`;
}

/** Reads the trader's typing into periods, and says in `error` what is wrong when it is not periods. */
function parseParams(raw: string, option: StudyOption): { params: number[]; error: string | null } {
  const parts = raw.split(/[^0-9.]+/).filter(Boolean);
  const params = parts.map((entry) => Number(entry));
  if (!parts.length) return { params: [], error: paramRule(option) };
  if (params.some((value) => !isFinite(value) || value <= 0)) {
    return { params: [], error: "Every period has to be a number above zero." };
  }
  if (params.length > option.calcParams.length || (!option.variable && params.length !== option.calcParams.length)) {
    return { params: [], error: paramRule(option) };
  }
  return { params, error: null };
}

/**
 * Names the bundled library registers as overlays. A tool waits for its taps on the chart, so the count
 * is printed with it — a line no one finished drawing is the one thing that would otherwise pile up.
 */
const DRAW_TOOLS = [
  { name: "segment", label: "Trend line", taps: "tap two points" },
  { name: "horizontalStraightLine", label: "Horizontal line", taps: "tap a price" },
  { name: "straightLine", label: "Extended line", taps: "tap two points, it runs past both" },
  { name: "rayLine", label: "Ray", taps: "tap a start, then a direction" },
  { name: "verticalStraightLine", label: "Vertical line", taps: "tap a moment in time" },
  { name: "parallelStraightLine", label: "Parallel channel", taps: "tap three points" },
  { name: "priceChannelLine", label: "Price channel", taps: "tap three points" },
  { name: "fibonacciLine", label: "Fibonacci", taps: "tap the swing low, then the high" },
];

const HINT_VISIBLE_MS = 6000;

const IST_OFFSET_MS = 19_800_000;

/** Today in the exchange's calendar, which is not the phone's when the device is set elsewhere. */
function istToday(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** "2026-11-20" read as a calendar day, not as midnight UTC. */
function formatSession(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date).toLocaleDateString([], { day: "2-digit", month: "short" });
}

/** A stamp read on the exchange's clock. The epoch is universal; the wall time printed beside it is not. */
function istClock(at: number): string {
  return new Date(at + IST_OFFSET_MS).toISOString().slice(11, 19);
}

/** The record's bars, ending with the candle the recorder is still building. */
function withForming(candles: readonly Candle[], forming: Candle | null | undefined, limit: number): Candle[] {
  const rows = limit ? candles.slice(-limit) : [...candles];
  const last = rows[rows.length - 1];
  return forming && (!last || forming.timestamp > last.timestamp) ? [...rows, forming] : rows;
}

/**
 * A chart nobody has scrolled back on: nothing beyond the window it was served. `nonce` is one per change
 * the canvas has to apply, so a rerender cannot put the same session on twice.
 */
function noPages(key: string): { key: string; bars: Candle[]; more: boolean; nonce: number } {
  return { key, bars: [], more: false, nonce: 0 };
}

/**
 * `seed` lets the stock screen mount the desk as its own body: the route hands nothing and reads its params,
 * a caller that already knows the instrument passes `NSE:SYMBOL` and the desk opens on it directly.
 */
export default function TerminalChartsScreen({ seed }: { seed?: string }) {
  const { resolvedTheme } = useTheme();
  const { useTerminalChart, useChainUnderlyings, readOlderCandles } = useApi();
  const seeded = useLocalSearchParams<{ symbol?: string }>();
  // A press on a stock's "Chart" tab arrives with that symbol, so the desk opens on the instrument the
  // trader was just looking at instead of on the default index. The route takes `NSE:SYMBOL` for a cash
  // stock, which is what chartInstrument() on the shared side builds from it anyway.
  const [symbol, setSymbol] = useState<string>(() => String(seed ?? seeded.symbol ?? "").trim().toUpperCase() || DEFAULT_SYMBOL);
  const [interval, setInterval] = useState<IntervalId>(DEFAULT_INTERVAL);
  const [showSymbolPicker, setShowSymbolPicker] = useState(false);
  const [search, setSearch] = useState("");
  const [chartHeight, setChartHeight] = useState(500);
  const [isReady, setIsReady] = useState(false);
  const [studyKeys, setStudyKeys] = useState<string[]>([]);
  /** Periods the trader typed over the usual ones, keyed by study. Absent means "use the default". */
  const [studyParams, setStudyParams] = useState<Record<string, number[]>>({});
  const [editingStudy, setEditingStudy] = useState<string | null>(null);
  const [paramDraft, setParamDraft] = useState("");
  const [paramError, setParamError] = useState<string | null>(null);
  const [showStudyPicker, setShowStudyPicker] = useState(false);
  const [showDrawPicker, setShowDrawPicker] = useState(false);
  const [draw, setDraw] = useState<ChartDraw | null>(null);
  const [hint, setHint] = useState<{ text: string; at: number } | null>(null);
  /** The session to chart, or null for whatever the route answers for. Only intraday intervals take it. */
  const [day, setDay] = useState<string | null>(null);
  const [showDayPicker, setShowDayPicker] = useState(false);
  // Kept across a fetch so the picker still has rows while the next session loads.
  const [dayList, setDayList] = useState<string[]>([]);
  // Whether this screen has built its chart canvas. The WebView parses the whole chart library when it is
  // created, so it is built once and then kept: a load or a failure shows over it instead of replacing it.
  const [canvasUp, setCanvasUp] = useState(false);
  // A repeated press of the same tool is a new request, so each arming carries its own number.
  const drawNonce = useRef(0);
  // Whether the chart currently holds a line the trader drew, so a timeframe change says so only when it does.
  const drewLines = useRef(false);
  // The symbol the stored study sets were read for, so a save never writes the previous chart's set.
  const studyPrefs = useRef<{ symbol: string; map: Record<string, string[]> } | null>(null);

  const say = useCallback((text: string) => setHint({ text, at: Date.now() }), []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsReady(true);
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), HINT_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [hint]);

  // One stored map for every symbol, read once per chart the trader opens.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let map: Record<string, string[]> = {};
      try {
        const raw = await AsyncStorage.getItem(STUDY_STORAGE);
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === "object") map = parsed as Record<string, string[]>;
      } catch {
        // A preference that cannot be read is no reason to show an empty chart or an error.
      }
      if (cancelled) return;
      studyPrefs.current = { symbol, map };
      const stored = map[symbol];
      setStudyKeys(Array.isArray(stored) ? stored.filter((key) => STUDY_OPTIONS.has(key)) : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  // Periods are the phone's, not the chart's, so they are read once rather than on every symbol switch.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let map: Record<string, number[]> = {};
      try {
        const raw = await AsyncStorage.getItem(STUDY_PARAM_STORAGE);
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === "object") map = parsed as Record<string, number[]>;
      } catch {
        // A preference that cannot be read only costs the trader the usual periods.
      }
      if (cancelled) return;
      const kept: Record<string, number[]> = {};
      Object.keys(map).forEach((key) => {
        const value = map[key];
        if (STUDY_OPTIONS.has(key) && Array.isArray(value) && value.length && value.every((n) => isFinite(n) && n > 0)) {
          kept[key] = value;
        }
      });
      setStudyParams(kept);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveParams = useCallback((next: Record<string, number[]>) => {
    setStudyParams(next);
    AsyncStorage.setItem(STUDY_PARAM_STORAGE, JSON.stringify(next)).catch(() => {});
  }, []);

  useEffect(() => {
    const stored = studyPrefs.current;
    if (!stored || stored.symbol !== symbol) return;
    stored.map = { ...stored.map, [symbol]: studyKeys };
    AsyncStorage.setItem(STUDY_STORAGE, JSON.stringify(stored.map)).catch(() => {});
  }, [symbol, studyKeys]);

  const toggleStudy = useCallback(
    (key: string) => {
      const option = STUDY_OPTIONS.get(key);
      if (!option) return;
      if (studyKeys.includes(key)) {
        setStudyKeys(studyKeys.filter((entry) => entry !== key));
        return;
      }
      const panesInUse = studyKeys.filter((entry) => STUDY_OPTIONS.get(entry)?.pane !== "candle").length;
      if (option.pane !== "candle" && panesInUse >= MAX_PANES) {
        say(`${MAX_PANES} panes is all the chart keeps readable — switch one off to add ${option.label}.`);
        return;
      }
      setStudyKeys([...studyKeys, key]);
    },
    [studyKeys, say],
  );

  const armDraw = useCallback(
    (name: string) => {
      drawNonce.current += 1;
      drewLines.current = true;
      setDraw({ name, nonce: drawNonce.current });
      setShowDrawPicker(false);
      const tool = DRAW_TOOLS.find((entry) => entry.name === name);
      say(tool ? `${tool.label} — ${tool.taps}.` : "Line armed — tap the chart.");
    },
    [say],
  );

  const clearDrawings = useCallback(() => {
    drawNonce.current += 1;
    drewLines.current = false;
    setDraw({ name: null, nonce: drawNonce.current });
    setShowDrawPicker(false);
    say("Every line drawn on this chart is gone.");
  }, [say]);

  const openParamEditor = useCallback(
    (option: StudyOption) => {
      if (editingStudy === option.key) {
        setEditingStudy(null);
        return;
      }
      setEditingStudy(option.key);
      setParamDraft(effectiveParams(option, studyParams).join(", "));
      setParamError(null);
    },
    [editingStudy, studyParams],
  );

  const applyParam = useCallback(() => {
    const option = editingStudy ? STUDY_OPTIONS.get(editingStudy) : undefined;
    if (!option) return;
    const parsed = parseParams(paramDraft, option);
    if (parsed.error) {
      setParamError(parsed.error);
      return;
    }
    saveParams({ ...studyParams, [option.key]: parsed.params });
    setEditingStudy(null);
    say(`${option.abbr} now uses ${parsed.params.join(", ")}.`);
  }, [editingStudy, paramDraft, say, saveParams, studyParams]);

  const resetParam = useCallback(() => {
    const option = editingStudy ? STUDY_OPTIONS.get(editingStudy) : undefined;
    if (!option) return;
    const rest = { ...studyParams };
    delete rest[option.key];
    saveParams(rest);
    setEditingStudy(null);
    say(`${option.abbr} back to its usual ${option.calcParams.join(", ")}.`);
  }, [editingStudy, say, saveParams, studyParams]);

  const studies = useMemo<ChartStudy[]>(
    () =>
      studyKeys.flatMap((key) => {
        const option = STUDY_OPTIONS.get(key);
        if (!option) return [];
        return [{ key: option.key, name: option.name, pane: option.pane, calcParams: effectiveParams(option, studyParams) }];
      }),
    [studyKeys, studyParams],
  );

  const handleSymbolChange = useCallback((newSymbol: string) => {
    setSymbol(newSymbol);
    // The next symbol opens plain, then shows the set stored for it: leaving the previous chart's studies
    // on screen would paint them over candles they were never chosen for. The session goes with the symbol,
    // because the one just listed belongs to the instrument that was on screen.
    setStudyKeys([]);
    setDay(null);
    setDayList([]);
    drewLines.current = false;
    setDraw(null);
  }, []);

  const handleIntervalChange = useCallback(
    (newInterval: IntervalId) => {
      setInterval(newInterval);
      // A line is placed against bars of one timeframe, so it is not carried onto another.
      if (drewLines.current) {
        drawNonce.current += 1;
        drewLines.current = false;
        setDraw({ name: null, nonce: drawNonce.current });
        say(`Lines were drawn on the previous timeframe, so they are cleared for ${newInterval}.`);
      }
    },
    [say],
  );

  const chooseDay = useCallback(
    (next: string | null) => {
      setDay(next);
      setShowDayPicker(false);
      // Bars of one session carry lines drawn against them; the next session gets a clean canvas.
      if (drewLines.current) {
        drawNonce.current += 1;
        drewLines.current = false;
        setDraw({ name: null, nonce: drawNonce.current });
      }
      say(next === null ? "Showing the newest session the chart route answers for." : `Charting the ${formatSession(next)} session, as recorded.`);
    },
    [say],
  );

  const isDaily = DAILY_INTERVALS.has(interval);
  const today = istToday();
  // A session chosen that is not today's is served from the recorded archive, so nothing about it changes
  // between one poll and the next.
  const pastPick = !isDaily && day !== null && day !== today;
  const { data: chartData, isLoading, isError, error, refetch } = useTerminalChart(symbol, interval, {
    // The stream paints the forming candle, so the record only has to reconcile the completed bars.
    refetchInterval: isDaily || pastPick ? false : 30_000,
    gcTime: 30 * 60 * 1000,
    staleTime: isDaily ? 5 * 60 * 1000 : 15_000,
    // Keep the last candles on screen while a new interval or session of the SAME symbol loads, so the chart
    // is not swapped for a spinner. Another symbol's candles are never shown under this one's name, and
    // another session's would be drawn under a date that is not theirs.
    placeholderData: (previous, previousQuery) => {
      const key = previousQuery?.queryKey as readonly unknown[] | undefined;
      return key?.[2] === chartInstrument(symbol) && key?.[4] === (day ?? null) ? previous : undefined;
    },
  }, day);

  const session = useTerminalChart(symbol, "5m", { enabled: interval === "1d", refetchInterval: 60_000, gcTime: 30 * 60 * 1000, staleTime: 30_000 });
  const underlyings = useChainUnderlyings();

  const allUnderlyings = underlyings.data?.underlyings ?? [];
  const sections = useMemo(() => chartPickerSections(allUnderlyings, search), [allUnderlyings, search]);

  const candles = chartData?.candles ?? [];
  // The route names the session it read; without that the chip would have to guess between today and the
  // newest record it fell back to.
  const sessionDay = chartData?.day ?? day;
  const lookingBack = !isDaily && !!sessionDay && sessionDay !== today;
  const baseCandles = useMemo(
    () => withForming(candles, chartData?.forming, isDaily ? DAILY_CANDLES_SHOWN : INTRADAY_CANDLES_SHOWN),
    [candles, chartData?.forming, isDaily],
  );
  const sessionCandles = useMemo(
    () => (interval === "1d" ? withForming(session.data?.candles ?? [], session.data?.forming, INTRADAY_CANDLES_SHOWN) : []),
    [interval, session.data],
  );
  const focused = useScreenFocused();
  // A stored session is exactly that: today's ticks belong to today's chart, not to the bars the recorder
  // kept for an earlier day, so the stream is left off while one is on screen.
  const live = useLiveCandles(symbol, interval as ChartBucket, baseCandles, sessionCandles, focused && !lookingBack);

  const chartDataPoints = useMemo(
    () => live.points.map((c) => ({
      timestamp: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? 0,
    })),
    [live.points],
  );

  const availableDays = chartData?.availableDays;

  // Only the window the route chose for itself pages backwards. A session picked from the list is answered
  // whole, and asking the route for a page and a day at once is a question it refuses on purpose. A daily
  // chart has no session to pick: the archive is one long series and the page it served is the top of it, so
  // the sessions beneath are always worth asking for.
  const pagesBack = isDaily || day === null;

  // Switching the instrument, the bucket or the session is a different chart. The pages are keyed to the one
  // they were fetched for, so a scroll-back that was still in flight cannot put another chart's sessions on
  // the new canvas, and the chart is told there are none before its new candles arrive.
  const chartKey = `${symbol}|${interval}|${day ?? ""}`;
  const [paged, setPaged] = useState(() => noPages(chartKey));
  const older = paged.key === chartKey ? paged : noPages(chartKey);
  const currentKey = useRef(chartKey);
  currentKey.current = chartKey;

  // Whether there is anything older than this window, in the server's own words rather than a guess. Nothing
  // is fetched on the strength of it until the trader scrolls or zooms towards the left edge.
  useEffect(() => {
    const ahead = pagesBack && olderAhead(chartData);
    setPaged(current => {
      const held = current.key === chartKey ? current : noPages(chartKey);
      return held.more === ahead ? held : { ...held, more: ahead, nonce: held.nonce + 1 };
    });
  }, [chartKey, pagesBack, chartData?.moreHistory, chartData?.hasMore]);

  const askOlder = useCallback((before: number) => {
    if (!pagesBack) {
      // The chart is waiting for an answer it will not get, so give it one that stops it asking.
      setPaged(current => ({ ...noPages(chartKey), nonce: current.nonce + 1 }));
      return;
    }
    void (async () => {
      let bars: Candle[] = [];
      let ahead = false;
      let answered = false;
      try {
        const page = await readOlderCandles(symbol, interval, before);
        bars = page.candles ?? [];
        ahead = olderAhead(page);
        answered = true;
      } catch {
        answered = false;
      }
      if (currentKey.current !== chartKey) return;
      setPaged(current => {
        const held = current.key === chartKey ? current : noPages(chartKey);
        return {
          key: chartKey,
          bars: mergeOlderCandles(held.bars, bars, OLDER_BARS_HELD),
          // A page that came back empty says the record ends here; a read that failed says nothing, so the
          // next scroll is free to ask for the same page again.
          more: answered ? (bars.length > 0 && ahead) : held.more,
          nonce: held.nonce + 1,
        };
      });
    })();
  }, [chartKey, interval, pagesBack, readOlderCandles, symbol]);

  // Read when the sheet opens rather than kept in step with every fetch: the list belongs to the picker and
  // must not re-render the chart underneath it.
  const openDayPicker = useCallback(() => {
    if (availableDays?.length) setDayList([...availableDays]);
    setShowDayPicker(true);
  }, [availableDays]);

  const colors = useMemo(() => resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#64748b", border: "#334155", accent: "#38bdf8", up: "#22c55e", down: "#ef4444" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", accent: "#0284c7", up: "#16a34a", down: "#dc2626" }, [resolvedTheme]);

  // What the stream itself says about the price behind the newest bar, in the server's own words. A stored
  // session has no live price to report, and saying so beats showing a stale tick label under it.
  const liveText = lookingBack
    ? `Stored session ${sessionDay}: the candles the recorder kept. Today's prices are not drawn on an earlier day.`
    : live.unavailable ?? tickLabel(live.tick, live.connected, live.reason);
  const liveAt = lookingBack || live.at === null ? null : istClock(live.at);
  const liveColor = lookingBack ? colors.muted : live.tick?.fresh ? colors.up : live.reason || live.tick ? colors.down : colors.muted;

  const sessionCount = candles.length ? ` · ${candles.length} bars of ${interval}` : "";
  // What the canvas holds beyond the fetched session, and whether anything older is left to scroll for.
  // A chart that quietly stops at its first loaded bar reads like a broken one.
  const pagedLine = !pagesBack ? "" : older.bars.length
    ? ` · ${older.bars.length} older bars paged in${older.more ? ", scroll left for more" : " · the record starts here"}`
    : olderAhead(chartData) ? " · scroll or zoom out for older sessions" : "";
  const sourceLine = isDaily
    ? `${chartData?.source ?? "Stored daily history"}${chartDataPoints.length < candles.length ? ` · showing ${chartDataPoints.length} of ${candles.length} sessions` : ""}${pagedLine}`
    : `${chartData?.source ?? "Recorded session"} · ${sessionDay ?? today}${sessionCount}${pagedLine}`;

  // What the session control is worth showing: the trader should see which day is on screen, not assume it.
  const sessionLabel = !sessionDay ? "Session" : sessionDay === today ? "Today" : formatSession(sessionDay);

  const styles = useMemo(() => createStyles(colors), [colors]);

  const pick = (name: string) => {
    handleSymbolChange(name);
    setShowSymbolPicker(false);
    setSearch("");
  };

  // What to say when the candles are not on screen. Before the canvas exists this is the whole screen; after
  // it, the same message goes over the chart, because replacing the canvas means rebuilding it.
  let state: React.ReactNode = null;
  if (isLoading && !chartDataPoints.length) {
    state = (
      <View style={styles.stateBox}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.stateBody}>Loading {interval} candles for {symbol}...</Text>
      </View>
    );
  } else if (isError && !chartDataPoints.length) {
    const isStock = !["NIFTY", "BANKNIFTY"].includes(symbol.toUpperCase());
    const isIntraday = !isDaily;

    // A live tick is a better answer than a failed history read: the stream paints the bar it has a price for.
    state = (
      <View style={styles.stateBox}>
        <Ionicons name="alert-circle-outline" size={48} color={colors.down} />
        <Text style={styles.stateTitle}>No {interval} chart for {symbol}</Text>
        <Text style={styles.stateBody}>
          {isIntraday && isStock
            ? `Intraday bars for ${chartInstrument(symbol)} are read from the sessions this account streamed; the broker's own history covers only the live window (09:15–15:30 IST). Switch to Daily (1d) for stored history, or pick another session.`
            : chartFailureReason(error)}
        </Text>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 16, flexWrap: "wrap", justifyContent: "center" }}>
          {isIntraday && (
            <TouchableOpacity
              style={[styles.actionButton, { marginTop: 0, minWidth: 140 }]}
              onPress={() => handleIntervalChange("1d")}
              accessibilityRole="button"
              accessibilityLabel="Switch to Daily"
            >
              <Text style={styles.actionLabel}>View Daily (1d)</Text>
            </TouchableOpacity>
          )}
          {symbol !== "NIFTY" && (
            <TouchableOpacity
              style={[
                styles.actionButton,
                { marginTop: 0, minWidth: 140, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
              ]}
              onPress={() => handleSymbolChange("NIFTY")}
              accessibilityRole="button"
              accessibilityLabel="Switch to NIFTY"
            >
              <Text style={[styles.actionLabel, { color: colors.text }]}>View NIFTY</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[
              styles.actionButton,
              { marginTop: 0, minWidth: 100, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
            ]}
            onPress={() => refetch()}
            accessibilityRole="button"
            accessibilityLabel="Retry"
          >
            <Text style={[styles.actionLabel, { color: colors.text }]}>Retry</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  } else if (!chartDataPoints.length) {
    const isStock = !["NIFTY", "BANKNIFTY"].includes(symbol.toUpperCase());
    const isIntraday = !isDaily;

    state = (
      <View style={styles.stateBox}>
        <Ionicons name="bar-chart-outline" size={48} color={colors.muted} />
        <Text style={styles.stateTitle}>No candles returned</Text>
        <Text style={styles.stateBody}>
          {isIntraday && isStock
            ? `Intraday bars for ${chartInstrument(symbol)} are recorded from the first tick the server saw for that symbol, so a session before that has none. Switch to Daily (1d) for stored history, or pick another session.`
            : chartData?.source
              ? `${chartData.source} returned no ${interval} bars for ${chartInstrument(symbol)}.`
              : `No ${interval} bars came back for ${chartInstrument(symbol)}.`}
        </Text>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 16, flexWrap: "wrap", justifyContent: "center" }}>
          {isIntraday && (
            <TouchableOpacity
              style={[styles.actionButton, { marginTop: 0, minWidth: 140 }]}
              onPress={() => handleIntervalChange("1d")}
              accessibilityRole="button"
              accessibilityLabel="Switch to Daily"
            >
              <Text style={styles.actionLabel}>View Daily (1d)</Text>
            </TouchableOpacity>
          )}
          {symbol !== "NIFTY" && (
            <TouchableOpacity
              style={[
                styles.actionButton,
                { marginTop: 0, minWidth: 140, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
              ]}
              onPress={() => handleSymbolChange("NIFTY")}
              accessibilityRole="button"
              accessibilityLabel="Switch to NIFTY"
            >
              <Text style={[styles.actionLabel, { color: colors.text }]}>View NIFTY</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[
              styles.actionButton,
              { marginTop: 0, minWidth: 100, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
            ]}
            onPress={() => refetch()}
            accessibilityRole="button"
            accessibilityLabel="Refresh"
          >
            <Text style={[styles.actionLabel, { color: colors.text }]}>Refresh</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  } else if (!isReady) {
    state = (
      <View style={styles.stateBox}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.stateBody}>Initializing chart canvas...</Text>
      </View>
    );
  }

  const chartNode = (
    <View
      style={{ flex: 1 }}
      onLayout={(e) => {
        const h = Math.round(e.nativeEvent.layout.height);
        if (h > 100 && h !== chartHeight) setChartHeight(h);
        // The canvas has been laid out with candles on it. From here on a switch keeps it, because tearing
        // the WebView down and building it again is what a switch used to cost.
        if (!canvasUp) setCanvasUp(true);
      }}
    >
      {/* The chart asks for the sessions behind its own left edge, so scrolling back is a fetch rather
          than a wall. */}
      <KLineChart data={chartDataPoints} height={chartHeight} symbol={symbol} studies={studies} draw={draw} history={pagesBack ? older : undefined} onNeedMore={askOlder} />
      {state && <View style={styles.stateScrim}>{state}</View>}
    </View>
  );

  // The canvas is built once. Until it exists there is nothing to lay a message over, so the message itself
  // is the screen; after that a load, a failure or an empty answer shows on top of it.
  let body: React.ReactNode;
  if (canvasUp) body = chartNode;
  else if (state) body = state;
  else body = chartNode;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.title}>Terminal</Text>
          <TouchableOpacity style={styles.symbolButton} onPress={() => setShowSymbolPicker(true)} accessibilityRole="button" accessibilityLabel="Choose chart symbol">
            <Ionicons name="search-outline" size={18} color={colors.muted} />
            <Text style={styles.symbolText}>{symbol}</Text>
            <Ionicons name="chevron-down-outline" size={16} color={colors.muted} />
          </TouchableOpacity>
        </View>
        <Text style={styles.meta}>
          {`${chartInstrument(symbol)}\n${interval} · ${isDaily ? "daily candles" : "intraday candles"}`}
        </Text>
      </View>

      <View style={styles.intervalRow}>
        {INTERVALS.map((entry) => (
          <TouchableOpacity
            key={entry.id}
            style={[styles.intervalButton, interval === entry.id && styles.intervalButtonActive]}
            onPress={() => handleIntervalChange(entry.id)}
            accessibilityRole="button"
            accessibilityLabel={`${entry.label} candles`}
          >
            <Text style={[styles.intervalLabel, interval === entry.id && styles.intervalLabelActive]}>{entry.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView style={styles.studyRow} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.studyRowContent}>
        <TouchableOpacity style={styles.studyChip} onPress={() => setShowStudyPicker(true)} accessibilityRole="button" accessibilityLabel="Add an indicator">
          <Ionicons name="add-circle-outline" size={14} color={colors.accent} />
          <Text style={[styles.studyChipText, { color: colors.accent }]}>{studyKeys.length ? `Indicators (${studyKeys.length})` : "Indicators"}</Text>
        </TouchableOpacity>
        {studyKeys.map((key) => (
          <TouchableOpacity
            key={key}
            style={styles.studyChipActive}
            onPress={() => toggleStudy(key)}
            accessibilityRole="button"
            accessibilityLabel={`Switch off ${STUDY_OPTIONS.get(key)?.label ?? key}`}
          >
            <Text style={styles.studyChipActiveText}>{STUDY_OPTIONS.get(key)?.abbr ?? key}</Text>
            <Ionicons name="close" size={12} color={colors.muted} />
          </TouchableOpacity>
        ))}
        <TouchableOpacity style={styles.studyChip} onPress={() => setShowDrawPicker(true)} accessibilityRole="button" accessibilityLabel="Draw a line on the chart">
          <Ionicons name="create-outline" size={14} color={colors.accent} />
          <Text style={[styles.studyChipText, { color: colors.accent }]}>Draw</Text>
        </TouchableOpacity>
      </ScrollView>

      <View style={styles.liveRow}>
        <View style={[styles.liveDot, { backgroundColor: liveColor }]} />
        <Text style={[styles.liveText, { color: liveColor }]} numberOfLines={2}>{liveText}</Text>
        {liveAt !== null && <Text style={styles.liveTime}>{liveAt}</Text>}
      </View>

      <View style={styles.sourceRow}>
        <Text style={styles.sourceText} numberOfLines={2}>{hint ? hint.text : sourceLine}</Text>
        {!isDaily && (
          <TouchableOpacity
            style={styles.sessionButton}
            onPress={openDayPicker}
            accessibilityRole="button"
            accessibilityLabel="Choose which trading session to chart"
          >
            <Ionicons name="calendar-outline" size={13} color={colors.accent} />
            <Text style={styles.sessionText}>{sessionLabel}</Text>
            <Ionicons name="chevron-down-outline" size={12} color={colors.muted} />
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.chartContainer}>{body}</View>

      <Modal visible={showSymbolPicker} animationType="slide" onRequestClose={() => setShowSymbolPicker(false)}>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Chart symbol</Text>
            <TextInput
              style={styles.search}
              placeholder="Search indices and F&O stocks"
              placeholderTextColor={colors.muted}
              autoCapitalize="characters"
              value={search}
              onChangeText={setSearch}
            />
            {underlyings.isError && (
              <Text style={styles.notice}>The listed derivatives master could not be read: {chartFailureReason(underlyings.error)}</Text>
            )}
            {!underlyings.isError && underlyings.isLoading && <Text style={styles.notice}>Loading listed F&O symbols...</Text>}
            {!underlyings.isError && !underlyings.isLoading && !sections.length && (
              <Text style={styles.notice}>No listed symbol matches {`“${search}”`}</Text>
            )}
            <SectionList
              sections={sections}
              keyExtractor={(item) => item.name}
              stickySectionHeadersEnabled={false}
              renderSectionHeader={({ section }) => <Text style={styles.sectionTitle}>{section.title}</Text>}
              renderItem={({ item }) => {
                const has1sData = ["NIFTY", "BANKNIFTY"].includes(item.name.toUpperCase());
                return (
                  <TouchableOpacity style={styles.row} onPress={() => pick(item.name)} accessibilityRole="button" accessibilityLabel={`Chart ${item.name}`}>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <Text style={styles.rowName}>{item.name}</Text>
                        {has1sData && (
                          <View style={{ backgroundColor: colors.accent + "20", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                            <Text style={{ fontSize: 10, fontWeight: "600", color: colors.accent }}>1s data</Text>
                          </View>
                        )}
                      </View>
                      <Text style={styles.rowMeta}>{chartInstrument(item.name)} · lot {item.lotSize}</Text>
                    </View>
                    <Ionicons
                      name={symbol === item.name ? "checkmark-circle-outline" : "radio-button-off-outline"}
                      size={22}
                      color={symbol === item.name ? colors.accent : colors.muted}
                    />
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        </View>
      </Modal>

      <Modal visible={showStudyPicker} animationType="slide" onRequestClose={() => setShowStudyPicker(false)}>
        <View style={styles.sheetScrim}>
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>Indicators</Text>
              <TouchableOpacity onPress={() => setShowStudyPicker(false)} accessibilityRole="button" accessibilityLabel="Close indicators">
                <Text style={styles.sheetDone}>Done</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.groupNote}>
              Off by default. The chart opens as candles only, and each symbol keeps the set it was last shown with. The pencil sets a study's periods.
            </Text>
            <ScrollView style={styles.sheetScroll} keyboardShouldPersistTaps="handled">
              {STUDY_GROUPS.map((group) => (
                <View key={group.title} style={styles.sheetGroup}>
                  <Text style={styles.sectionTitle}>{group.title}</Text>
                  <Text style={styles.groupNote}>{group.note}</Text>
                  {group.options.map((option) => {
                    const on = studyKeys.includes(option.key);
                    const active = editingStudy === option.key;
                    const current = effectiveParams(option, studyParams);
                    const edited = current.join(",") !== option.calcParams.join(",");
                    return (
                      <View key={option.key}>
                        <View style={styles.row}>
                          <TouchableOpacity
                            style={styles.studyToggle}
                            onPress={() => toggleStudy(option.key)}
                            accessibilityRole="switch"
                            accessibilityState={{ checked: on }}
                            accessibilityLabel={`${option.label}, ${option.abbr} ${current.join(", ")}`}
                          >
                            <View style={{ flex: 1 }}>
                              <Text style={styles.rowName}>{option.label}</Text>
                              <Text style={[styles.rowMeta, edited && { color: colors.accent }]}>
                                {`${option.abbr} · ${current.join(", ")}${edited ? " · set by you" : ""}`}
                              </Text>
                            </View>
                            <Ionicons name={on ? "checkbox-outline" : "square-outline"} size={22} color={on ? colors.accent : colors.muted} />
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={styles.paramEdit}
                            onPress={() => openParamEditor(option)}
                            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                            accessibilityRole="button"
                            accessibilityLabel={active ? `Cancel editing ${option.label} periods` : `Edit ${option.label} periods`}
                          >
                            <Ionicons name={active ? "close-outline" : "create-outline"} size={19} color={active ? colors.down : colors.accent} />
                          </TouchableOpacity>
                        </View>
                        {active && (
                          <View style={styles.paramEditor}>
                            <Text style={styles.paramRule}>{paramRule(option)}</Text>
                            <View style={styles.paramInputRow}>
                              <TextInput
                                style={styles.paramInput}
                                value={paramDraft}
                                onChangeText={(text) => {
                                  setParamDraft(text);
                                  setParamError(null);
                                }}
                                placeholder={option.calcParams.join(", ")}
                                placeholderTextColor={colors.muted}
                                keyboardType="numbers-and-punctuation"
                                autoCapitalize="none"
                                autoCorrect={false}
                                returnKeyType="done"
                                onSubmitEditing={applyParam}
                                accessibilityLabel={`${option.label} periods`}
                              />
                              <TouchableOpacity style={styles.paramApply} onPress={applyParam} accessibilityRole="button" accessibilityLabel="Apply these periods">
                                <Text style={styles.paramApplyText}>Apply</Text>
                              </TouchableOpacity>
                              {edited && (
                                <TouchableOpacity style={styles.paramReset} onPress={resetParam} accessibilityRole="button" accessibilityLabel="Reset to the usual periods">
                                  <Text style={styles.paramResetText}>Reset</Text>
                                </TouchableOpacity>
                              )}
                            </View>
                            {paramError && <Text style={styles.paramError}>{paramError}</Text>}
                          </View>
                        )}
                      </View>
                    );
                  })}
                </View>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={showDrawPicker} animationType="slide" onRequestClose={() => setShowDrawPicker(false)}>
        <View style={styles.sheetScrim}>
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>Draw</Text>
              <TouchableOpacity onPress={() => setShowDrawPicker(false)} accessibilityRole="button" accessibilityLabel="Close draw tools">
                <Text style={styles.sheetDone}>Done</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.groupNote}>Pick a tool, then tap the chart the number of times it asks for. Drag a line to move it.</Text>
            <ScrollView style={styles.sheetScroll} keyboardShouldPersistTaps="handled">
              {DRAW_TOOLS.map((tool) => (
                <TouchableOpacity key={tool.name} style={styles.row} onPress={() => armDraw(tool.name)} accessibilityRole="button" accessibilityLabel={`${tool.label}, ${tool.taps}`}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowName}>{tool.label}</Text>
                    <Text style={styles.rowMeta}>{tool.taps}</Text>
                  </View>
                  <Ionicons name="create-outline" size={18} color={colors.muted} />
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={styles.clearButton} onPress={clearDrawings} accessibilityRole="button" accessibilityLabel="Remove every line drawn on this chart">
              <Ionicons name="trash-outline" size={16} color={colors.down} />
              <Text style={styles.clearLabel}>Remove all lines on this chart</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={showDayPicker} animationType="slide" onRequestClose={() => setShowDayPicker(false)}>
        <View style={styles.sheetScrim}>
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>Session</Text>
              <TouchableOpacity onPress={() => setShowDayPicker(false)} accessibilityRole="button" accessibilityLabel="Close session picker">
                <Text style={styles.sheetDone}>Done</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.groupNote}>
              {`${chartInstrument(symbol)} · ${interval}: only the sessions listed here have candles stored. A day outside this list has nothing to draw.`}
            </Text>
            <ScrollView style={styles.sheetScroll} keyboardShouldPersistTaps="handled">
              <TouchableOpacity style={styles.row} onPress={() => chooseDay(null)} accessibilityRole="button" accessibilityLabel="Chart the latest session">
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowName}>Latest session</Text>
                  <Text style={styles.rowMeta}>
                    {day === null && sessionDay ? `Currently showing ${sessionDay}.` : `Asks the chart route for its newest session (${today}).`}
                  </Text>
                </View>
                <Ionicons name={day === null ? "checkmark-circle-outline" : "radio-button-off-outline"} size={22} color={day === null ? colors.accent : colors.muted} />
              </TouchableOpacity>
              {dayList.map((entry) => (
                <TouchableOpacity
                  key={entry}
                  style={styles.row}
                  onPress={() => chooseDay(entry)}
                  accessibilityRole="button"
                  accessibilityLabel={`Chart the ${entry} session`}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowName}>{formatSession(entry)}</Text>
                    <Text style={styles.rowMeta}>{entry === today ? `${entry} · today` : entry}</Text>
                  </View>
                  <Ionicons name={sessionDay === entry ? "checkmark-circle-outline" : "radio-button-off-outline"} size={22} color={sessionDay === entry ? colors.accent : colors.muted} />
                </TouchableOpacity>
              ))}
              {!dayList.length && (
                <Text style={styles.notice}>The chart has not listed its sessions yet. Let the {interval} candles finish loading, then open this again.</Text>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function createStyles(colors: { bg: string; card: string; text: string; muted: string; border: string; accent: string; up: string; down: string }) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
    headerLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
    title: { fontSize: 18, fontWeight: "700", color: colors.text },
    symbolButton: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.card, borderRadius: 6, borderWidth: 1, borderColor: colors.border },
    symbolText: { fontSize: 14, fontWeight: "600", color: colors.text },
    meta: { fontSize: 10, color: colors.muted, textAlign: "right" },
    intervalRow: { flexDirection: "row", gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
    intervalButton: { paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.card, borderRadius: 6, borderWidth: 1, borderColor: colors.border },
    intervalButtonActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    intervalLabel: { fontSize: 12, fontWeight: "600", color: colors.muted },
    intervalLabelActive: { color: "#ffffff" },
    studyRow: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: colors.border },
    studyRowContent: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 8 },
    studyChip: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 9, paddingVertical: 5, backgroundColor: colors.bg, borderRadius: 999, borderWidth: 1, borderColor: colors.border },
    studyChipActive: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 9, paddingVertical: 5, backgroundColor: `${colors.accent}22`, borderRadius: 999, borderWidth: 1, borderColor: colors.accent },
    studyChipText: { fontSize: 11.5, fontWeight: "600", color: colors.text },
    studyChipActiveText: { fontSize: 11.5, fontWeight: "700", color: colors.accent },
    sourceRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border, minHeight: 30 },
    sourceText: { flex: 1, fontSize: 10.5, color: colors.muted },
    sessionButton: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: colors.bg, borderRadius: 999, borderWidth: 1, borderColor: colors.border },
    sessionText: { fontSize: 11, fontWeight: "600", color: colors.accent },
    stateScrim: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: `${colors.card}F0`, justifyContent: "center", alignItems: "center" },
    liveRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: colors.border },
    liveDot: { width: 8, height: 8, borderRadius: 4 },
    liveText: { flex: 1, fontSize: 11, color: colors.muted },
    liveTime: { fontSize: 11, color: colors.muted },
    chartContainer: { flex: 1, margin: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, overflow: "hidden" },
    stateBox: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
    stateTitle: { marginTop: 12, fontSize: 16, fontWeight: "600", color: colors.text, textAlign: "center" },
    stateBody: { marginTop: 4, fontSize: 13, color: colors.muted, textAlign: "center", paddingHorizontal: 24 },
    actionButton: { backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8, marginTop: 16, minWidth: 200, alignItems: "center" },
    actionLabel: { fontSize: 16, fontWeight: "600", color: "#ffffff" },
    priceScale: { position: "absolute", right: 0, top: 0, bottom: 0, width: 60, justifyContent: "space-between", paddingHorizontal: 4 },
    priceScaleLabel: { fontSize: 9, color: colors.muted, textAlign: "right" },
    timeScale: { position: "absolute", bottom: 0, left: 0, right: 0, height: 30, flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 4 },
    timeScaleLabel: { fontSize: 9, color: colors.muted },
    sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, maxHeight: "80%" },
    sheetScrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
    sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    sheetDone: { fontSize: 14, fontWeight: "700", color: colors.accent, paddingHorizontal: 6, paddingVertical: 4 },
    sheetScroll: { flexShrink: 1 },
    sheetGroup: { paddingBottom: 4 },
    groupNote: { fontSize: 11.5, color: colors.muted, marginBottom: 6 },
    clearButton: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border },
    clearLabel: { fontSize: 13, fontWeight: "600", color: colors.down },
    sheetTitle: { fontSize: 18, fontWeight: "700", color: colors.text, marginBottom: 12 },
    search: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: colors.text, backgroundColor: colors.bg, marginBottom: 8 },
    sectionTitle: { fontSize: 11, fontWeight: "700", letterSpacing: 0.7, color: colors.muted, textTransform: "uppercase", paddingTop: 10, paddingBottom: 4 },
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
    studyToggle: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12 },
    paramEdit: { paddingHorizontal: 4, paddingVertical: 6 },
    paramEditor: { paddingTop: 10, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 8 },
    paramRule: { fontSize: 11.5, color: colors.muted },
    paramInputRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    paramInput: { flex: 1, borderWidth: 1, borderColor: colors.accent, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15, color: colors.text, backgroundColor: colors.bg },
    paramApply: { backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9 },
    paramApplyText: { fontSize: 13, fontWeight: "700", color: "#ffffff" },
    paramReset: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
    paramResetText: { fontSize: 13, fontWeight: "600", color: colors.text },
    paramError: { fontSize: 12, color: colors.down },
    rowName: { fontSize: 16, fontWeight: "600", color: colors.text },
    rowMeta: { fontSize: 12, color: colors.muted },
    notice: { paddingVertical: 12, fontSize: 13, color: colors.muted, textAlign: "center" },
  });
}
