/**
 * A fill says itself once, then gets out of the way.
 *
 * The banner this replaces held a line of the screen on every route until it was tapped, and the trader is
 * usually on a route that needs that line for itself - the book, the chain, the ticket. The owner asked for the
 * notification surface gone and a toast in its place, so the same server words now stand over the tab bar for a
 * few seconds and disappear.
 *
 * It is still not a push notification: nothing is scheduled and no device token is registered, so a toast shows
 * only while the app is open. What is left after it goes is the notice itself, unread in the Orders list, which
 * is where a trader goes to read it properly.
 *
 * Two details carry the weight:
 *
 * - A burst is walked one toast at a time. Retiring the current row makes `unshownNotices` hand back the next,
 *   so three fills landing on one poll produce three toasts and none is skipped.
 * - Letting a toast time out does NOT mark the notice read. Only a tap does, because a message the trader may
 *   never have looked at must not silently clear their unread list.
 */

import React, { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { noticeSummary, noticeTitle, unshownNotices, type OrderNotice } from "@nraialgo/shared/api";
import { formatISTTime } from "@nraialgo/shared/utils";
import { useApi } from "@/hooks/useApi";
import { useTheme } from "@/components/ThemeProvider";

/** Long enough to read a fill line, short enough that the trader never has to dismiss anything. */
const SHOW_MS = 6000;

/** Tints follow the event, not a sentence: green landed, red needs looking, blue is on its way. */
function toneOf(row: OrderNotice): "good" | "bad" | "sent" {
  if (row.event_kind === "failed" || row.event_kind === "attention") return "bad";
  if (row.event_kind === "executed" || row.event_kind === "leg_filled") return "good";
  return "sent";
}

export default function OrderNoticeToast() {
  const { resolvedTheme } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { useOrderInbox, useOrderNoticeRead } = useApi();
  const inbox = useOrderInbox();
  const markRead = useOrderNoticeRead();

  const colors = useMemo(() => (resolvedTheme === "dark"
    ? { bg: "#0f172a", text: "#f1f5f9", muted: "#94a3b8", border: "#334155", accent: "#38bdf8", good: "#22c55e", bad: "#ef4444" }
    : { bg: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", accent: "#0284c7", good: "#16a34a", bad: "#dc2626" }), [resolvedTheme]);

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

  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => setAnnounced((ids) => [...ids, current.id]), SHOW_MS);
    return () => clearTimeout(timer);
  }, [current]);

  if (!current) return null;

  const tone = toneOf(current);
  const accent = tone === "bad" ? colors.bad : tone === "good" ? colors.good : colors.accent;
  const summary = noticeSummary(current);
  const close = () => setAnnounced((ids) => [...ids, current.id]);

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { bottom: insets.bottom + 68 }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <TouchableOpacity
        style={[styles.toast, { backgroundColor: colors.bg, borderColor: accent }]}
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
        {summary ? <Text style={[styles.summary, { color: colors.muted }]} numberOfLines={2}>{summary}</Text> : null}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  // The wrapper takes no touches outside the card, so a toast never blocks the row underneath it.
  wrap: { position: "absolute", left: 0, right: 0, alignItems: "center", paddingHorizontal: 12 },
  toast: {
    width: "100%",
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
    elevation: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.22,
    shadowRadius: 6,
  },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  title: { flex: 1, fontSize: 14, fontWeight: "700" },
  time: { fontSize: 11, fontWeight: "700" },
  summary: { fontSize: 12, lineHeight: 17, marginTop: 3 },
});
