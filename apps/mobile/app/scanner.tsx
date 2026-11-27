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
import { useScreenFocused } from "@/hooks/useScreenFocused";
import { asMs } from "@/utils/scan-chart";
import { iciciHoldings, queryKeys } from "@nraialgo/shared/api";
import type { ScannerSignalType } from "@nraialgo/shared/api";

type SignalFilter = "all" | "breakout" | "breakdown" | "support" | "resistance" | "hm";

export type UniverseFilter = "all" | "portfolio" | "fo" | "cash" | "large_cap" | "midcap" | "small_cap";

interface UniverseOption {
  id: UniverseFilter;
  label: string;
}

const UNIVERSES: UniverseOption[] = [
  { id: "all", label: "All" },
  { id: "portfolio", label: "Portfolio" },
  { id: "fo", label: "F&O" },
  { id: "cash", label: "Cash" },
  { id: "large_cap", label: "Large Cap" },
  { id: "midcap", label: "Midcap" },
  { id: "small_cap", label: "Small Cap" },
];

/** Index names the scanner may list; they are never a large, mid or small cap stock. */
const INDEX_NAMES = new Set(["NIFTY", "NIFTY50", "NIFTY 50", "BANKNIFTY", "NIFTY BANK", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"]);

/**
 * Full index membership from prod's built-in list. Page 0 already carries every member in `instruments`
 * (instrument:v1:NSE:EQ:<SYMBOL>:CASH); only page 0's rows are priced. Read once and kept: no polling.
 */
function membership(page: { instruments?: (string | null)[] } | undefined): Set<string> | null {
  if (!page?.instruments) return null;
  const set = new Set<string>();
  for (const id of page.instruments) {
    const parts = (id ?? "").split(":");
    if (parts.length >= 6 && parts[0] === "instrument" && parts[4]) set.add(decodeURIComponent(parts[4]).toUpperCase());
  }
  return set;
}

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
  const { useTechnicalEvents, useOpenPositions, useIciciAccount, useChainUnderlyings, useContractUnderlyings, useBuiltinWatchlist } = useApi();
  const { resolvedTheme } = useTheme();
  const router = useRouter();
  const [universe, setUniverse] = useState<UniverseFilter>("all");
  const [filter, setFilter] = useState<SignalFilter>("all");
  const focused = useScreenFocused();

  // Technical events scanner data
  const { data, isLoading, isError, refetch } = useTechnicalEvents({ enabled: focused });

  // Open positions and ICICI account snapshot for portfolio matching
  const { data: openPositions } = useOpenPositions({ enabled: focused, refetchInterval: false });
  const { data: iciciAccount } = useIciciAccount({ queryKey: queryKeys.brokerAccount.icici(), subscribed: focused, gcTime: Infinity });

  // Read full derivatives master statically once (unpriced, cached 1h)
  const { data: chainUnderlyings } = useChainUnderlyings({ queryKey: queryKeys.optionChain.underlyings(), enabled: focused });

  // Nifty 50 and Midcap 150 members: one read each, no polling (same cache as the Watchlist tab).
  const { data: nifty50Page } = useBuiltinWatchlist("nifty_50", 0, { queryKey: queryKeys.watchlist.builtin("nifty_50", 0), enabled: focused, refetchInterval: false, staleTime: 12 * 60 * 60 * 1000, gcTime: Infinity });
  const { data: midcapPage } = useBuiltinWatchlist("nifty_midcap_150", 0, { queryKey: queryKeys.watchlist.builtin("nifty_midcap_150", 0), enabled: focused, refetchInterval: false, staleTime: 12 * 60 * 60 * 1000, gcTime: Infinity });

  // Collect raw codes from positions and holdings that need broker-to-exchange underlying mapping
  const candidateCodes = useMemo(() => {
    const list: string[] = [];
    (openPositions ?? []).forEach((pos: any) => {
      const sym = (pos.symbol ?? pos.tradingsymbol ?? "").trim().toUpperCase();
      if (sym) list.push(sym);
    });
    if (iciciAccount) {
      const holdings = iciciHoldings(iciciAccount);
      holdings.forEach((h: any) => {
        const sym = (h.symbol ?? h.stock_code ?? "").trim().toUpperCase();
        if (sym) list.push(sym);
      });
    }
    return [...new Set(list)].filter((c) => /^[A-Z0-9&_-]+$/.test(c));
  }, [openPositions, iciciAccount]);

  // Resolve ICICI broker codes (e.g., RELIND -> RELIANCE) via prod's unpriced derivatives master
  const { data: resolvedContractUnderlyings } = useContractUnderlyings(candidateCodes);

  // Extract portfolio symbols from positions and holdings with mapped underlying names
  const portfolioSymbols = useMemo(() => {
    const set = new Set<string>();
    const resolved = resolvedContractUnderlyings ?? {};

    // From broker open positions
    (openPositions ?? []).forEach((pos: any) => {
      const sym = (pos.symbol ?? pos.tradingsymbol ?? "").toUpperCase().trim();
      if (sym) {
        set.add(sym);
        set.add(sym.replace(/-(EQ|BE|SM)$/, ""));
        const mapped = resolved[sym];
        if (mapped) set.add(mapped.toUpperCase());
      }
    });

    // From ICICI account holdings & positions
    if (iciciAccount) {
      const holdings = iciciHoldings(iciciAccount);
      holdings.forEach((h: any) => {
        const sym = (h.symbol ?? h.stock_code ?? "").toUpperCase().trim();
        if (sym) {
          set.add(sym);
          set.add(sym.replace(/-(EQ|BE|SM)$/, ""));
          const mapped = resolved[sym];
          if (mapped) set.add(mapped.toUpperCase());
        }
      });
    }
    return set;
  }, [openPositions, iciciAccount, resolvedContractUnderlyings]);

  // Extract F&O symbols once from derivatives master (all ~180+ F&O stocks & indices)
  const foSymbols = useMemo(() => {
    const set = new Set<string>();
    (chainUnderlyings?.underlyings ?? []).forEach((u) => {
      if (u.name) set.add(u.name.toUpperCase().trim());
    });
    return set;
  }, [chainUnderlyings]);

  // Large Cap = Nifty 50 members, Midcap = Nifty Midcap 150 members (null until the list has loaded)
  const largeCapSymbols = useMemo(() => membership(nifty50Page), [nifty50Page]);
  const midcapSymbols = useMemo(() => membership(midcapPage), [midcapPage]);

  const colors = useMemo(() => resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#64748b", border: "#334155", accent: "#38bdf8", buy: "#22c55e", sell: "#ef4444", universeChip: "#0e7490", universeChipBg: "#164e63" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", accent: "#0284c7", buy: "#16a34a", sell: "#dc2626", universeChip: "#0284c7", universeChipBg: "#e0f2fe" }, [resolvedTheme]);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    universeBar: {
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.card,
    },
    universeChip: {
      paddingHorizontal: 13,
      paddingVertical: 5,
      borderRadius: 14,
      marginRight: 6,
      backgroundColor: colors.bg,
      borderWidth: 1,
      borderColor: colors.border,
    },
    universeChipActive: {
      backgroundColor: colors.universeChip,
      borderColor: colors.universeChip,
    },
    universeText: {
      fontSize: 12,
      fontWeight: "600",
      color: colors.muted,
    },
    universeTextActive: {
      color: "#ffffff",
    },
    filterBar: {
      flexDirection: "row",
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.card,
    },
    filterChip: {
      paddingHorizontal: 11,
      paddingVertical: 4,
      borderRadius: 14,
      marginRight: 6,
      backgroundColor: colors.bg,
      borderWidth: 1,
      borderColor: colors.border,
    },
    filterChipActive: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
    filterText: {
      fontSize: 11,
      fontWeight: "500",
      color: colors.muted,
    },
    filterTextActive: {
      color: "#ffffff",
    },
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
    status: { padding: 8, backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.border },
    statusText: { fontSize: 11, color: colors.muted, textAlign: "center" },
  }), [colors]);

  /** One card per rule match: the server files every event under its instrument, so a stock that broke out
   *  and then retested its level is listed twice, each row with its own kind and candle. */
  const signals = useMemo(() => (data?.items ?? []).flatMap((item, itemIndex) =>
    (item.result?.events ?? []).map((event, eventIndex) => ({
      id: `${item.instrument}-${item.session}-${itemIndex}-${eventIndex}`,
      instrument: item.instrument,
      rawSymbol: item.instrument.replace(/^(NSE|BSE|NFO|BFO):/, "").trim().toUpperCase(),
      kind: event.kind,
      at: asMs(event.timestamp),
      close: typeof event.close === "number" && Number.isFinite(event.close) ? event.close : null,
      session: item.session,
      timeframe: item.timeframe ?? item.result?.timeframe ?? "",
      runId: item.run_id ?? "",
    }))
  ), [data]);

  const filteredSignals = useMemo(() => {
    // 1. Universe filter
    let list = signals;
    if (universe === "portfolio") {
      list = list.filter((s) => portfolioSymbols.has(s.rawSymbol));
    } else if (universe === "fo") {
      list = list.filter((s) => foSymbols.has(s.rawSymbol));
    } else if (universe === "cash") {
      // Cash stocks are non-F&O equities
      list = list.filter((s) => !foSymbols.has(s.rawSymbol));
    } else if (universe === "large_cap") {
      list = largeCapSymbols ? list.filter((s) => largeCapSymbols.has(s.rawSymbol)) : [];
    } else if (universe === "midcap") {
      list = midcapSymbols ? list.filter((s) => midcapSymbols.has(s.rawSymbol)) : [];
    } else if (universe === "small_cap") {
      // Small cap: stocks outside Nifty 50 and Midcap 150 (and not an index); empty until both lists load
      list = largeCapSymbols && midcapSymbols
        ? list.filter((s) => !INDEX_NAMES.has(s.rawSymbol) && !largeCapSymbols.has(s.rawSymbol) && !midcapSymbols.has(s.rawSymbol))
        : [];
    }

    // 2. Technical signal kind filter
    const selectedFilter = FILTERS.find((f) => f.id === filter);
    if (!selectedFilter || filter === "all") {
      return list;
    }
    return list.filter((row) => selectedFilter.kinds.has(row.kind));
  }, [signals, universe, filter, portfolioSymbols, foSymbols, largeCapSymbols, midcapSymbols]);

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

  if (isError && !data) {
    return (
      <View style={styles.container}>
        {/* Stock Universe Selector */}
        <View style={styles.universeBar}>
          <FlatList
            horizontal
            showsHorizontalScrollIndicator={false}
            data={UNIVERSES}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[styles.universeChip, universe === item.id && styles.universeChipActive]}
                onPress={() => setUniverse(item.id)}
              >
                <Text style={[styles.universeText, universe === item.id && styles.universeTextActive]}>
                  {item.label}
                </Text>
              </TouchableOpacity>
            )}
          />
        </View>

        {/* Technical Signal Filter */}
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

        <View style={[styles.empty, { backgroundColor: colors.bg }]}>
          <Text style={styles.emptyText}>Failed to load scanner data</Text>
          <TouchableOpacity style={{ marginTop: 16, paddingVertical: 12, alignItems: "center" }} onPress={() => void refetch()}>
            <Text style={{ color: colors.accent, fontWeight: "600" }}>Tap to retry</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Stock Universe Selector */}
      <View style={styles.universeBar}>
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={UNIVERSES}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.universeChip, universe === item.id && styles.universeChipActive]}
              onPress={() => setUniverse(item.id)}
            >
              <Text style={[styles.universeText, universe === item.id && styles.universeTextActive]}>
                {item.label}
              </Text>
            </TouchableOpacity>
          )}
        />
      </View>

      {/* Technical Signal Filter */}
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
