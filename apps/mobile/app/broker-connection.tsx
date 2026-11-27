/**
 * Broker Connection Screen - whether this phone may read the broker at all, and until when.
 *
 * Every tab in the app prints numbers that reached it through one broker session, and until now no screen on
 * the phone said whether that session is alive. Prod answers this with two routes: the saved credentials and
 * the live sessions are separate facts, and only together do they separate "never authorized" from
 * "authorized and since ran out" - the first sends a trader to connect, the second to reconnect.
 *
 * The screen is read-only on purpose. Saving credentials and authorizing a session are browser actions on the
 * web desk, and the phone holds no broker password, so each row names the host instead of drawing a button
 * that would fail.
 */

import React, { useMemo } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useCanGoBack } from "expo-router";
import {
  agoWord,
  connectionAdvice,
  connectionState,
  connectionTone,
  connectionWord,
  NO_BROKER_WORD,
  type BrokerConnection,
} from "@nraialgo/shared/api";
import { useApi } from "@/hooks/useApi";
import { useClock } from "@/hooks/useClock";
import { useTheme } from "@/components/ThemeProvider";
import { serverLine } from "@/utils/serverHost";

/** The dot is the only colour on the screen, so it comes from the state and never from the row. */
const TONE_COLORS = {
  good: { dark: "#22c55e", light: "#16a34a" },
  warn: { dark: "#f59e0b", light: "#d97706" },
  bad: { dark: "#ef4444", light: "#dc2626" },
} as const;

/**
 * One row of the list, in the order a trader reads it: which broker, what prod says about it right now, then
 * what to do. `credentialsAt` keeps the server's own stamp so "credentials saved 3 days ago" is a fact the
 * response carries rather than a date the phone invents.
 */
function connectionLine(connection: BrokerConnection, host: string, now: number): { head: string; detail: string } {
  const advice = connectionAdvice(connection, host, now);
  const saved = connection.credentialsAt
    ? ` Credentials saved ${agoWord(Date.parse(connection.credentialsAt), now)}.`
    : "";
  return { head: connectionWord(connection, now), detail: `${advice}${saved}` };
}

export default function BrokerConnectionScreen() {
  const { useBrokerConnection } = useApi();
  const { resolvedTheme } = useTheme();
  const canGoBack = useCanGoBack();
  const now = useClock();
  const { data, dataUpdatedAt, isLoading, isError, isRefetching, refetch } = useBrokerConnection();

  const host = serverLine();
  const dark = resolvedTheme === "dark";

  const colors = useMemo(() => dark
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#94a3b8", border: "#334155", accent: "#38bdf8" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", accent: "#0284c7" }, [dark]);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    head: { flexDirection: "row", alignItems: "center", gap: 10, padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
    headMain: { flex: 1 },
    title: { fontSize: 20, fontWeight: "700", color: colors.text },
    meta: { fontSize: 12, color: colors.muted, marginTop: 2 },
    section: { padding: 16 },
    card: { backgroundColor: colors.card, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: colors.border, marginBottom: 12 },
    cardHead: { flexDirection: "row", alignItems: "center", gap: 10 },
    provider: { flex: 1, fontSize: 16, fontWeight: "600", color: colors.text },
    state: { fontSize: 15, fontWeight: "600", marginTop: 10 },
    advice: { fontSize: 13, color: colors.muted, lineHeight: 19, marginTop: 4 },
    note: { fontSize: 13, color: colors.muted, lineHeight: 19 },
    action: { marginTop: 4, paddingVertical: 10 },
    actionText: { color: colors.accent, fontWeight: "600", fontSize: 15 },
  }), [colors]);

  const toneColor = (tone: "good" | "warn" | "bad") => TONE_COLORS[tone][dark ? "dark" : "light"];

  const read = (): React.ReactNode => {
    if (isLoading && !data) {
      return (
        <View style={styles.card}>
          <Text style={styles.state}>Reading from {host}…</Text>
          <Text style={styles.advice}>The app asks the server which brokers have credentials and which hold a live session.</Text>
        </View>
      );
    }
    if (isError && !data) {
      return (
        <View style={styles.card}>
          <Text style={[styles.state, { color: toneColor("bad") }]}>The broker status could not be read</Text>
          <Text style={styles.advice}>
            The app is signed in to {host} but that server did not answer the status request, so it does not know
            whether a broker session is alive.
          </Text>
          <TouchableOpacity style={styles.action} onPress={() => void refetch()} accessibilityRole="button" accessibilityLabel="Retry the broker status read">
            <Text style={styles.actionText}>Tap to retry</Text>
          </TouchableOpacity>
        </View>
      );
    }
    const connections = data ?? [];
    if (!connections.length) {
      return (
        <View style={styles.card}>
          <Text style={[styles.state, { color: toneColor("bad") }]}>{NO_BROKER_WORD}</Text>
          <Text style={styles.advice}>
            {host} reported no broker for this account, so no tab in the app can read the broker yet. Save the
            broker's API credentials once on {host}, then authorize a session there.
          </Text>
        </View>
      );
    }
    return connections.map(connection => {
      // Derived on every render so a session that runs out while the screen is open changes colour without a read.
      const tone = connectionTone(connectionState(connection.credentialsAt, connection.sessionUntil, now));
      const line = connectionLine(connection, host, now);
      return (
        <View key={connection.provider} style={styles.card}>
          <View style={styles.cardHead}>
            <Ionicons name="ellipse" size={12} color={toneColor(tone)} />
            <Text style={styles.provider}>{connection.name}</Text>
          </View>
          <Text style={[styles.state, { color: toneColor(tone) }]}>{line.head}</Text>
          <Text style={styles.advice}>{line.detail}</Text>
        </View>
      );
    });
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
          <Text style={styles.title}>Broker connection</Text>
          <Text style={styles.meta}>
            {dataUpdatedAt ? `Last read ${agoWord(dataUpdatedAt, now)} from ${host}` : `Reading from ${host}`}
          </Text>
        </View>
      </View>

      <View style={styles.section}>
        {read()}
        <Text style={styles.note}>
          This app never holds a broker password, and it cannot authorize a session from the phone. Pull down to
          ask {host} again after connecting there - the positions, orders and prices tabs restart from that read.
        </Text>
      </View>
    </ScrollView>
  );
}
