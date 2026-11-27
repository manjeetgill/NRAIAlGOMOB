/**
 * The notices themselves, at the top of the Orders tab.
 *
 * The badge on the tab and the line above every screen both point here, so this is where a trader lands to
 * read what happened. The rows are the server's own titles and summaries, in the server's own order (unread
 * first, then newest) — the same list the web desk shows from the same route, so the two can never disagree.
 *
 * Three are listed before a "show them all" line, because this section sits on top of the order book and a
 * session of fills should not push the actual orders off the screen.
 */

import React, { useMemo, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { noticeSummary, noticeTitle, unreadNotices, type OrderNotice } from "@nraialgo/shared/api";
import { formatISTTime } from "@nraialgo/shared/utils";
import { useApi } from "@/hooks/useApi";
import { useTheme } from "@/components/ThemeProvider";

const PREVIEW_ROWS = 3;

export default function OrderNoticeList() {
  const { resolvedTheme } = useTheme();
  const { useOrderInbox, useOrderNoticeRead } = useApi();
  const inbox = useOrderInbox();
  const markRead = useOrderNoticeRead();
  const [expanded, setExpanded] = useState(false);

  const colors = useMemo(() => (resolvedTheme === "dark"
    ? { card: "#1e293b", text: "#f1f5f9", muted: "#64748b", border: "#334155", accent: "#38bdf8", unread: "#38bdf8" }
    : { card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", accent: "#0284c7", unread: "#0284c7" }), [resolvedTheme]);

  const rows = inbox.data ?? [];
  if (rows.length === 0) return null;

  const listed = expanded ? rows : rows.slice(0, PREVIEW_ROWS);
  const pending = unreadNotices(rows);

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={[styles.heading, { color: colors.muted }]}>{`Order notices (${rows.length})`}</Text>
        {pending.length > 0 ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`Mark ${pending.length} order notices read`}
            onPress={() => pending.forEach((row) => markRead.mutate(row.id))}
          >
            <Text style={[styles.markAll, { color: colors.accent }]}>{`Mark all read (${pending.length})`}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {listed.map((row) => (
        <NoticeRow key={row.id} row={row} colors={colors} onPress={() => markRead.mutate(row.id)} />
      ))}
      {rows.length > PREVIEW_ROWS ? (
        <TouchableOpacity
          style={[styles.more, { borderColor: colors.border }]}
          accessibilityRole="button"
          onPress={() => setExpanded((open) => !open)}
        >
          <Text style={[styles.moreText, { color: colors.accent }]}>
            {expanded ? "Show fewer" : `Show all ${rows.length} notices`}
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function NoticeRow({ row, colors, onPress }: { row: OrderNotice; colors: Record<string, string>; onPress: () => void }) {
  const unread = !row.read_at;
  const summary = noticeSummary(row);
  return (
    <TouchableOpacity
      style={[styles.row, { backgroundColor: colors.card, borderColor: unread ? colors.unread : colors.border }]}
      accessibilityRole="button"
      accessibilityLabel={`${noticeTitle(row)}${unread ? ", unread" : ""}`}
      onPress={unread ? onPress : undefined}
    >
      <View style={styles.rowHead}>
        <Text style={[styles.rowTitle, { color: colors.text }]}>{noticeTitle(row)}</Text>
        <Text style={[styles.rowTime, { color: colors.muted }]}>{formatISTTime(row.occurred_at)}</Text>
      </View>
      {summary ? <Text style={[styles.rowSummary, { color: colors.muted }]}>{summary}</Text> : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 12 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  heading: { fontSize: 11, fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase" },
  markAll: { fontSize: 12, fontWeight: "600" },
  row: { borderRadius: 10, borderWidth: 1, padding: 12, marginBottom: 8 },
  rowHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  rowTitle: { flex: 1, fontSize: 13.5, fontWeight: "700" },
  rowTime: { fontSize: 11 },
  rowSummary: { fontSize: 12, lineHeight: 17, marginTop: 4 },
  more: { borderTopWidth: 1, paddingVertical: 10, alignItems: "center" },
  moreText: { fontSize: 12.5, fontWeight: "600" },
});
