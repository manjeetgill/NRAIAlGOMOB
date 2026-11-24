/**
 * Terminal Charts - candles for any listed index or F&O underlying, moving tick by tick in the live market.
 * Minutes and hours come from the broker's intraday candles and daily and weekly candles from the stored NSE
 * end-of-day archive; that record only has to cover the completed bars. The bar being watched is then extended
 * by prod's quote stream, the same stream the web desk uses, so the candle on this screen is the current price
 * rather than the last poll.
 */

import React, { useMemo, useState } from "react";
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
import { CandleStickChart } from "react-native-gifted-charts";

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

const DAILY_INTERVALS: ReadonlySet<IntervalId> = new Set(["1d", "1w"]);
const DEFAULT_SYMBOL = "NIFTY";
// Daily candles are the default: one bar per completed session, read from stored history rather than
// from a live broker session, so the chart is never blank because the market happens to be shut.
const DEFAULT_INTERVAL: IntervalId = "1d";
const DAILY_CANDLES_SHOWN = 120;

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
  const [symbol, setSymbol] = useState<string>(DEFAULT_SYMBOL);
  const [interval, setInterval] = useState<IntervalId>(DEFAULT_INTERVAL);
  const [showSymbolPicker, setShowSymbolPicker] = useState(false);
  const [search, setSearch] = useState("");

  console.log("TerminalCharts: Rendering with symbol=", symbol, "interval=", interval);

  const isDaily = DAILY_INTERVALS.has(interval);
  const { data: chartData, isLoading, isError, error, refetch } = useTerminalChart(symbol, interval, {
    // The stream paints the forming candle, so the record only has to reconcile the completed bars.
    refetchInterval: isDaily ? false : 30_000,
  });

  console.log("TerminalCharts: chartData=", chartData, "isLoading=", isLoading, "isError=", isError);
  // A daily bar opens with the session, and the stored archive only reaches the last closed session: today's
  // minute bars are what give the live daily candle a true open instead of the first price this device saw.
  const session = useTerminalChart(symbol, "5m", { enabled: interval === "1d", refetchInterval: 60_000 });
  const underlyings = useChainUnderlyings();

  const allUnderlyings = underlyings.data?.underlyings ?? [];
  const sections = useMemo(() => chartPickerSections(allUnderlyings, search), [allUnderlyings, search]);

  const candles = chartData?.candles ?? [];
  const baseCandles = useMemo(
    () => withForming(candles, chartData?.forming, isDaily ? DAILY_CANDLES_SHOWN : 0),
    [candles, chartData?.forming, isDaily],
  );
  const sessionCandles = useMemo(
    () => (interval === "1d" ? withForming(session.data?.candles ?? [], session.data?.forming, 0) : []),
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

  const { priceMin, priceMax } = useMemo(() => {
    if (!chartDataPoints.length) return { priceMin: 0, priceMax: 100 };
    const highs = chartDataPoints.map((d) => d.high);
    const lows = chartDataPoints.map((d) => d.low);
    const padding = (Math.max(...highs) - Math.min(...lows)) * 0.05;
    return { priceMin: Math.min(...lows) - padding, priceMax: Math.max(...highs) + padding };
  }, [chartDataPoints]);

  const colors = resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#64748b", border: "#334155", accent: "#38bdf8", up: "#22c55e", down: "#ef4444" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", accent: "#0284c7", up: "#16a34a", down: "#dc2626" };

  // What the stream itself says about the price behind the newest bar, in the server's own words.
  const liveText = live.unavailable ?? tickLabel(live.tick, live.connected, live.reason);
  const liveAt = live.at === null ? null : new Date(live.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const liveColor = live.tick?.fresh ? colors.up : live.reason || live.tick ? colors.down : colors.muted;

  const styles = StyleSheet.create({
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

  const chartConfig = useMemo(() => ({
    chartConfig: {
      backgroundColor: colors.card,
      backgroundGradientFrom: colors.card,
      backgroundGradientTo: colors.card,
      decimalPlaces: 2,
      color: (opacity = 1) => `rgba(34, 197, 94, ${opacity})`,
      strokeWidth: 2,
      style: { borderRadius: 12 },
      propsForDots: { r: 4, strokeWidth: 2, stroke: colors.text },
      yAxisLabel: "₹",
      yAxisSuffix: "",
      xAxisLabel: "",
      xAxisSuffix: "",
      xAxis: { label: (timestamp: number) => axisLabel(timestamp, isDaily) },
    },
    candleStickConfig: {
      candleWidth: 12,
      candleSpacing: 8,
      upColor: colors.up,
      downColor: colors.down,
      neutralColor: colors.muted,
      borderWidth: 1,
      borderColor: colors.muted,
      showVolume: false,
    },
  }), [colors, isDaily]);

  const pick = (name: string) => {
    setSymbol(name);
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
    // A live tick is a better answer than a failed history read: the stream paints the bar it has a price for.
    body = (
      <View style={styles.stateBox}>
        <Ionicons name="alert-circle-outline" size={48} color={colors.down} />
        <Text style={styles.stateTitle}>No {interval} chart for {symbol}</Text>
        <Text style={styles.stateBody}>{chartFailureReason(error)}</Text>
        <TouchableOpacity style={styles.actionButton} onPress={() => refetch()} accessibilityRole="button" accessibilityLabel="Retry">
          <Text style={styles.actionLabel}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (!chartDataPoints.length) {
    body = (
      <View style={styles.stateBox}>
        <Ionicons name="bar-chart-outline" size={48} color={colors.muted} />
        <Text style={styles.stateTitle}>No candles returned</Text>
        <Text style={styles.stateBody}>
          {chartData?.source
            ? `${chartData.source} returned no ${interval} bars for ${chartInstrument(symbol)}.`
            : `No ${interval} bars came back for ${chartInstrument(symbol)}.`}
        </Text>
        <TouchableOpacity style={styles.actionButton} onPress={() => refetch()} accessibilityRole="button" accessibilityLabel="Refresh">
          <Text style={styles.actionLabel}>Refresh</Text>
        </TouchableOpacity>
      </View>
    );
  } else {
    body = (
      <>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.card, margin: 12, borderRadius: 12 }}>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }}>Chart: {chartDataPoints.length} candles</Text>
          <Text style={{ color: colors.muted, fontSize: 12, marginTop: 8 }}>
            {chartDataPoints.length > 0 ? `Range: ${formatRupees(priceMin)} - ${formatRupees(priceMax)}` : 'No data'}
          </Text>
          {/* TODO: CandleStickChart disabled for testing */}
          {/* <CandleStickChart {...chartConfig} data={chartDataPoints} /> */}
        </View>
        <View style={styles.priceScale}>
          {Array.from({ length: 6 }, (_, i) => {
            const price = priceMax - (priceMax - priceMin) * (i / 5);
            return <Text key={i} style={styles.priceScaleLabel}>{formatRupees(price)}</Text>;
          })}
        </View>
        <View style={styles.timeScale}>
          {[0, 0.25, 0.5, 0.75, 1].map((fraction, i) => {
            const index = Math.min(chartDataPoints.length - 1, Math.round((chartDataPoints.length - 1) * fraction));
            return <Text key={i} style={styles.timeScaleLabel}>{axisLabel(chartDataPoints[index]?.timestamp ?? 0, isDaily)}</Text>;
          })}
        </View>
      </>
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
            onPress={() => setInterval(entry.id)}
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
            {candles.length > chartDataPoints.length ? ` · newest ${chartDataPoints.length} of ${candles.length} sessions` : ""}
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
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.row} onPress={() => pick(item.name)} accessibilityRole="button" accessibilityLabel={`Chart ${item.name}`}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowName}>{item.name}</Text>
                    <Text style={styles.rowMeta}>{chartInstrument(item.name)} · lot {item.lotSize}</Text>
                  </View>
                  <Ionicons
                    name={symbol === item.name ? "checkmark-circle-outline" : "radio-button-off-outline"}
                    size={22}
                    color={symbol === item.name ? colors.accent : colors.muted}
                  />
                </TouchableOpacity>
              )}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}
