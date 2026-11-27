/**
 * More Screen - Account facts, trading tools, appearance, build identity.
 *
 * Every row either changes something or opens a screen this build contains. A row that does neither is a
 * broken link drawn as a button: five rows here used to end in a "Coming Soon" alert, the theme row had no
 * control behind it and the color switch was welded on. What the phone cannot do yet is now named in the
 * account card instead of being drawn as a chevron over nothing.
 */

import React, { useMemo } from "react";
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert } from "react-native";
import Constants from "expo-constants";
import { useAuthStore, useUIStore } from "@nraialgo/shared/stores";
import { brokerSummary } from "@nraialgo/shared/api";
import { useTheme } from "@/components/ThemeProvider";
import { Ionicons } from "@expo/vector-icons";
import { useApi } from "@/hooks/useApi";
import { useClock } from "@/hooks/useClock";
import { router } from "expo-router";
import { prefetchAlgoLab, prefetchScanner, prefetchSpreadBuilder } from "@/utils/prefetch";
import { forgetLastKnown } from "@/hooks/useLastKnown";
import { serverLine } from "@/utils/serverHost";

const THEMES = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;

/**
 * The two facts `/v1/auth/me` answers about the account, in each of the three states that read can be in.
 * The rows never fall back to a dash: a trader deciding whether to re-link an account needs to know whether
 * the server said "no credentials" or never answered at all. The broker session is not one of these facts -
 * `/v1/auth/me` only reports that credentials exist, so it has its own row fed by the two status routes that
 * actually answer whether the app can reach the broker.
 */
export function accountLines(
  account: { displayName?: string; email?: string; mfaRequired?: boolean } | null,
  state: "ready" | "loading" | "failed",
) {
  if (state === "loading") {
    return { who: "Reading from myalgodesk.in…", mfa: "Checking…" };
  }
  if (state === "failed") {
    return {
      who: "Signed in on this phone",
      mfa: "Could not be read just now",
    };
  }
  if (!account) {
    return { who: "No account on this phone", mfa: "Not read yet" };
  }
  return {
    who: account.displayName || account.email || "No sign-in name on the account",
    mfa: account.mfaRequired ? "Required at sign-in" : "Not required",
  };
}

/**
 * The build the trader is holding, taken from the bundle rather than a string typed into a screen, so it
 * cannot disagree with the version that was actually installed.
 */
export function versionLine(): string {
  const version = Constants.expoConfig?.version;
  const build = Constants.expoConfig?.ios?.buildNumber
    ?? Constants.expoConfig?.android?.versionCode
    ?? Constants.nativeBuildVersion;
  if (!version) return "Not reported by this build";
  return build ? `${version} (build ${build})` : version;
}

export default function MoreScreen() {
  const { useMe, useLogout, useBrokerConnection } = useApi();
  const { theme, resolvedTheme } = useTheme();
  const { user, isAuthenticated, logout: logoutStore } = useAuthStore();
  const setTheme = useUIStore(state => state.setTheme);
  const { data: me, isLoading: meLoading, isError: meError } = useMe();
  const { data: connections, isLoading: brokersLoading, isError: brokersError } = useBrokerConnection();
  const logoutMutation = useLogout();
  const now = useClock();

  const colors = useMemo(() => resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#94a3b8", border: "#334155", danger: "#ef4444", accent: "#38bdf8", track: "#0f172a", onAccent: "#0f172a" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", danger: "#ef4444", accent: "#0284c7", track: "#f1f5f9", onAccent: "#ffffff" }, [resolvedTheme]);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    header: { padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
    title: { fontSize: 24, fontWeight: "700", color: colors.text },
    section: { marginTop: 24 },
    sectionTitle: { paddingHorizontal: 16, fontSize: 13, fontWeight: "600", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 },
    card: { backgroundColor: colors.card, borderRadius: 12, padding: 16, marginHorizontal: 16, borderWidth: 1, borderColor: colors.border },
    row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, gap: 14 },
    rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.border },
    label: { fontSize: 16, fontWeight: "500", color: colors.text },
    labelRow: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
    icon: { marginRight: 12 },
    value: { fontSize: 14, color: colors.muted, flexShrink: 1, textAlign: "right" },
    note: { fontSize: 13, color: colors.muted, lineHeight: 18, marginTop: 4 },
    themeTrack: { flexDirection: "row", backgroundColor: colors.track, borderRadius: 9, borderWidth: 1, borderColor: colors.border, padding: 2, flexShrink: 0 },
    themeChoice: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 7 },
    themeChoiceActive: { backgroundColor: colors.accent },
    themeText: { fontSize: 13, fontWeight: "600", color: colors.muted },
    themeTextActive: { color: colors.onAccent },
    dangerButton: { backgroundColor: "rgba(239,68,68,0.1)", borderRadius: 12, padding: 16, marginHorizontal: 16, marginTop: 24, borderWidth: 1, borderColor: "rgba(239,68,68,0.3)" },
    dangerButtonText: { textAlign: "center", fontSize: 16, fontWeight: "600", color: colors.danger },
    footnote: { textAlign: "center", padding: 24, fontSize: 12, color: colors.muted },
  }), [colors]);

  const handleLogout = () => {
    Alert.alert(
      "Sign out of this phone",
      "The app stops showing this account. Your other devices stay signed in to myalgodesk.in.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: () => {
            logoutMutation.mutate(undefined, {
              onSettled: () => {
                logoutStore();
                forgetLastKnown();
                router.replace("/login");
              },
            });
          },
        },
      ],
    );
  };

  // The copy saved at sign-in paints the card immediately and the server's answer replaces it, so the
  // screen never blocks on a read for facts the phone already holds.
  const lines = accountLines(me ?? user, meError ? "failed" : meLoading && !me ? "loading" : "ready");
  const broker = brokerSummary(
    connections ?? [],
    brokersError ? "failed" : brokersLoading && !connections ? "loading" : "ready",
    now,
  );
  const host = serverLine();

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={styles.header}>
        <Text style={styles.title}>More</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account</Text>
        <View style={styles.card}>
          <View style={[styles.row, styles.rowDivider]}>
            <View style={styles.labelRow}>
              <Ionicons name="person-circle-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Signed in</Text>
            </View>
            <Text style={styles.value} numberOfLines={1}>{lines.who}</Text>
          </View>
          <TouchableOpacity
            style={[styles.row, styles.rowDivider]}
            onPress={() => router.push("/broker-connection")}
            accessibilityRole="button"
          >
            <View style={styles.labelRow}>
              <Ionicons name="business-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Broker connection</Text>
            </View>
            <Text style={styles.value} numberOfLines={1}>{broker}</Text>
            <Ionicons name="chevron-forward-outline" size={20} color={colors.muted} />
          </TouchableOpacity>
          <View style={styles.row}>
            <View style={styles.labelRow}>
              <Ionicons name="lock-closed-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Two-factor</Text>
            </View>
            <Text style={styles.value}>{lines.mfa}</Text>
          </View>
          <Text style={styles.note}>
            Connecting a broker and changing two-factor settings happens on {host}. The app shows the
            account the broker reports.
          </Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Trading tools</Text>
        <View style={styles.card}>
          <TouchableOpacity
            style={[styles.row, styles.rowDivider]}
            onPress={() => router.push("/algo-lab")}
            onPressIn={prefetchAlgoLab}
            accessibilityRole="button"
          >
            <View style={styles.labelRow}>
              <Ionicons name="construct-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Algo Lab</Text>
            </View>
            <Ionicons name="chevron-forward-outline" size={20} color={colors.muted} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.row, styles.rowDivider]}
            onPress={() => router.push("/spread-builder")}
            onPressIn={() => prefetchSpreadBuilder()}
            accessibilityRole="button"
          >
            <View style={styles.labelRow}>
              <Ionicons name="layers-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Spread builder</Text>
            </View>
            <Ionicons name="chevron-forward-outline" size={20} color={colors.muted} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.row, styles.rowDivider]}
            onPress={() => router.push("/terminal-charts")}
            accessibilityRole="button"
          >
            <View style={styles.labelRow}>
              <Ionicons name="terminal-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Terminal charts</Text>
            </View>
            <Ionicons name="chevron-forward-outline" size={20} color={colors.muted} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.row, styles.rowDivider]}
            onPress={() => router.push("/scanner")}
            onPressIn={prefetchScanner}
            accessibilityRole="button"
          >
            <View style={styles.labelRow}>
              <Ionicons name="search-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Scanner</Text>
            </View>
            <Ionicons name="chevron-forward-outline" size={20} color={colors.muted} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.row}
            onPress={() => router.push("/trade-history")}
            accessibilityRole="button"
          >
            <View style={styles.labelRow}>
              <Ionicons name="document-text-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Trade history</Text>
            </View>
            <Ionicons name="chevron-forward-outline" size={20} color={colors.muted} />
          </TouchableOpacity>
        </View>
      </View>

      {/* The choice was always stored and read back by the app's theme provider; nothing drew a control. */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Appearance</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.labelRow}>
              <Ionicons name="color-palette-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Theme</Text>
            </View>
            <View style={styles.themeTrack} accessibilityRole="radiogroup" accessibilityLabel="Theme">
              {THEMES.map((choice) => (
                <TouchableOpacity
                  key={choice.id}
                  style={[styles.themeChoice, theme === choice.id && styles.themeChoiceActive]}
                  onPress={() => setTheme(choice.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: theme === choice.id }}
                >
                  <Text style={[styles.themeText, theme === choice.id && styles.themeTextActive]}>{choice.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>About</Text>
        <View style={styles.card}>
          <View style={[styles.row, styles.rowDivider]}>
            <View style={styles.labelRow}>
              <Ionicons name="information-circle-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>App version</Text>
            </View>
            <Text style={styles.value}>{versionLine()}</Text>
          </View>
          <View style={styles.row}>
            <View style={styles.labelRow}>
              <Ionicons name="globe-outline" size={24} color={colors.muted} style={styles.icon} />
              <Text style={styles.label}>Server</Text>
            </View>
            <Text style={styles.value}>{host}</Text>
          </View>
        </View>
      </View>

      {isAuthenticated && (
        <TouchableOpacity style={styles.dangerButton} onPress={handleLogout} accessibilityRole="button">
          <Text style={styles.dangerButtonText}>Sign out of this phone</Text>
        </TouchableOpacity>
      )}

      <Text style={styles.footnote}>Positions, orders and prices come from ICICI Direct.</Text>
    </ScrollView>
  );
}
