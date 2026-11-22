/**
 * Orders Screen - Order History & Management
 */

import React from "react";
import { View, Text, FlatList, StyleSheet, ActivityIndicator, TouchableOpacity, Alert, RefreshControl } from "react-native";
import { useTheme } from "@/components/ThemeProvider";
import { formatRupees, formatNumber } from "@nraialgo/shared/utils";
import { Ionicons } from "@expo/vector-icons";
import { useApi } from "@/hooks/useApi";

export default function OrdersScreen() {
  const { useOrderIntents } = useApi();
  const { resolvedTheme } = useTheme();
  const { data, isLoading, isError, refetch } = useOrderIntents({ limit: 50 });

  const colors = resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#64748b", border: "#334155", brand: { "600": "#38bdf8" } }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", brand: { "600": "#0284c7" } };

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    header: { padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
    title: { fontSize: 24, fontWeight: "700", color: colors.text },
    subtitle: { fontSize: 14, color: colors.muted, marginTop: 4 },
    listContent: { padding: 16, paddingBottom: 100 },
    card: {
      backgroundColor: colors.card,
      borderRadius: 12,
      padding: 16,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: colors.border,
    },
    orderHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
    basketName: { fontSize: 16, fontWeight: "600", color: colors.text },
    statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, fontSize: 11, fontWeight: "600" },
    statusWorking: { backgroundColor: "rgba(56,189,248,0.15)", color: "#38bdf8" },
    statusDone: { backgroundColor: "rgba(34,197,94,0.15)", color: "#22c55e" },
    statusRejected: { backgroundColor: "rgba(239,68,68,0.15)", color: "#ef4444" },
    statusPartial: { backgroundColor: "rgba(245,158,11,0.15)", color: "#f59e0b" },
    detailRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
    detailLabel: { fontSize: 12, color: colors.muted },
    detailValue: { fontSize: 12, fontWeight: "500", color: colors.text },
    legsContainer: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border },
    legRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
    legSymbol: { fontSize: 13, fontWeight: "500", color: colors.text },
    legDetails: { fontSize: 12, color: colors.muted },
    empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40 },
    emptyText: { fontSize: 16, color: colors.muted, textAlign: "center" },
    loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  });

  const getStatusStyle = (status: string) => {
    switch (status) {
      case "working": return styles.statusWorking;
      case "done": return styles.statusDone;
      case "rejected": return styles.statusRejected;
      case "partial": return styles.statusPartial;
      default: return styles.statusWorking;
    }
  };

  if (isLoading) {
    return (
      <View style={[styles.container, styles.loading]}>
        <ActivityIndicator size="large" color={resolvedTheme === "dark" ? "#38bdf8" : "#0284c7"} />
      </View>
    );
  }

  if (isError) {
    return (
      <View style={[styles.container, styles.empty]}>
        <Text style={styles.emptyText}>Failed to load orders</Text>
        <TouchableOpacity style={{ marginTop: 16, paddingVertical: 12, alignItems: "center" }} onPress={() => void refetch()}>
          <Text style={{ color: colors.brand?.["600"] || "#0284c7", fontWeight: "600" }}>Tap to retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!data?.length) {
    return (
      <View style={[styles.container, styles.empty]}>
        <Text style={styles.emptyText}>No orders yet\nPlace your first order from the Options tab</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Orders</Text>
        <Text style={styles.subtitle}>{data.length} recent order{data.length !== 1 ? "s" : ""}</Text>
      </View>

      <FlatList
        data={data}
        keyExtractor={(item) => item.clientId}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.orderHeader}>
              <Text style={styles.basketName}>{item.basketName ?? "Single Order"}</Text>
              <Text style={[styles.statusBadge, getStatusStyle(item.status)]}>{item.status.toUpperCase()}</Text>
            </View>

            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Provider</Text>
              <Text style={styles.detailValue}>{item.provider}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Account</Text>
              <Text style={styles.detailValue}>{item.accountId ?? item.brokerAccountId ?? "—"}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Created</Text>
              <Text style={styles.detailValue}>{new Date(item.createdAt).toLocaleString()}</Text>
            </View>

            {item.orders?.length && (
              <View style={styles.legsContainer}>
                <Text style={{ fontSize: 12, fontWeight: "600", color: colors.muted, marginBottom: 8 }}>Legs</Text>
                {item.orders.map((leg, i) => (
                  <View key={i} style={styles.legRow}>
                    <Text style={styles.legSymbol}>{leg.tradingsymbol}</Text>
                    <Text style={styles.legDetails}>
                      {leg.side} {formatNumber(leg.filledQuantity)}/{formatNumber(leg.quantity)} @ {leg.averagePrice ? formatRupees(leg.averagePrice) : "Market"}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={false} onRefresh={() => void refetch()} colors={[resolvedTheme === "dark" ? "#38bdf8" : "#0284c7"]} />
        }
      />
    </View>
  );
}