/**
 * The notice line that appears wherever the trader happens to be.
 *
 * Mounted once, in the shell every route shares, so a fill announced while the chain is open is worded and
 * coloured exactly like one announced on the positions desk. It is not a push notification: nothing is
 * scheduled and no device token is registered, so the line shows while the app is open and the unread badge on
 * the Orders tab is what remains after it goes away.
 *
 * It stays until it is tapped or dismissed, which is the whole point of the screen — a fill that scrolled away
 * after eight seconds is a fill the trader may never have seen.
 */

import React, { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import { noticeSummary, noticeTitle, unshownNotices, type OrderNotice } from "@nraialgo/shared/api";
import { formatISTTime } from "@nraialgo/shared/utils";
import { useApi } from "@/hooks/useApi";
import { useTheme } from "@/components/ThemeProvider";

/** Tints follow the event, not a sentence: green landed, red needs looking, blue is on its way. */
function toneOf(row: OrderNotice): "good" | "bad" | "sent" {
  if (row.event_kind === "failed" || row.event_kind === "attention") return "bad";
  if (row.event_kind === "executed" || row.event_kind === "leg_filled") return "good";
  return "sent";
}

export default function OrderNoticeBanner() {
  const { resolvedTheme } = useTheme();
  const router = useRouter();
  const { useOrderInbox, useOrderNoticeRead } = useApi();
  const inbox = useOrderInbox();
  const markRead = useOrderNoticeRead();

  const colors = useMemo(() => (resolvedTheme === "dark"
    ? { bg: "#0f172a", text: "#f1f5f9", muted: "#64748b", border: "#334155", accent: "#38bdf8", good: "#22c55e", bad: "#ef4444" }
    : { bg: "#f8fafc", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", accent: "#0284c7", good: "#16a34a", bad: "#dc2626" }), [resolvedTheme]);

  const rows = inbox.data;

  /** Ids this launch has already put on screen, so one fill is announced once rather than on every re-read. */
  const [announced, setAnnounced] = useState<number[]>([]);
  /** Nothing on the first read: the inbox is a list, and yesterday's fills are not news. */
  const [primed, setPrimed] = useState(false);

  const fresh = useMemo(() => unshownNotices(rows ?? [], announced, !primed), [rows, announced, primed]);
  const current = fresh.length > 0 ? fresh[0] : null;

  useEffect(() => {
    if (!rows) return;
    if (!primed) {
      setPrimed(true);
      setAnnounced(rows.map((row) => row.id));
    }
  }, [rows, primed]);

  if (!current) return null;

  const tone = toneOf(current);
  const accent = tone === "bad" ? colors.bad : tone === "good" ? colors.good : colors.accent;
  const summary = noticeSummary(current);

  const close = () => setAnnounced((ids) => [...ids, current.id]);

  return (
    <View style={[styles.banner, { backgroundColor: colors.bg, borderColor: accent }]} accessibilityRole="alert">
      <TouchableOpacity
        style={styles.body}
        accessibilityRole="button"
        accessibilityLabel={`Order notice: ${noticeTitle(current)}. Open the orders desk.`}
        onPress={() => {
          markRead.mutate(current.id);
          close();
          router.navigate("/(tabs)/orders");
        }}
      >
        <View style={styles.head}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>{noticeTitle(current)}</Text>
          <Text style={[styles.time, { color: accent }]}>{formatISTTime(current.occurred_at)}</Text>
        </View>
        {summary ? <Text style={[styles.summary, { color: colors.muted }]} numberOfLines={3}>{summary}</Text> : null}
        <Text style={[styles.action, { color: accent }]}>{"Open Orders ›"}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.dismiss}
        accessibilityRole="button"
        accessibilityLabel={`Dismiss this notice: ${noticeTitle(current)}`}
        onPress={() => {
          markRead.mutate(current.id);
          close();
        }}
      >
        <Text style={[styles.dismissText, { color: colors.muted }]}>{"Dismiss"}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginHorizontal: 12,
    marginTop: 8,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  body: { flex: 1 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  title: { flex: 1, fontSize: 14, fontWeight: "700" },
  time: { fontSize: 11, fontWeight: "700" },
  summary: { fontSize: 12, lineHeight: 17, marginTop: 3 },
  action: { fontSize: 12, fontWeight: "700", marginTop: 6 },
  dismiss: { paddingLeft: 10, paddingTop: 2 },
  dismissText: { fontSize: 11, fontWeight: "600" },
});
