/**
 * Scanner Screen - Technical signals from the built-in scanner
 *
 * Shows breakout, breakdown, support/resistance signals from the technical events scanner.
 * Lightweight mobile view: one row per event with the figures `/v1/technical-events` files beside it —
 * the instrument, the saved session and timeframe, and the close of the candle the rule matched on.
 * A row opens the saved scan's own chart, the same evidence read the web scanner makes.
 */

import React, { useState, useMemo, useCallback } from "react";
import { View, Text, FlatList, StyleSheet, ActivityIndicator, TouchableOpacity, RefreshControl } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/components/ThemeProvider";
import { formatRupees } from "@nraialgo/shared/utils";
import { useApi } from "@/hooks/useApi";
import { asMs } from "@/utils/scan-chart";
import type { ScannerSignalType } from "@nraialgo/shared/api";

type SignalFilter = "all" | "breakout" | "breakdown" | "support" | "resistance" | "hm";

const FILTERS: { id: SignalFilter; label: string; kinds: Set<string> }[] = [
  { id: "all", label: "All", kinds: new Set(["breakout", "breakdown", "support_touch", "resistance_touch", "breakout_retest", "breakdown_retest", "hm_rsi_supertrend_buy", "hm_rsi_supertrend_sell"]) },
  { id: "breakout", label: "Breakout", kinds: new Set(["breakout"]) },
  { id: "breakdown", label: "Breakdown", kinds: new Set(["breakdown"]) },
  { id: "support", label: "Support", kinds: new Set(["support_touch", "breakout_retest"]) },
  { id: "resistance", label: "Resistance", kinds: new Set(["resistance_touch", "breakdown_retest"]) },
  { id: "hm", label: "HM RSI+ST", kinds: new Set(["hm_rsi_supertrend_buy", "hm_rsi_supertrend_sell"]) },
];

/** The server files the candle as epoch milliseconds. Its day is the session row already, so the number
 *  earns a line only when it carries a time, which is how an intraday candle differs from a daily one. */
const candleTime = (ms: number | null): string => {
  if (!ms) return "";
  const ist = new Date(ms + 19_800_000);
  if (ist.getUTCHours() === 0 && ist.getUTCMinutes() === 0) return "";
  return `${String(ist.getUTCHours()).padStart(2, "0")}:${String(ist.getUTCMinutes()).padStart(2, "0")}`;
};

const SIGNAL_LABELS: Record<ScannerSignalType, string> = {
  breakout: "Breakout",
  breakdown: "Breakdown",
  support_touch: "Support",
  resistance_touch: "Resistance",
  breakout_retest: "Support Retest",
  breakdown_retest: "Resistance Retest",
  hm_rsi_supertrend_buy: "HM Buy",
  hm_rsi_supertrend_sell: "HM Sell",
};

export default function ScannerScreen() {
  const { useTechnicalEvents } = useApi();
  const { resolvedTheme } = useTheme();
  const router = useRouter();
  const [filter, setFilter] = useState<SignalFilter>("all");

  const { data, isLoading, isError, refetch } = useTechnicalEvents();

  const colors = useMemo(() => resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#64748b", border: "#334155", accent: "#38bdf8", buy: "#22c55e", sell: "#ef4444" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", accent: "#0284c7", buy: "#16a34a", sell: "#dc2626" }, [resolvedTheme]);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    filterBar: { flexDirection: "row", paddingVertical: 8, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.card },
    filterChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, marginRight: 8, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
    filterChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    filterText: { fontSize: 12, fontWeight: "500", color: colors.muted },
    filterTextActive: { color: "#ffffff" },
    listContent: { padding: 12, paddingBottom: 100 },
    card: {
      backgroundColor: colors.card,
      borderRadius: 10,
      padding: 12,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: colors.border,
    },
    header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
    symbol: { fontSize: 15, fontWeight: "600", color: colors.text },
    badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, fontSize: 10, fontWeight: "600" },
    badgeBreakout: { backgroundColor: "rgba(34,197,94,0.15)", color: "#22c55e" },
    badgeBreakdown: { backgroundColor: "rgba(239,68,68,0.15)", color: "#ef4444" },
    badgeSupport: { backgroundColor: "rgba(56,189,248,0.15)", color: "#38bdf8" },
    badgeResistance: { backgroundColor: "rgba(245,158,11,0.15)", color: "#f59e0b" },
    badgeHM: { backgroundColor: "rgba(168,85,247,0.15)", color: "#a855f7" },
    row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
    label: { fontSize: 11, color: colors.muted },
    value: { fontSize: 13, fontWeight: "500", color: colors.text },
    empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40 },
    emptyText: { fontSize: 14, color: colors.muted, textAlign: "center" },
    loading: { flex: 1, alignItems: "center", justifyContent: "center" },
    status: { padding: 12, backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.border },
    statusText: { fontSize: 11, color: colors.muted, textAlign: "center" },
  }), [colors]);

  /** One card per rule match: the server files every event under its instrument, so a stock that broke out
   *  and then retested its level is listed twice, each row with its own kind and candle. */
  const signals = useMemo(() => (data?.items ?? []).flatMap((item, itemIndex) =>
    (item.result?.events ?? []).map((event, eventIndex) => ({
      id: `${item.instrument}-${item.session}-${itemIndex}-${eventIndex}`,
      instrument: item.instrument,
      kind: event.kind,
      at: asMs(event.timestamp),
      close: typeof event.close === "number" && Number.isFinite(event.close) ? event.close : null,
      session: item.session,
      timeframe: item.timeframe ?? item.result?.timeframe ?? "",
      runId: item.run_id ?? "",
    }))
  ), [data]);

  const filteredSignals = useMemo(() => {
    const selectedFilter = FILTERS.find(f => f.id === filter);
    return !selectedFilter || filter === "all" ? signals : signals.filter(row => selectedFilter.kinds.has(row.kind));
  }, [signals, filter]);

  const getBadgeStyle = useCallback((kind: string) => {
    if (kind === "breakout" || kind === "hm_rsi_supertrend_buy") return styles.badgeBreakout;
    if (kind === "breakdown" || kind === "hm_rsi_supertrend_sell") return styles.badgeBreakdown;
    if (kind === "support_touch" || kind === "breakout_retest") return styles.badgeSupport;
    if (kind === "resistance_touch" || kind === "breakdown_retest") return styles.badgeResistance;
    return styles.badgeHM;
  }, [styles]);

  /** A stored scan can carry a kind this list has never seen, and its own server word beats a blank badge. */
  const getBadgeLabel = useCallback((kind: string) =>
    SIGNAL_LABELS[kind as ScannerSignalType] ?? kind.replace(/_/g, " "), []);

  /** The chart is read per saved scan, so the row carries its own identity down: the same symbol scanned on
   *  two sessions, or by a run and by the standing scan, are three different sets of candles. */
  const openChart = useCallback((signal: { instrument: string; session: string; timeframe: string; kind: string; runId: string }) => {
    router.push(`/scanner-chart?instrument=${encodeURIComponent(signal.instrument)}`
      + `&session=${encodeURIComponent(signal.session)}&timeframe=${encodeURIComponent(signal.timeframe || "1d")}`
      + `&kind=${encodeURIComponent(signal.kind)}`
      + (signal.runId ? `&run_id=${encodeURIComponent(signal.runId)}` : ""));
  }, [router]);

  const renderSignalCard = useCallback((signal: { instrument: string; kind: string; at: number | null; close: number | null; session: string; timeframe: string; runId: string }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() => openChart(signal)}
      accessibilityRole="button"
      accessibilityLabel={`Open the ${getBadgeLabel(signal.kind)} scan chart for ${signal.instrument}`}
    >
      <View style={styles.header}>
        <Text style={styles.symbol}>{signal.instrument}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={[styles.badge, getBadgeStyle(signal.kind)]}>{getBadgeLabel(signal.kind)}</Text>
          <Ionicons name="chevron-forward" size={14} color={colors.muted} />
        </View>
      </View>
      {signal.close !== null ? (
        <View style={styles.row}>
          <Text style={styles.label}>Candle close</Text>
          <Text style={[styles.value, { color: signal.kind.includes("buy") || signal.kind === "breakout" ? colors.buy : colors.sell }]}>
            {formatRupees(signal.close)}
          </Text>
        </View>
      ) : null}
      <View style={styles.row}>
        <Text style={styles.label}>Session</Text>
        <Text style={styles.value}>{signal.session}</Text>
      </View>
      {signal.timeframe ? (
        <View style={styles.row}>
          <Text style={styles.label}>Timeframe</Text>
          <Text style={styles.value}>{signal.timeframe}</Text>
        </View>
      ) : null}
      {candleTime(signal.at) ? (
        <View style={styles.row}>
          <Text style={styles.label}>Candle at</Text>
          <Text style={styles.value}>{candleTime(signal.at)}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  ), [styles, colors, openChart, getBadgeLabel, getBadgeStyle]);

  if (isLoading) {
    return (
      <View style={[styles.loading, { backgroundColor: colors.bg }]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (isError) {
    return (
      <View style={[styles.empty, { backgroundColor: colors.bg }]}>
        <Text style={styles.emptyText}>Failed to load scanner data</Text>
        <TouchableOpacity style={{ marginTop: 16, paddingVertical: 12, alignItems: "center" }} onPress={() => void refetch()}>
          <Text style={{ color: colors.accent, fontWeight: "600" }}>Tap to retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.filterBar}>
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={FILTERS}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.filterChip, filter === item.id && styles.filterChipActive]}
              onPress={() => setFilter(item.id)}
            >
              <Text style={[styles.filterText, filter === item.id && styles.filterTextActive]}>
                {item.label}
              </Text>
            </TouchableOpacity>
          )}
        />
      </View>
      {data?.run && (
        <View style={styles.status}>
          <Text style={styles.statusText}>
            {data.run.status === "running" ? "Scan running…" : `Data through ${data.session ?? "—"} · ${data.run.status}`}
          </Text>
        </View>
      )}
      {filteredSignals.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            {data?.items?.length === 0 ? "No scanner signals available. Run a scan from the web app first." : "No signals match this filter."}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filteredSignals}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => renderSignalCard(item)}
          contentContainerStyle={styles.listContent}
          initialNumToRender={10}
          maxToRenderPerBatch={8}
          windowSize={5}
          removeClippedSubviews
          refreshControl={<RefreshControl refreshing={false} onRefresh={() => void refetch()} colors={[colors.accent]} />}
        />
      )}
    </View>
  );
}
