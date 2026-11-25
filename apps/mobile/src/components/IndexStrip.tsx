/**
 * The index strip, mounted once above the router so it is on every screen.
 *
 * It used to belong to the Watchlist tab, which meant the trader saw where the market was standing only
 * where they happened not to be looking at the market. The cards carry prod's own quote state, so a quiet
 * price says so instead of reading like a live one.
 */

import React, { useEffect, useMemo, useRef } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import {
  LAST_KNOWN,
  chartFailureReason,
  indexStreamIds,
  streamId,
  tickEntries,
  useQuoteFeed,
  type IndexQuote,
  type QuoteEntry,
} from "@nraialgo/shared/api";
import { formatNumber } from "@nraialgo/shared/utils";
import { useTheme } from "@/components/ThemeProvider";
import { useApi } from "@/hooks/useApi";
import { useLastKnown } from "@/hooks/useLastKnown";
import { useQuoteMemory } from "@/hooks/useQuoteMemory";

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
  const streamedIndices = useRef<readonly string[] | null>(null);
  const { data: rawStrip, error } = useIndices(undefined, () => streamedIndices.current);

  // A strip is the app's only market-wide read, and prod can fail it while the trader is on any screen.
  // The cards the phone last saw stay on the bar in that case, labelled, instead of the row going blank.
  const copy = useLastKnown(LAST_KNOWN.indexStrip, rawStrip?.indices ?? [], !!rawStrip);
  const indexIds = useMemo(
    () => copy.rows.map((idx) => streamId(idx.name)).filter((id): id is string => !!id),
    [copy.rows],
  );
  const feed = useQuoteFeed(indexIds, indexIds.length > 0);
  // An index the socket cannot name keeps the strip on its normal REST read.
  useEffect(() => {
    streamedIndices.current = indexStreamIds(rawStrip?.indices);
  }, [rawStrip]);
  const strip = useMemo(() => {
    if (copy.rows.length === 0) return null;
    // A remembered card is never redrawn as if prod still called its price current, so it takes the one
    // state word that is true for it whatever the saved status said. A tick that arrives still lifts it.
    const base: IndexQuote[] = copy.source === "last-fetched"
      ? copy.rows.map((idx) => ({ ...idx, status: "stale" }))
      : copy.rows;
    if (!feed.quotes.length) return base;
    const byId = new Map(feed.quotes.map((q) => [q.id, q]));
    return base.map((idx) => {
      const id = streamId(idx.name);
      const tick = id ? byId.get(id) : undefined;
      if (!tick || !tick.fresh || !(tick.price > 0)) return idx;
      const prev = tick.previousClose ?? (idx.price !== null && idx.change !== null ? idx.price - idx.change : null);
      const change = prev && prev > 0 ? tick.price - prev : idx.change;
      const changePct = prev && prev > 0 && change !== null ? (change / prev) * 100 : idx.changePct;
      return { ...idx, price: tick.price, change, changePct, status: "live" };
    });
  }, [copy.rows, copy.source, feed.quotes]);

  // A strip is the one read that prices every index at once, by the same canonical ids the ladder's spot and
  // the Overview ask the stream about, so what it shows is worth keeping: a screen that later finds prod has
  // nothing for that name has a number here, with the minute it was seen.
  const quotes = useQuoteMemory();
  useEffect(() => {
    const entries: QuoteEntry[] = tickEntries(feed.quotes);
    for (const idx of strip ?? []) {
      const id = streamId(idx.name);
      if (id && idx.price !== null && idx.price > 0) entries.push({ id, price: idx.price, at: idx.at });
    }
    quotes.remember(entries);
  }, [quotes, strip, feed.quotes]);

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
    age: { fontSize: 10, lineHeight: 14, color: colors.text, paddingHorizontal: 12, paddingBottom: 4 },
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
        {strip.map(index => (
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
      {/* Only the phone's own copy needs the minute it came from; prod's cards carry prod's state words. */}
      {copy.line ? <Text style={styles.age}>{copy.line}</Text> : null}
    </View>
  );
}

export default React.memo(IndexStrip);
