/**
 * Terminal Charts - candles for any listed index or F&O underlying, moving tick by tick in the live market.
 * Minutes and hours come from the broker's intraday candles and daily and weekly candles from the stored NSE
 * end-of-day archive; that record only has to cover the completed bars. The bar being watched is then extended
 * by prod's quote stream, the same stream the web desk uses, so the candle on this screen is the current price
 * rather than the last poll.
 */

import React, { useMemo, useState, useCallback, useEffect } from "react";
import {
  ActivityIndicator,
  Modal,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import { useTheme } from "@/components/ThemeProvider";
import { useApi } from "@/hooks/useApi";
import {
  chartFailureReason,
  chartInstrument,
  chartPickerSections,
  tickLabel,
  useLiveCandles,
  type Candle,
  type ChartBucket,
} from "@nraialgo/shared/api";
import { formatRupees } from "@nraialgo/shared/utils";
import KLineChart from "@/components/KLineChart";

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

function axisLabel(timestamp: number, daily: boolean): string {
  const date = new Date(timestamp);
  if (daily) return date.toLocaleDateString([], { day: "2-digit", month: "short" });
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

/** The record's bars, ending with the candle the recorder is still building. */
function withForming(candles: readonly Candle[], forming: Candle | null | undefined, limit: number): Candle[] {
  const rows = limit ? candles.slice(-limit) : [...candles];
  const last = rows[rows.length - 1];
  return forming && (!last || forming.timestamp > last.timestamp) ? [...rows, forming] : rows;
}

export default function TerminalChartsScreen() {
  const { resolvedTheme } = useTheme();
  const { useTerminalChart, useChainUnderlyings } = useApi();
  const seeded = useLocalSearchParams<{ symbol?: string }>();
  // A press on a stock's "Chart" tab arrives with that symbol, so the desk opens on the instrument the
  // trader was just looking at instead of on the default index. The route takes `NSE:SYMBOL` for a cash
  // stock, which is what chartInstrument() on the shared side builds from it anyway.
  const [symbol, setSymbol] = useState<string>(() => String(seeded.symbol ?? "").trim().toUpperCase() || DEFAULT_SYMBOL);
  const [interval, setInterval] = useState<IntervalId>(DEFAULT_INTERVAL);
  const [showSymbolPicker, setShowSymbolPicker] = useState(false);
  const [search, setSearch] = useState("");
  const [chartKey, setChartKey] = useState(0);
  const [chartHeight, setChartHeight] = useState(500);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsReady(true);
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  const handleSymbolChange = useCallback((newSymbol: string) => {
    setSymbol(newSymbol);
    setChartKey((k) => k + 1);
  }, []);

  const handleIntervalChange = useCallback((newInterval: IntervalId) => {
    setInterval(newInterval);
    // Do not increment chartKey on interval change: let KLineChart update data smoothly via postMessage
  }, []);

  const isDaily = DAILY_INTERVALS.has(interval);
  const { data: chartData, isLoading, isError, error, refetch } = useTerminalChart(symbol, interval, {
    // The stream paints the forming candle, so the record only has to reconcile the completed bars.
    refetchInterval: isDaily ? false : 30_000,
    gcTime: 30 * 60 * 1000,
    staleTime: isDaily ? 5 * 60 * 1000 : 15_000,
  });

  const session = useTerminalChart(symbol, "5m", { enabled: interval === "1d", refetchInterval: 60_000, gcTime: 30 * 60 * 1000, staleTime: 30_000 });
  const underlyings = useChainUnderlyings();

  const allUnderlyings = underlyings.data?.underlyings ?? [];
  const sections = useMemo(() => chartPickerSections(allUnderlyings, search), [allUnderlyings, search]);

  const candles = chartData?.candles ?? [];
  const baseCandles = useMemo(
    () => withForming(candles, chartData?.forming, isDaily ? DAILY_CANDLES_SHOWN : INTRADAY_CANDLES_SHOWN),
    [candles, chartData?.forming, isDaily],
  );
  const sessionCandles = useMemo(
    () => (interval === "1d" ? withForming(session.data?.candles ?? [], session.data?.forming, INTRADAY_CANDLES_SHOWN) : []),
    [interval, session.data],
  );
  const live = useLiveCandles(symbol, interval as ChartBucket, baseCandles, sessionCandles);

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

  const colors = useMemo(() => resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#64748b", border: "#334155", accent: "#38bdf8", up: "#22c55e", down: "#ef4444" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", accent: "#0284c7", up: "#16a34a", down: "#dc2626" }, [resolvedTheme]);

  // What the stream itself says about the price behind the newest bar, in the server's own words.
  const liveText = live.unavailable ?? tickLabel(live.tick, live.connected, live.reason);
  const liveAt = live.at === null ? null : new Date(live.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const liveColor = live.tick?.fresh ? colors.up : live.reason || live.tick ? colors.down : colors.muted;

  const styles = useMemo(() => createStyles(colors), [colors]);

  const pick = (name: string) => {
    handleSymbolChange(name);
    setShowSymbolPicker(false);
    setSearch("");
  };

  let body: React.ReactNode;
  if (isLoading && !chartDataPoints.length) {
    body = (
      <View style={styles.stateBox}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.stateBody}>Loading {interval} candles for {symbol}...</Text>
      </View>
    );
  } else if (isError && !chartDataPoints.length) {
    const isStock = !["NIFTY", "BANKNIFTY"].includes(symbol.toUpperCase());
    const isIntraday = !isDaily;

    // A live tick is a better answer than a failed history read: the stream paints the bar it has a price for.
    body = (
      <View style={styles.stateBox}>
        <Ionicons name="alert-circle-outline" size={48} color={colors.down} />
        <Text style={styles.stateTitle}>No {interval} chart for {symbol}</Text>
        <Text style={styles.stateBody}>
          {isIntraday && isStock
            ? `Intraday bars for ${chartInstrument(symbol)} are available during live market hours (09:15–15:30 IST). Switch to Daily (1d) to view historical candles, or view NIFTY / BANKNIFTY for 1-second stored intraday charts.`
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

    body = (
      <View style={styles.stateBox}>
        <Ionicons name="bar-chart-outline" size={48} color={colors.muted} />
        <Text style={styles.stateTitle}>No candles returned</Text>
        <Text style={styles.stateBody}>
          {isIntraday && isStock
            ? `Intraday bars for ${chartInstrument(symbol)} are streamed during live market hours (09:15–15:30 IST). Switch to Daily (1d) to view historical data, or view NIFTY / BANKNIFTY for 1-second stored intraday charts.`
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
    body = (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={{ marginTop: 12, color: colors.muted, fontSize: 13 }}>Initializing chart canvas...</Text>
      </View>
    );
  } else {
    body = (
      <View
        style={{ flex: 1 }}
        key={chartKey}
        onLayout={(e) => {
          const h = Math.round(e.nativeEvent.layout.height);
          if (h > 100 && h !== chartHeight) setChartHeight(h);
        }}
      >
        <KLineChart data={chartDataPoints} height={chartHeight} symbol={symbol} />
      </View>
    );
  }

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

      <View style={styles.liveRow}>
        <View style={[styles.liveDot, { backgroundColor: liveColor }]} />
        <Text style={[styles.liveText, { color: liveColor }]} numberOfLines={2}>{liveText}</Text>
        {liveAt !== null && <Text style={styles.liveTime}>{liveAt}</Text>}
      </View>

      {isDaily && candles.length > 0 && (
        <View style={styles.sourceRow}>
          <Text style={styles.sourceText} numberOfLines={2}>
            {chartData?.source ?? "Stored daily history"}
            {chartDataPoints.length < candles.length ? ` · showing ${chartDataPoints.length} of ${candles.length} sessions` : ""}
          </Text>
        </View>
      )}

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
    sourceRow: { paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
    sourceText: { fontSize: 10.5, color: colors.muted },
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
    sheetTitle: { fontSize: 18, fontWeight: "700", color: colors.text, marginBottom: 12 },
    search: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: colors.text, backgroundColor: colors.bg, marginBottom: 8 },
    sectionTitle: { fontSize: 11, fontWeight: "700", letterSpacing: 0.7, color: colors.muted, textTransform: "uppercase", paddingTop: 10, paddingBottom: 4 },
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
    rowName: { fontSize: 16, fontWeight: "600", color: colors.text },
    rowMeta: { fontSize: 12, color: colors.muted },
    notice: { paddingVertical: 12, fontSize: 13, color: colors.muted, textAlign: "center" },
  });
}
