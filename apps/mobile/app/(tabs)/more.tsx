/**
 * More Screen - Settings, Account, Advanced Features
 */

import React, { useMemo } from "react";
import { View, Text, ScrollView, StyleSheet, Switch, TouchableOpacity, Alert, ActivityIndicator } from "react-native";
import { useAuthStore, useUIStore } from "@nraialgo/shared/stores";
import { useTheme, globalStyles } from "@/components/ThemeProvider";
import { Ionicons } from "@expo/vector-icons";
import { useApi } from "@/hooks/useApi";
import { router } from "expo-router";
import { prefetchAlgoLab, prefetchScanner, prefetchSpreadBuilder } from "@/utils/prefetch";
import { forgetLastKnown } from "@/hooks/useLastKnown";

export default function MoreScreen() {
  const { useMe, useLogout } = useApi();
  const { resolvedTheme } = useTheme();
  const { user, brokers, isAuthenticated, logout: logoutStore } = useAuthStore();
  const { theme, setTheme } = useUIStore();
  const { data: me, isLoading: meLoading } = useMe();
  const logoutMutation = useLogout();

  const colors = useMemo(() => resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#64748b", border: "#334155", danger: "#ef4444" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", danger: "#ef4444" }, [resolvedTheme]);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    header: { padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
    title: { fontSize: 24, fontWeight: "700", color: colors.text },
    section: { marginTop: 24 },
    sectionTitle: { paddingHorizontal: 16, fontSize: 13, fontWeight: "600", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 },
    card: { backgroundColor: colors.card, borderRadius: 12, padding: 16, marginHorizontal: 16, borderWidth: 1, borderColor: colors.border },
    row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12 },
    rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.border },
    label: { fontSize: 16, fontWeight: "500", color: colors.text },
    labelRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    icon: { marginRight: 12 },
    value: { fontSize: 14, color: colors.muted },
    chevron: { marginLeft: 8 },
    switchContainer: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    switchLabel: { fontSize: 16, fontWeight: "500", color: colors.text },
    dangerButton: { backgroundColor: "rgba(239,68,68,0.1)", borderRadius: 12, padding: 16, marginHorizontal: 16, marginTop: 24, borderWidth: 1, borderColor: "rgba(239,68,68,0.3)" },
    dangerButtonText: { textAlign: "center", fontSize: 16, fontWeight: "600", color: colors.danger },
    version: { textAlign: "center", padding: 24, fontSize: 12, color: colors.muted },
    loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  }), [colors]);

  const handleLogout = async () => {
    Alert.alert("Logout", "Are you sure you want to logout?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Logout",
        style: "destructive",
        onPress: async () => {
          logoutMutation.mutate(undefined, {
            onSettled: () => {
              logoutStore();
              forgetLastKnown();
              router.replace("/login");
            },
          });
        },
      },
    ]);
  };

  const showComingSoon = (feature: string) => {
    Alert.alert("Coming Soon", `${feature} is under development and will be available in a future update.`);
  };

  if (meLoading) {
    return (
      <View style={[styles.container, styles.loading]}>
        <ActivityIndicator size="large" color={resolvedTheme === "dark" ? "#38bdf8" : "#0284c7"} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={styles.header}>
        <Text style={styles.title}>More</Text>
      </View>

      {/* Account Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account</Text>
        <View style={styles.card}>
          <TouchableOpacity style={[styles.row, styles.rowDivider]} onPress={() => showComingSoon("Profile")} accessibilityRole="button">
            <View style={styles.labelRow}>
              <Ionicons name="person-circle-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Profile</Text>
            </View>
            <Ionicons name="chevron-forward-outline" size={20} color={colors.muted} style={styles.chevron} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.row, styles.rowDivider]} onPress={() => showComingSoon("Security")} accessibilityRole="button">
            <View style={styles.labelRow}>
              <Ionicons name="lock-closed-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Security</Text>
            </View>
            <Ionicons name="chevron-forward-outline" size={20} color={colors.muted} style={styles.chevron} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.row} onPress={() => showComingSoon("Notifications")} accessibilityRole="button">
            <View style={styles.labelRow}>
              <Ionicons name="notifications-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Notifications</Text>
            </View>
            <Ionicons name="chevron-forward-outline" size={20} color={colors.muted} style={styles.chevron} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Appearance Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Appearance</Text>
        <View style={styles.card}>
          <View style={[styles.row, styles.rowDivider]}>
            <View style={styles.labelRow}>
              <Ionicons name="color-palette-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Theme</Text>
            </View>
            <View style={styles.switchContainer}>
              <Text style={styles.switchLabel}>
                {theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System"}
              </Text>
            </View>
          </View>
          <View style={styles.row}>
            <View style={styles.labelRow}>
              <Ionicons name="eye-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Show P&L Colors</Text>
            </View>
            <Switch
              value={true}
              onValueChange={() => {}}
              thumbColor={resolvedTheme === "dark" ? "#38bdf8" : "#0284c7"}
              trackColor={{ true: resolvedTheme === "dark" ? "rgba(56,189,248,0.3)" : "rgba(2,132,199,0.3)", false: colors.border }}
            />
          </View>
        </View>
      </View>

      {/* Advanced Features */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Advanced</Text>
        <View style={styles.card}>
          <TouchableOpacity
            style={[styles.row, styles.rowDivider]}
            onPress={() => router.push("/algo-lab")}
            onPressIn={prefetchAlgoLab}
          >
            <View style={styles.labelRow}>
              <Ionicons name="construct-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Algo Lab</Text>
            </View>
            <Ionicons name="chevron-forward-outline" size={20} color={colors.muted} style={styles.chevron} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.row, styles.rowDivider]} onPressIn={() => prefetchSpreadBuilder()} onPress={() => router.push("/spread-builder")}>
            <View style={styles.labelRow}>
              <Ionicons name="layers-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Spread builder</Text>
            </View>
            <Ionicons name="chevron-forward-outline" size={20} color={colors.muted} style={styles.chevron} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.row, styles.rowDivider]} onPress={() => router.push("/terminal-charts")}>
            <View style={styles.labelRow}>
              <Ionicons name="terminal-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Terminal Charts</Text>
            </View>
            <Ionicons name="chevron-forward-outline" size={20} color={colors.muted} style={styles.chevron} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.row, styles.rowDivider]}
            onPress={() => router.push("/scanner")}
            onPressIn={prefetchScanner}
          >
            <View style={styles.labelRow}>
              <Ionicons name="search-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Scanner</Text>
            </View>
            <Ionicons name="chevron-forward-outline" size={20} color={colors.muted} style={styles.chevron} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.row} onPress={() => router.push("/trade-history")}>
            <View style={styles.labelRow}>
              <Ionicons name="document-text-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Trade History</Text>
            </View>
            <Ionicons name="chevron-forward-outline" size={20} color={colors.muted} style={styles.chevron} />
          </TouchableOpacity>
        </View>
      </View>

      {/* About Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>About</Text>
        <View style={styles.card}>
          <View style={[styles.row, styles.rowDivider]}>
            <View style={styles.labelRow}>
              <Ionicons name="information-circle-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Version</Text>
            </View>
            <Text style={styles.value}>1.0.0 (Beta)</Text>
          </View>
          <TouchableOpacity style={[styles.row, styles.rowDivider]} onPress={() => showComingSoon("Source Code")} accessibilityRole="button">
            <View style={styles.labelRow}>
              <Ionicons name="logo-github" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Source Code</Text>
            </View>
            <Ionicons name="chevron-forward-outline" size={20} color={colors.muted} style={styles.chevron} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.row} onPress={() => showComingSoon("Help & Support")} accessibilityRole="button">
            <View style={styles.labelRow}>
              <Ionicons name="help-circle-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Help & Support</Text>
            </View>
            <Ionicons name="chevron-forward-outline" size={20} color={colors.muted} style={styles.chevron} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Logout */}
      {isAuthenticated && (
        <TouchableOpacity style={styles.dangerButton} onPress={handleLogout}>
          <Text style={styles.dangerButtonText}>Logout</Text>
        </TouchableOpacity>
      )}

      <Text style={styles.version}>NRAIAlgo Mobile • Built with Expo & React Native</Text>
    </ScrollView>
  );
}