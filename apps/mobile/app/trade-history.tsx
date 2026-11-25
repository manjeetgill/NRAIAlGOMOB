/**
 * Trade History Screen - the positions this account actually has, read from prod.
 *
 * /v1/baskets is the route the web live desk uses for the same record, so this screen calls it and nothing
 * else. The shared `useHistory` and `useClosedPositions` hooks name paths the backend never registered, and
 * the rows drawn here before came from a fixture of January-2024 trades that belong to nobody, so neither is
 * used. The four tabs are prod's own words for one record: every basket, the ones prod has closed, the ones
 * an algo ran at the broker, and the ones holding a single leg.
 */

import React, { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { isLiveRun, type Basket } from "@nraialgo/shared/api";
import { formatNumber, formatQuantity } from "@nraialgo/shared/utils";
import { useApi } from "@/hooks/useApi";
import { useTheme } from "@/components/ThemeProvider";

const TABS = [
  { id: "all", label: "All" },
  { id: "closed", label: "Closed" },
  { id: "automated", label: "Automated" },
  { id: "single", label: "Single" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** One basket as this screen shows it, built only from fields prod returns. */
interface HistoryRow {
  id: string;
  title: string;
  detail: string;
  realized: number;
  status: string;
  /** The newest stamp on the basket's own record, so a quiet screen can say how old it is. */
  at: string | null;
  single: boolean;
}

const money = (value: number | null | undefined): string =>
  value === null || value === undefined || !Number.isFinite(value) ? "no price" : `₹${formatNumber(value)}`;

const signed = (value: number): string => `${value >= 0 ? "+" : "-"}₹${formatNumber(Math.abs(value))}`;

/** The newest timestamp the record itself carries: a booked exit, or when the basket opened. */
function newestStamp(basket: Basket): string | null {
  const stamps = [basket.openedAt ?? null, ...basket.legs.map(leg => leg.exitAt ?? null)]
    .filter((value): value is string => typeof value === "string" && value !== "");
  return stamps.length ? (stamps.sort().at(-1) as string) : null;
}

function rowFor(basket: Basket): HistoryRow {
  const first = basket.legs[0];
  const legs = basket.legs.length;
  return {
    id: basket.id,
    title: basket.name?.trim() || first?.symbol || `Basket ${basket.id.slice(0, 8)}`,
    // A leg prod has no exit price for is gross, not net, and says so instead of showing a booked figure.
    detail: legs === 1 && first
      ? `${first.side} ${formatQuantity(first.quantity)} @ ${money(first.entryPrice)}` +
        (first.exitPrice === null || first.exitPrice === undefined ? " · exit not booked" : ` → ${money(first.exitPrice)}`)
      : `${legs} legs · ${formatQuantity(basket.legs.reduce((total, leg) => total + leg.quantity, 0))} units`,
    realized: basket.realized,
    status: `${basket.status} · ${basket.kind}`,
    at: newestStamp(basket),
    single: legs === 1,
  };
}

function matches(basket: Basket, tab: TabId): boolean {
  if (tab === "closed") return basket.status === "closed";
  // Paper runs are automated, but their money is simulated, so this tab names only what the broker ran.
  if (tab === "automated") return isLiveRun(basket);
  if (tab === "single") return basket.legs.length === 1;
  return true;
}

export default function TradeHistoryScreen() {
  const { useBaskets } = useApi();
  const { resolvedTheme } = useTheme();
  const [activeTab, setActiveTab] = useState<TabId>("all");

  const { data, isLoading, isError, error, refetch, isFetching } = useBaskets(undefined, {
    refetchInterval: false,
    staleTime: 30_000,
    gcTime: 15 * 60 * 1000,
  });

  const rows = useMemo(
    () => (data?.baskets ?? [])
      .filter(basket => matches(basket, activeTab))
      .map(rowFor)
      .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")),
    [data, activeTab],
  );
  const realized = rows.reduce((total, row) => total + row.realized, 0);

  const colors = useMemo(() => resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#64748b", border: "#334155", accent: "#38bdf8", up: "#22c55e", down: "#ef4444" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", accent: "#0284c7", up: "#16a34a", down: "#dc2626" }, [resolvedTheme]);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
    title: { fontSize: 24, fontWeight: "700", color: colors.text },
    refresh: { flexDirection: "row", alignItems: "center", gap: 6 },
    refreshText: { fontSize: 13, fontWeight: "600", color: colors.accent },
    tabContainer: { flexDirection: "row", backgroundColor: colors.card, marginHorizontal: 16, marginTop: 12, borderRadius: 8, padding: 4, borderWidth: 1, borderColor: colors.border },
    tabButton: { flex: 1, paddingVertical: 10, alignItems: "center", borderRadius: 6 },
    tabButtonActive: { backgroundColor: colors.accent },
    tabLabel: { fontSize: 12, fontWeight: "600", color: colors.muted },
    tabLabelActive: { color: "#ffffff" },
    summary: { paddingHorizontal: 16, paddingTop: 12, gap: 2 },
    summaryText: { fontSize: 13, fontWeight: "600", color: colors.text },
    basis: { fontSize: 11, color: colors.muted, lineHeight: 16 },
    list: { flex: 1, paddingHorizontal: 16, marginTop: 8 },
    tradeItem: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
    badge: { width: 44, height: 44, borderRadius: 8, alignItems: "center", justifyContent: "center" },
    tradeInfo: { flex: 1 },
    tradeSymbol: { fontSize: 15, fontWeight: "600", color: colors.text },
    tradeMeta: { fontSize: 12, color: colors.muted, marginTop: 2 },
    tradeRight: { alignItems: "flex-end" },
    tradePnL: { fontSize: 15, fontWeight: "600" },
    tradeStatus: { fontSize: 11, color: colors.muted, marginTop: 2 },
    state: { alignItems: "center", justifyContent: "center", padding: 40, gap: 10 },
    stateTitle: { fontSize: 16, fontWeight: "600", color: colors.text, textAlign: "center" },
    stateBody: { fontSize: 14, color: colors.muted, textAlign: "center", lineHeight: 20 },
    retry: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8, borderWidth: 1, borderColor: colors.accent },
    retryText: { fontSize: 13, fontWeight: "600", color: colors.accent },
  }), [colors]);

  const emptyCopy: Record<TabId, { title: string; body: string }> = {
    all: { title: "No baskets on this account", body: "Prod names every position it can attribute to a basket. Nothing here is filled in by hand." },
    closed: { title: "Nothing closed yet", body: "A basket appears under Closed once prod has booked its exits." },
    automated: { title: "No automated runs", body: "Only strategies the broker ran show here; paper runs are counted by the desk that made them." },
    single: { title: "No single-leg baskets", body: "A basket holding one contract appears here." },
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Trade History</Text>
        <TouchableOpacity style={styles.refresh} onPress={() => refetch()} disabled={isFetching}>
          <Ionicons name={isFetching ? "refresh" : "refresh-outline"} size={18} color={colors.accent} />
          <Text style={styles.refreshText}>{isFetching ? "Reading" : "Refresh"}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.tabContainer}>
        {TABS.map(tab => (
          <TouchableOpacity
            key={tab.id}
            style={[styles.tabButton, activeTab === tab.id && styles.tabButtonActive]}
            onPress={() => setActiveTab(tab.id)}
          >
            <Text style={[styles.tabLabel, activeTab === tab.id && styles.tabLabelActive]}>{tab.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {rows.length > 0 && (
        <View style={styles.summary}>
          <Text style={styles.summaryText}>
            {`${rows.length} ${rows.length === 1 ? "position" : "positions"} · realized `}
            <Text style={{ color: realized >= 0 ? colors.up : colors.down }}>{signed(realized)}</Text>
          </Text>
          {data?.basis ? <Text style={styles.basis} numberOfLines={3}>{data.basis}</Text> : null}
        </View>
      )}

      {isLoading && !data ? (
        <View style={styles.state}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.stateTitle}>Reading your positions from the broker</Text>
        </View>
      ) : isError ? (
        <View style={styles.state}>
          <Ionicons name="cloud-offline-outline" size={44} color={colors.muted} />
          <Text style={styles.stateTitle}>History could not be read</Text>
          <Text style={styles.stateBody}>{error?.message ?? "The server did not answer."}</Text>
          <TouchableOpacity style={styles.retry} onPress={() => refetch()}>
            <Text style={styles.retryText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          style={styles.list}
          data={rows}
          keyExtractor={row => row.id}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          getItemLayout={(_, index) => ({ length: 69, offset: 69 * index, index })}
          renderItem={({ item }) => (
            <View style={styles.tradeItem}>
              <View style={[styles.badge, { backgroundColor: `${colors.accent}20` }]}>
                <Ionicons
                  name={item.single ? "business-outline" : "layers-outline"}
                  size={20}
                  color={item.realized < 0 ? colors.down : colors.accent}
                />
              </View>
              <View style={styles.tradeInfo}>
                <Text style={styles.tradeSymbol} numberOfLines={1}>{item.title}</Text>
                <Text style={styles.tradeMeta} numberOfLines={2}>
                  {item.detail}{item.at ? ` · ${item.at.slice(0, 10)}` : " · no dated record"}
                </Text>
              </View>
              <View style={styles.tradeRight}>
                <Text style={[styles.tradePnL, { color: item.realized >= 0 ? colors.up : colors.down }]}>
                  {signed(item.realized)}
                </Text>
                <Text style={styles.tradeStatus}>{item.status}</Text>
              </View>
            </View>
          )}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: colors.border }} />}
          ListEmptyComponent={
            <View style={styles.state}>
              <Ionicons name="document-text-outline" size={44} color={colors.muted} />
              <Text style={styles.stateTitle}>{emptyCopy[activeTab].title}</Text>
              <Text style={styles.stateBody}>{emptyCopy[activeTab].body}</Text>
            </View>
          }
        />
      )}
    </View>
  );
}
