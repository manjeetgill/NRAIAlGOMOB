/**
 * The index strip, mounted once above the router so it is on every screen.
 *
 * It used to belong to the Watchlist tab, which meant the trader saw where the market was standing only
 * where they happened not to be looking at the market. The cards carry prod's own quote state, so a quiet
 * price says so instead of reading like a live one.
 */

import React, { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { chartFailureReason } from "@nraialgo/shared/api";
import { formatNumber } from "@nraialgo/shared/utils";
import { useTheme } from "@/components/ThemeProvider";
import { useApi } from "@/hooks/useApi";

/** Prod names its quote states in code; the strip says what they mean. */
function statusWord(status: string): string {
  return status === "live" ? "waiting for a price"
    : status === "delayed" ? "delayed price"
    : status === "stale" ? "old price"
    : status === "unavailable" ? "no price"
    : "last close";
}

const signed = (value: number | null) =>
  value === null ? "—" : `${value > 0 ? "+" : ""}${formatNumber(value)}`;

function IndexStrip() {
  const { useIndices } = useApi();
  const { resolvedTheme } = useTheme();
  const { data: strip, error } = useIndices();

  const colors = useMemo(() => resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#64748b", border: "#334155", up: "#22c55e", down: "#ef4444" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", up: "#16a34a", down: "#ef4444" }, [resolvedTheme]);

  // The scroller states its own height because the horizontal scroll view otherwise sized its cross axis
  // from a viewport that is only known after layout, which squeezed the cards and pushed the change line
  // outside its border.
  const styles = useMemo(() => StyleSheet.create({
    row: { paddingTop: 16, backgroundColor: colors.bg, borderBottomWidth: 1, borderBottomColor: colors.border },
    scroll: { height: 48 },
    content: { paddingHorizontal: 6, gap: 8, alignItems: "center" },
    card: {
      backgroundColor: colors.card, borderRadius: 8, borderWidth: 1, borderColor: colors.border,
      paddingVertical: 3, paddingHorizontal: 10, minWidth: 122,
    },
    name: { fontSize: 10, fontWeight: "600", color: colors.muted, lineHeight: 12 },
    price: { fontSize: 13, fontWeight: "700", lineHeight: 16 },
    change: { fontSize: 9, color: colors.muted, lineHeight: 11 },
    note: { height: 48, lineHeight: 48, fontSize: 12, color: colors.muted, paddingHorizontal: 12 },
  }), [colors]);

  const tone = (change: number | null) =>
    change === null ? colors.text : change > 0 ? colors.up : change < 0 ? colors.down : colors.text;

  if (!strip) {
    return (
      <View style={styles.row}>
        <View style={styles.scroll}>
          <Text style={styles.note} numberOfLines={1}>
            {error
              ? chartFailureReason(error, "The index strip could not be read.")
              : "Loading the index strip"}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.row}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.scroll} contentContainerStyle={styles.content}>
        {strip.indices.map(index => (
          <View key={index.name} style={styles.card}>
            <Text style={styles.name}>{index.label}</Text>
            <Text style={[styles.price, { color: tone(index.change) }]}>
              {index.price === null ? "No price" : formatNumber(index.price)}
            </Text>
            {/* Prod's own state belongs on the card whether or not a change came with it: a stale index
                that still carries yesterday's move would otherwise read as a live quote. The absolute
                change steps aside for it, because the card has one short line and the percent is the
                half that fits. */}
            <Text style={styles.change} numberOfLines={1}>
              {index.change === null
                ? statusWord(index.status)
                : index.status === "live"
                  ? `${signed(index.change)} (${signed(index.changePct)}%)`
                  : `${statusWord(index.status)} · ${signed(index.changePct)}%`}
            </Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

export default React.memo(IndexStrip);
