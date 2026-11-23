/**
 * Orders Screen - Pending, Executed, and GTT Orders
 */

import React, { useState, useMemo } from "react";
import { View, Text, FlatList, StyleSheet, ActivityIndicator, TouchableOpacity, RefreshControl, SectionList } from "react-native";
import { useTheme } from "@/components/ThemeProvider";
import { formatRupees, formatNumber } from "@nraialgo/shared/utils";
import { useApi } from "@/hooks/useApi";
import type { OrderIntent, OrderLine, GttOrder } from "@nraialgo/shared/api";

type TabId = "pending" | "executed" | "gtt";

const TABS: { id: TabId; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "executed", label: "Executed" },
  { id: "gtt", label: "GTT Orders" },
];

export default function OrdersScreen() {
  const { useOrderIntents, useGttOrders } = useApi();
  const { resolvedTheme } = useTheme();
  const [tab, setTab] = useState<TabId>("pending");

  const { data: intents, isLoading: intentsLoading, isError: intentsError, refetch: refetchIntents } = useOrderIntents({ limit: 100 });
  const { data: gtts, isLoading: gttLoading, isError: gttError, refetch: refetchGtts } = useGttOrders();

  const colors = resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#64748b", border: "#334155", accent: "#38bdf8", buy: "#22c55e", sell: "#ef4444" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", accent: "#0284c7", buy: "#16a34a", sell: "#dc2626" };

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    tabBar: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.card },
    tab: { flex: 1, paddingVertical: 12, alignItems: "center" },
    tabActive: { borderBottomWidth: 2, borderBottomColor: colors.accent },
    tabText: { fontSize: 13, fontWeight: "500", color: colors.muted },
    tabTextActive: { color: colors.accent, fontWeight: "600" },
    listContent: { padding: 12, paddingBottom: 100 },
    card: {
      backgroundColor: colors.card,
      borderRadius: 10,
      padding: 12,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: colors.border,
    },
    header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
    symbol: { fontSize: 14, fontWeight: "600", color: colors.text },
    badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, fontSize: 10, fontWeight: "600" },
    badgeWorking: { backgroundColor: "rgba(56,189,248,0.15)", color: "#38bdf8" },
    badgeDone: { backgroundColor: "rgba(34,197,94,0.15)", color: "#22c55e" },
    badgeRejected: { backgroundColor: "rgba(239,68,68,0.15)", color: "#ef4444" },
    badgePartial: { backgroundColor: "rgba(245,158,11,0.15)", color: "#f59e0b" },
    badgeActive: { backgroundColor: "rgba(56,189,248,0.15)", color: "#38bdf8" },
    badgeTriggered: { backgroundColor: "rgba(34,197,94,0.15)", color: "#22c55e" },
    badgeExpired: { backgroundColor: "rgba(100,116,139,0.15)", color: "#64748b" },
    row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
    label: { fontSize: 11, color: colors.muted },
    value: { fontSize: 12, fontWeight: "500", color: colors.text },
    buyValue: { color: colors.buy },
    sellValue: { color: colors.sell },
    empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40 },
    emptyText: { fontSize: 14, color: colors.muted, textAlign: "center" },
    loading: { flex: 1, alignItems: "center", justifyContent: "center" },
    sectionHeader: { fontSize: 11, fontWeight: "600", color: colors.muted, textTransform: "uppercase", paddingVertical: 8, paddingHorizontal: 4, backgroundColor: colors.bg },
  });

  const pendingOrders = useMemo(() => {
    if (!intents) return [];
    return intents.filter(o => o.status === "working" || o.status === "partial");
  }, [intents]);

  const executedOrders = useMemo(() => {
    if (!intents) return [];
    return intents.filter(o => o.status === "done" || o.status === "rejected");
  }, [intents]);

  const isLoading = tab === "gtt" ? gttLoading : intentsLoading;
  const isError = tab === "gtt" ? gttError : intentsError;
  const refetch = tab === "gtt" ? refetchGtts : refetchIntents;

  if (isLoading) {
    return (
      <View style={[styles.container, styles.loading]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (isError) {
    return (
      <View style={[styles.container, styles.empty]}>
        <Text style={styles.emptyText}>Failed to load orders</Text>
        <TouchableOpacity style={{ marginTop: 16, paddingVertical: 12, alignItems: "center" }} onPress={() => void refetch()}>
          <Text style={{ color: colors.accent, fontWeight: "600" }}>Tap to retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const renderOrderCard = (intent: OrderIntent) => {
    const legs = intent.orders || [];
    const firstLeg = legs[0];
    return (
      <View key={intent.clientId} style={styles.card}>
        <View style={styles.header}>
          <Text style={styles.symbol}>{firstLeg?.tradingsymbol || intent.basketName || "Order"}</Text>
          <Text style={[styles.badge, intent.status === "working" ? styles.badgeWorking : intent.status === "done" ? styles.badgeDone : intent.status === "rejected" ? styles.badgeRejected : styles.badgePartial]}>
            {intent.status.toUpperCase()}
          </Text>
        </View>
        {legs.map((leg: OrderLine, i: number) => (
          <View key={i} style={styles.row}>
            <Text style={[styles.value, leg.side === "BUY" ? styles.buyValue : styles.sellValue]}>
              {leg.side} {formatNumber(leg.filledQuantity)}/{formatNumber(leg.quantity)}
            </Text>
            <Text style={styles.value}>
              {leg.averagePrice ? formatRupees(leg.averagePrice) : "—"}
            </Text>
          </View>
        ))}
        <View style={[styles.row, { marginTop: 4 }]}>
          <Text style={styles.label}>{intent.provider} · {new Date(intent.createdAt).toLocaleTimeString()}</Text>
        </View>
      </View>
    );
  };

  const renderGttCard = (gtt: GttOrder) => {
    const spec = gtt.order_spec as Record<string, unknown>;
    const symbol = (spec?.tradingsymbol as string) || (spec?.symbol as string) || "GTT";
    const side = (spec?.side as string) || "";
    const quantity = (spec?.quantity as number) || 0;
    const price = (spec?.price as number) || 0;
    return (
      <View key={gtt.id} style={styles.card}>
        <View style={styles.header}>
          <Text style={styles.symbol}>{symbol}</Text>
          <Text style={[styles.badge, gtt.state === "active" ? styles.badgeActive : gtt.state === "triggered" ? styles.badgeTriggered : styles.badgeExpired]}>
            {gtt.state.toUpperCase()}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={[styles.value, side === "BUY" ? styles.buyValue : styles.sellValue]}>
            {side} {formatNumber(quantity)}
          </Text>
          <Text style={styles.value}>Trigger: ₹{gtt.trigger_price}</Text>
        </View>
        {price > 0 && (
          <View style={styles.row}>
            <Text style={styles.label}>Limit</Text>
            <Text style={styles.value}>{formatRupees(price)}</Text>
          </View>
        )}
        <View style={[styles.row, { marginTop: 4 }]}>
          <Text style={styles.label}>{gtt.provider} · {new Date(gtt.created_at).toLocaleDateString()}</Text>
        </View>
      </View>
    );
  };

  const renderContent = () => {
    if (tab === "pending") {
      if (pendingOrders.length === 0) {
        return <View style={styles.empty}><Text style={styles.emptyText}>No pending orders</Text></View>;
      }
      return (
        <FlatList
          data={pendingOrders}
          keyExtractor={(item) => item.clientId}
          renderItem={({ item }) => renderOrderCard(item)}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={false} onRefresh={() => void refetchIntents()} colors={[colors.accent]} />}
        />
      );
    }

    if (tab === "executed") {
      if (executedOrders.length === 0) {
        return <View style={styles.empty}><Text style={styles.emptyText}>No executed orders</Text></View>;
      }
      return (
        <FlatList
          data={executedOrders}
          keyExtractor={(item) => item.clientId}
          renderItem={({ item }) => renderOrderCard(item)}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={false} onRefresh={() => void refetchIntents()} colors={[colors.accent]} />}
        />
      );
    }

    if (tab === "gtt") {
      if (!gtts || gtts.length === 0) {
        return <View style={styles.empty}><Text style={styles.emptyText}>No GTT orders</Text></View>;
      }
      return (
        <FlatList
          data={gtts}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => renderGttCard(item)}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={false} onRefresh={() => void refetchGtts()} colors={[colors.accent]} />}
        />
      );
    }

    return null;
  };

  return (
    <View style={styles.container}>
      <View style={styles.tabBar}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.id}
            style={[styles.tab, tab === t.id && styles.tabActive]}
            onPress={() => setTab(t.id)}
          >
            <Text style={[styles.tabText, tab === t.id && styles.tabTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {renderContent()}
    </View>
  );
}
