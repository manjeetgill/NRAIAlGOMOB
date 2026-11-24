/**
 * Scanner Screen - Technical signals from the built-in scanner
 *
 * Shows breakout, breakdown, support/resistance signals from the technical events scanner.
 * Lightweight mobile view: list of signals with basic info, filterable by signal type.
 */

import React, { useState, useMemo } from "react";
import { View, Text, FlatList, StyleSheet, ActivityIndicator, TouchableOpacity, RefreshControl } from "react-native";
import { useTheme } from "@/components/ThemeProvider";
import { formatRupees } from "@nraialgo/shared/utils";
import { useApi } from "@/hooks/useApi";
import type { ScannerSignal, ScannerSignalType } from "@nraialgo/shared/api";

type SignalFilter = "all" | "breakout" | "breakdown" | "support" | "resistance" | "hm";

const FILTERS: { id: SignalFilter; label: string; kinds: ScannerSignalType[] }[] = [
  { id: "all", label: "All", kinds: ["breakout", "breakdown", "support_touch", "resistance_touch", "breakout_retest", "breakdown_retest", "hm_rsi_supertrend_buy", "hm_rsi_supertrend_sell"] },
  { id: "breakout", label: "Breakout", kinds: ["breakout"] },
  { id: "breakdown", label: "Breakdown", kinds: ["breakdown"] },
  { id: "support", label: "Support", kinds: ["support_touch", "breakout_retest"] },
  { id: "resistance", label: "Resistance", kinds: ["resistance_touch", "breakdown_retest"] },
  { id: "hm", label: "HM RSI+ST", kinds: ["hm_rsi_supertrend_buy", "hm_rsi_supertrend_sell"] },
];

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
  const [filter, setFilter] = useState<SignalFilter>("all");

  const { data, isLoading, isError, refetch } = useTechnicalEvents();

  const colors = resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#64748b", border: "#334155", accent: "#38bdf8", buy: "#22c55e", sell: "#ef4444" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", accent: "#0284c7", buy: "#16a34a", sell: "#dc2626" };

  const styles = StyleSheet.create({
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
  });

  const filteredSignals = useMemo(() => {
    if (!data?.items) return [];
    const selectedFilter = FILTERS.find(f => f.id === filter);
    if (!selectedFilter) return data.items;
    return data.items.filter(item => selectedFilter.kinds.includes(item.signal_type));
  }, [data, filter]);

  const getBadgeStyle = (signalType: ScannerSignalType) => {
    if (signalType === "breakout" || signalType === "hm_rsi_supertrend_buy") return styles.badgeBreakout;
    if (signalType === "breakdown" || signalType === "hm_rsi_supertrend_sell") return styles.badgeBreakdown;
    if (signalType === "support_touch" || signalType === "breakout_retest") return styles.badgeSupport;
    if (signalType === "resistance_touch" || signalType === "breakdown_retest") return styles.badgeResistance;
    return styles.badgeHM;
  };

  const renderSignalCard = (signal: ScannerSignal) => {
    const isBuy = signal.signal_type.includes("buy") || signal.signal_type === "breakout";
    return (
      <View key={`${signal.instrument}-${signal.session}`} style={styles.card}>
        <View style={styles.header}>
          <Text style={styles.symbol}>{signal.instrument}</Text>
          <Text style={[styles.badge, getBadgeStyle(signal.signal_type)]}>
            {SIGNAL_LABELS[signal.signal_type]}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Session</Text>
          <Text style={styles.value}>{signal.session}</Text>
        </View>
        {signal.price != null && (
          <View style={styles.row}>
            <Text style={styles.label}>Price</Text>
            <Text style={[styles.value, { color: isBuy ? colors.buy : colors.sell }]}>
              {formatRupees(signal.price)}
            </Text>
          </View>
        )}
        {signal.timeframe && (
          <View style={styles.row}>
            <Text style={styles.label}>Timeframe</Text>
            <Text style={styles.value}>{signal.timeframe}</Text>
          </View>
        )}
        {signal.result?.resistance != null && (
          <View style={styles.row}>
            <Text style={styles.label}>Resistance</Text>
            <Text style={styles.value}>{formatRupees(signal.result.resistance)}</Text>
          </View>
        )}
        {signal.result?.support != null && (
          <View style={styles.row}>
            <Text style={styles.label}>Support</Text>
            <Text style={styles.value}>{formatRupees(signal.result.support)}</Text>
          </View>
        )}
      </View>
    );
  };

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
          keyExtractor={(item) => `${item.instrument}-${item.session}`}
          renderItem={({ item }) => renderSignalCard(item)}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={false} onRefresh={() => void refetch()} colors={[colors.accent]} />}
        />
      )}
    </View>
  );
}
