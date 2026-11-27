/**
 * Security Screen - what the server knows about this sign-in, and the one action that ends it everywhere.
 *
 * The read is `/v1/auth/mfa`, which prod leaves open to a session that still owes a code. That makes it the
 * screen a trader reaches when every other tab came back with a 403: it says whether the account has no
 * two-factor at all, or has it and this device simply has not used it yet. The two answers send them to
 * different places.
 *
 * Enrolling two-factor stays on the web desk. It needs the authenticator QR scanned and the recovery codes
 * shown once, and this app has no camera or printer in the way that job needs.
 */

import React, { useMemo } from "react";
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useCanGoBack } from "expo-router";
import { agoWord, securityLines, SIGN_OUT_ALL_TITLE, SIGN_OUT_ALL_WARNING, type SecurityLine } from "@nraialgo/shared/api";
import { useAuthStore } from "@nraialgo/shared/stores";
import { useApi } from "@/hooks/useApi";
import { useClock } from "@/hooks/useClock";
import { useTheme } from "@/components/ThemeProvider";
import { serverLine } from "@/utils/serverHost";
import { forgetLastKnown } from "@/hooks/useLastKnown";

const TONE_COLORS = {
  good: { dark: "#22c55e", light: "#16a34a" },
  warn: { dark: "#f59e0b", light: "#d97706" },
  bad: { dark: "#ef4444", light: "#dc2626" },
  neutral: { dark: "#94a3b8", light: "#64748b" },
} as const;

export default function SecurityScreen() {
  const { useMfa, useLogoutAll } = useApi();
  const { resolvedTheme } = useTheme();
  const canGoBack = useCanGoBack();
  const now = useClock();
  const { logout: logoutStore } = useAuthStore();
  const { data: status, dataUpdatedAt, isLoading, isError, isRefetching, refetch } = useMfa();
  const logoutAll = useLogoutAll();

  const host = serverLine();
  const dark = resolvedTheme === "dark";

  const colors = useMemo(() => dark
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#94a3b8", border: "#334155", accent: "#38bdf8", danger: "#ef4444" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", accent: "#0284c7", danger: "#dc2626" }, [dark]);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    head: { flexDirection: "row", alignItems: "center", gap: 10, padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
    headMain: { flex: 1 },
    title: { fontSize: 20, fontWeight: "700", color: colors.text },
    meta: { fontSize: 12, color: colors.muted, marginTop: 2 },
    section: { padding: 16 },
    card: { backgroundColor: colors.card, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: colors.border, marginBottom: 12 },
    cardHead: { flexDirection: "row", alignItems: "center", gap: 10 },
    label: { flex: 1, fontSize: 16, fontWeight: "600", color: colors.text },
    value: { fontSize: 15, fontWeight: "600", marginTop: 8 },
    detail: { fontSize: 13, color: colors.muted, lineHeight: 19, marginTop: 4 },
    note: { fontSize: 13, color: colors.muted, lineHeight: 19 },
    dangerCard: { backgroundColor: "rgba(239,68,68,0.08)", borderRadius: 12, padding: 16, borderWidth: 1, borderColor: "rgba(239,68,68,0.3)", marginTop: 20 },
    dangerTitle: { fontSize: 16, fontWeight: "700", color: colors.danger },
    dangerText: { fontSize: 13, color: colors.muted, lineHeight: 19, marginTop: 6 },
    action: { marginTop: 4, paddingVertical: 10 },
    actionText: { color: colors.accent, fontWeight: "600", fontSize: 15 },
  }), [colors]);

  const toneColor = (tone: SecurityLine["tone"]) => TONE_COLORS[tone][dark ? "dark" : "light"];

  // Signing out everywhere is the one destructive thing on this screen, so it asks in the server's own words
  // and only clears this phone after the server has answered.
  const confirmSignOutAll = () => {
    Alert.alert(SIGN_OUT_ALL_TITLE, SIGN_OUT_ALL_WARNING, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out everywhere",
        style: "destructive",
        onPress: () => {
          logoutAll.mutate(undefined, {
            onSuccess: () => {
              logoutStore();
              forgetLastKnown();
              router.replace("/login");
            },
          });
        },
      },
    ]);
  };

  const read = (): React.ReactNode => {
    if (isLoading && !status) {
      return (
        <View style={styles.card}>
          <Text style={[styles.value, { color: colors.text }]}>Reading from {host}…</Text>
          <Text style={styles.detail}>The app is asking whether this account has two-factor and whether this sign-in has used it.</Text>
        </View>
      );
    }
    if (isError && !status) {
      return (
        <View style={styles.card}>
          <Text style={[styles.value, { color: colors.danger }]}>The sign-in settings could not be read</Text>
          <Text style={styles.detail}>
            {host} did not answer the two-factor status request, so the app cannot say whether this account is
            protected or whether this session still owes a code.
          </Text>
          <TouchableOpacity style={styles.action} onPress={() => void refetch()} accessibilityRole="button" accessibilityLabel="Retry the sign-in settings read">
            <Text style={styles.actionText}>Tap to retry</Text>
          </TouchableOpacity>
        </View>
      );
    }
    if (!status) return null;
    return securityLines(status, host).map(line => (
      <View key={line.label} style={styles.card}>
        <View style={styles.cardHead}>
          <Ionicons name="ellipse" size={12} color={toneColor(line.tone)} />
          <Text style={styles.label}>{line.label}</Text>
        </View>
        <Text style={[styles.value, line.tone === "neutral" ? { color: colors.text } : { color: toneColor(line.tone) }]}>
          {line.value}
        </Text>
        <Text style={styles.detail}>{line.detail}</Text>
      </View>
    ));
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: 40 }}
      refreshControl={(
        <RefreshControl
          refreshing={isRefetching}
          onRefresh={() => void refetch()}
          tintColor={colors.accent}
          colors={[colors.accent]}
        />
      )}
    >
      <View style={styles.head}>
        <TouchableOpacity onPress={() => (canGoBack ? router.back() : router.replace("/(tabs)/more"))} hitSlop={10} accessibilityLabel="Go back">
          <Ionicons name="arrow-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headMain}>
          <Text style={styles.title}>Security</Text>
          <Text style={styles.meta}>
            {dataUpdatedAt ? `Last read ${agoWord(dataUpdatedAt, now)} from ${host}` : `Reading from ${host}`}
          </Text>
        </View>
      </View>

      <View style={styles.section}>
        {read()}
        {status ? (
          <Text style={styles.note}>
            Turning two-factor on or off happens on {host}. It needs the authenticator QR scanned and the
            recovery codes copied once, which this app does not do yet.
          </Text>
        ) : null}

        <View style={styles.dangerCard}>
          <Text style={styles.dangerTitle}>{SIGN_OUT_ALL_TITLE}</Text>
          <Text style={styles.dangerText}>{SIGN_OUT_ALL_WARNING}</Text>
          {logoutAll.isPending ? (
            <Text style={[styles.dangerText, { color: colors.danger, fontWeight: "600" }]}>Signing the other devices out…</Text>
          ) : (
            <TouchableOpacity style={styles.action} onPress={confirmSignOutAll} accessibilityRole="button" accessibilityLabel={SIGN_OUT_ALL_TITLE}>
              <Text style={[styles.actionText, { color: colors.danger, fontWeight: "700" }]}>Sign out everywhere</Text>
            </TouchableOpacity>
          )}
          {logoutAll.error ? (
            <Text style={[styles.dangerText, { color: colors.danger }]}>
              {host} did not sign the other devices out: {logoutAll.error.message}. This phone stayed signed in.
            </Text>
          ) : null}
        </View>
      </View>
    </ScrollView>
  );
}
