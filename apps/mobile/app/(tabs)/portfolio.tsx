/**
 * Portfolio Screen - the owner's ICICI book, split the way the web splits it and set as a table
 *
 * Positions are what is being traded now; Holdings are the delivery stock sitting in the account.
 * Both come out of the same account response, so the two tabs can never be looking at different
 * moments, and both read prod's own state words rather than guessing why a list is empty.
 *
 * Each tab is one row per holding instead of a card, because a card showed three positions and the
 * book has dozens. Every figure the cards carried is still on the row - the account it belongs to and
 * the day's percentage moved into the line under the numbers they describe - and a tap on a column
 * heading puts the largest or the worst of that figure at the top.
 *
 * The sums of the book sit above the rows rather than below them, so the trader reads the account's
 * P&L before scrolling. Both are followed by the row counts that produced them: a figure that adds
 * only the rows carrying one would otherwise read as the whole book.
 */

import React, { useEffect, useMemo, useState } from "react";
import { View, Text, RefreshControl, StyleSheet, ActivityIndicator, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { useScreenFocused } from "@/hooks/useScreenFocused";
import { useOrderTicket } from "@nraialgo/shared/hooks";
import { useTheme } from "@/components/ThemeProvider";
import { BuySheet } from "@/components/BuySheet";
import { SortableTable } from "@/components/SortableTable";
import { formatPercent, formatNumber } from "@nraialgo/shared/utils";
import { Ionicons } from "@expo/vector-icons";
import { useApi } from "@/hooks/useApi";
import { useLastKnown } from "@/hooks/useLastKnown";
import { useQuoteMemory } from "@/hooks/useQuoteMemory";
import { useAuthStore } from "@nraialgo/shared/stores";
import {
  derivativeCodes,
  iciciAccountSection,
  iciciHoldings,
  LAST_KNOWN,
  markHoldings,
  markPositions,
  nextSort,
  queryKeys,
  sortRows,
  streamIdFor,
  tickEntries,
  useQuoteFeed,
  type Holding,
  type Marked,
  type MarkedPosition,
  type OpenPosition,
  type QuoteEntry,
  type SortColumn,
  type SortState,
} from "@nraialgo/shared/api";

const TABS = [
  { id: "positions", label: "Positions" },
  { id: "holdings", label: "Holdings" },
] as const;

type TabId = (typeof TABS)[number]["id"];
type PositionRow = OpenPosition & MarkedPosition;
type HoldingRow = Holding & Marked;
type BookRow = { unrealizedPnl: number | null; todayPnl: number | null };

/** A price keeps its paise while it is small enough to need them, and drops them once it is a contract's index value. */
function priceText(value: number): string {
  return Math.abs(value) >= 10000 ? formatNumber(value, 0) : formatNumber(value, 2);
}

/** A sum of rupees in a narrow column, in the lakhs and crores the owner reads on the web desk. */
function sumText(value: number): string {
  const magnitude = Math.abs(value);
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  if (magnitude >= 1e7) return `${sign}${formatNumber(magnitude / 1e7, 2)}Cr`;
  if (magnitude >= 1e5) return `${sign}${formatNumber(magnitude / 1e5, 2)}L`;
  return `${sign}${formatNumber(magnitude, magnitude >= 1000 ? 0 : 2)}`;
}

/**
 * The two sums the book is read for, with the row counts that produced them.
 *
 * A row whose figure the broker never named is skipped instead of counted as zero, so the counts are printed
 * beside the numbers: a total built from 24 rows is a different claim than one that reads as the whole book.
 */
function totals(rows: readonly BookRow[]) {
  const priced = rows.filter((row) => row.unrealizedPnl !== null);
  const daily = rows.filter((row) => row.todayPnl !== null);
  return {
    pnl: priced.reduce((sum, row) => sum + (row.unrealizedPnl ?? 0), 0),
    day: daily.reduce((sum, row) => sum + (row.todayPnl ?? 0), 0),
    pnlRows: priced.length,
    dayRows: daily.length,
    rows: rows.length,
  };
}

const pnlPercent = (row: PositionRow): number | null =>
  row.unrealizedPnl === null || row.entryPrice === null || row.quantity === 0
    ? null
    : (row.unrealizedPnl / (row.entryPrice * row.quantity)) * 100;

const POSITION_COLUMNS: SortColumn<PositionRow>[] = [
  { key: "symbol", label: "Symbol", width: 84, value: (row) => row.symbol },
  { key: "side", label: "Side", width: 44, value: (row) => row.side },
  { key: "quantity", label: "Qty", width: 40, numeric: true, value: (row) => row.quantity },
  { key: "entry", label: "Entry ₹", width: 58, numeric: true, value: (row) => row.entryPrice },
  { key: "current", label: "Current price ₹", width: 62, numeric: true, value: (row) => row.markPrice },
  { key: "unrealized", label: "P&L ₹", width: 54, numeric: true, value: (row) => row.unrealizedPnl },
  { key: "today", label: "Today ₹", width: 50, numeric: true, value: (row) => row.todayPnl },
  { key: "pnlPercent", label: "P&L %", width: 52, numeric: true, value: pnlPercent },
];

const HOLDING_COLUMNS: SortColumn<HoldingRow>[] = [
  { key: "symbol", label: "Symbol", width: 84, value: (row) => row.symbol },
  { key: "quantity", label: "Qty", width: 40, numeric: true, value: (row) => row.quantity },
  { key: "average", label: "Average ₹", width: 58, numeric: true, value: (row) => row.averagePrice },
  { key: "current", label: "Current price ₹", width: 62, numeric: true, value: (row) => row.currentPrice },
  { key: "value", label: "Value ₹", width: 54, numeric: true, value: (row) => row.marketValue },
  { key: "unrealized", label: "P&L ₹", width: 54, numeric: true, value: (row) => row.unrealizedPnl },
  { key: "today", label: "Today ₹", width: 50, numeric: true, value: (row) => row.todayPnl },
];

export default function PortfolioScreen() {
  const { useOpenPositions, useIciciAccount } = useApi();
  const { resolvedTheme } = useTheme();
  const router = useRouter();
  const [tab, setTab] = useState<TabId>("positions");

  // useIciciAccount() polls /v1/broker-auth/icici/account every 5s and seeds queryKeys.positions.open(),
  // so useOpenPositions() does not need to fire a second identical 5s poll on the same screen.
  const { data, isLoading, isError, refetch } = useOpenPositions({ refetchInterval: false });
  // The account response itself is read for its state: which section the broker could fill, which it
  // could not, and the reason it gave. The rows still come from the mapped hooks.
  // A hidden tab stops polling (see useScreenFocused); the account SSE keeps the cache current.
  const focused = useScreenFocused();
  const { data: account, refetch: refetchAccount } = useIciciAccount({ queryKey: queryKeys.brokerAccount.icici(), subscribed: focused, gcTime: Infinity });

  const prodPositions = useMemo(() => data ?? [], [data]);
  const prodHoldings = useMemo(() => iciciHoldings(account ?? {}), [account]);
  const positionsState = iciciAccountSection(account, "portfoliopositions");
  const holdingsState = iciciAccountSection(account, "portfolioholdings");

  // Prod's own words for a list it could not refresh. They label the rows; they never replace them.
  // A degraded section still carries the broker's last confirmed book, and a screen that hid those
  // rows would answer "where is my book?" with a blank while the same rows sit in the response.
  // The notice is therefore only for a list that has nothing in it, and the banner is for everything
  // the server did not call ready.
  const blocked = (state: { kind: string }) => state.kind === "cold" || state.kind === "degraded" || state.kind === "unavailable";
  // A degraded, stale or ready reply is an answer even when it carries no rows: the broker proved the
  // book is flat, so the phone must not paint a remembered position over that proof. Only a reply that
  // never named this list leaves the phone free to fall back on what it last saw.
  const answered = (state: { kind: string }) => !blocked(state) || state.kind === "degraded";

  // The book the phone last painted, kept so a read that fails outright cannot blank the owner's positions.
  const positionCopy = useLastKnown(LAST_KNOWN.positions, prodPositions, answered(positionsState));
  const holdingCopy = useLastKnown(LAST_KNOWN.holdings, prodHoldings, answered(holdingsState));
  const savedPositions = positionCopy.rows;
  const savedHoldings = holdingCopy.rows;

  // Use unified order ticket hook
  const ticket = useOrderTicket();
  const {
    open: openOrderTicket,
    fromPosition,
  } = ticket;

  // Tick by tick, on both lists. The stream subscribes by canonical contract ids, and a derivative's id needs
  // the underlying name behind ICICI's own contract code - RELIND is RELIANCE, and a prefix cannot decide
  // that - so the codes are resolved from prod's derivatives master first. An id that cannot be built
  // completely is never sent, because one subscription the server cannot parse closes the socket for the
  // whole app. Only a price the server published as fresh marks a row.
  const { isAuthenticated, user, accessToken } = useAuthStore();
  const authenticated = isAuthenticated || !!user || !!accessToken;
  const { useContractUnderlyings } = useApi();
  const codes = useMemo(() => derivativeCodes(savedPositions), [savedPositions]);
  const { data: resolved } = useContractUnderlyings(codes);
  const underlyings = useMemo(() => resolved ?? {}, [resolved]);
  const instruments = useMemo(() => [...new Set([
    ...savedPositions.map((row) => streamIdFor(row, underlyings[row.symbol.trim().toUpperCase()] ?? null)),
    ...savedHoldings.map((row) => streamIdFor({
      exchange: row.exchange, symbol: row.symbol, product: "CASH", expiry: null, strike: null, right: null,
    })),
  ].filter((id): id is string => !!id))].sort(), [savedPositions, savedHoldings, underlyings]);
  const feed = useQuoteFeed(instruments, authenticated && instruments.length > 0);
  const positions = useMemo(() => markPositions(savedPositions, feed.quotes, underlyings), [savedPositions, feed.quotes, underlyings]);
  const holdings = useMemo(() => markHoldings(savedHoldings, feed.quotes), [savedHoldings, feed.quotes]);

  // The book is the one place the broker names a price per contract identity, so it seeds the phone's quote
  // memory: the symbol the trader holds is often the row their watchlist cannot price. Nothing here is painted
  // back onto these rows — the broker's own mark and P&L are what this screen is for.
  const quotes = useQuoteMemory();
  useEffect(() => {
    const priced: QuoteEntry[] = [];
    for (const row of positions) {
      const id = streamIdFor(row, underlyings[row.symbol.trim().toUpperCase()] ?? null);
      const price = Number(row.markPrice);
      if (id && Number.isFinite(price) && price > 0) priced.push({ id, price, at: null });
    }
    for (const row of holdings) {
      const id = streamIdFor({ exchange: row.exchange, symbol: row.symbol, product: "CASH", expiry: null, strike: null, right: null });
      const price = Number(row.currentPrice);
      if (id && Number.isFinite(price) && price > 0) priced.push({ id, price, at: null });
    }
    quotes.remember([...tickEntries(feed.quotes), ...priced]);
  }, [quotes, positions, holdings, feed.quotes]);

  // One tap on a heading sorts by that column, the next tap turns it around. The two tabs keep their own
  // order, so reading a sorted book never reorders the other one behind the trader's back.
  const [positionSort, setPositionSort] = useState<SortState | null>(null);
  const [holdingSort, setHoldingSort] = useState<SortState | null>(null);
  const positionRows = useMemo(() => sortRows(positions, POSITION_COLUMNS, positionSort), [positions, positionSort]);
  const holdingRows = useMemo(() => sortRows(holdings, HOLDING_COLUMNS, holdingSort), [holdings, holdingSort]);

  const colors = useMemo(() => resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#64748b", border: "#334155", live: "#22c55e", accent: "#38bdf8", brand: { "600": "#38bdf8" } }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", live: "#16a34a", accent: "#0284c7", brand: { "600": "#0284c7" } }, [resolvedTheme]);
  const theme = useMemo(() => ({ card: colors.card, text: colors.text, muted: colors.muted, border: colors.border, accent: colors.accent }), [colors]);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    subtitle: { fontSize: 13, color: colors.muted, paddingHorizontal: 12, paddingTop: 10 },
    tabContainer: { flexDirection: "row", backgroundColor: colors.card, marginHorizontal: 16, marginTop: 16, borderRadius: 8, padding: 4, borderWidth: 1, borderColor: colors.border },
    tabButton: { flex: 1, paddingVertical: 10, alignItems: "center", borderRadius: 6 },
    tabButtonActive: { backgroundColor: colors.accent },
    tabLabel: { fontSize: 12, fontWeight: "600", color: colors.muted },
    tabLabelActive: { color: "#ffffff" },
    // A price that arrived on the stream is drawn differently from one the broker merely saved, so the
    // trader never has to guess whether the number in front of them is the market or a snapshot.
    streamValue: { color: colors.accent },
    dimValue: { color: colors.muted, fontSize: 11 },
    buyValue: { color: "#22c55e" },
    sellValue: { color: "#ef4444" },
    pnlPositive: { color: "#22c55e" },
    pnlNegative: { color: "#ef4444" },
    empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40 },
    emptyText: { fontSize: 16, color: colors.muted, textAlign: "center" },
    savedLine: { paddingHorizontal: 14, paddingTop: 10, fontSize: 12, fontWeight: "600", color: colors.accent },
    loading: { flex: 1, alignItems: "center", justifyContent: "center" },
    totals: { flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingTop: 10 },
    totalsFigure: {
      flex: 1, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
      borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8,
    },
    totalsLabel: { fontSize: 11, fontWeight: "600", color: colors.muted },
    totalsValue: { fontSize: 17, fontWeight: "700", marginTop: 2 },
    totalsCoverage: { fontSize: 10, color: colors.muted, marginTop: 2 },
    retry: { marginTop: 16, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8, backgroundColor: colors.accent },
    retryText: { fontSize: 14, fontWeight: "600", color: "#ffffff" },
    fab: { position: "absolute", bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: colors.brand?.["600"] || "#0284c7", alignItems: "center", justifyContent: "center", elevation: 4, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4 },
  }), [colors]);

  const pnlStyle = (value: number | null) =>
    value === null ? styles.dimValue : value >= 0 ? styles.pnlPositive : styles.pnlNegative;

  const positionTotals = totals(positions);
  const holdingTotals = totals(holdings);

  /** The book's two sums, above the rows that make them up. Each names the rows it actually added. */
  const totalsCard = (summary: ReturnType<typeof totals>) => {
    const figures = [
      { label: "Total P&L", noun: "P&L", value: summary.pnl, counted: summary.pnlRows,
        none: "the broker priced none of them" },
      { label: "Today P&L", noun: "day figure", value: summary.day, counted: summary.dayRows,
        none: "no previous close has arrived for them" },
    ];
    return (
      <View style={styles.totals}>
        {figures.map((figure) => (
          <View key={figure.label} style={styles.totalsFigure}>
            <Text style={styles.totalsLabel}>{figure.label}</Text>
            {/* A sum of nothing is not a flat book: 0.00 would be a figure the market never gave. */}
            <Text style={[styles.totalsValue,
              figure.counted === 0 ? styles.dimValue : figure.value >= 0 ? styles.pnlPositive : styles.pnlNegative]}>
              {figure.counted === 0 ? "Not available" : sumText(figure.value)}
            </Text>
            <Text style={styles.totalsCoverage}>
              {figure.counted} of {summary.rows} rows carry a {figure.noun}
              {figure.counted === 0 ? ` · ${figure.none}` : ""}
            </Text>
          </View>
        ))}
      </View>
    );
  };


  // Prod's own words still label a list that has nothing in it, and the phone's own copy still has to say
  // when it is the thing on screen. Neither ever replaces rows that arrived.
  const notice = (state: { kind: string; reason: string | null }, noun: string) => (
    <View style={[styles.empty, { flex: 1 }]}>
      <Text style={styles.emptyText}>
        {state.reason ?? `${noun} could not be read from the broker.`}
      </Text>
      <TouchableOpacity style={styles.retry} onPress={() => { refetch(); refetchAccount(); }}>
        <Text style={styles.retryText}>Tap to try again</Text>
      </TouchableOpacity>
    </View>
  );

  const handleOpenTicket = (position?: OpenPosition) => {
    if (position) {
      fromPosition({
        symbol: position.symbol,
        side: position.side,
        quantity: position.quantity,
        exchange: position.exchange,
        product: position.product,
        entryPrice: position.entryPrice,
      });
    } else {
      openOrderTicket({ side: "BUY" });
    }
  };

  /** A holding opens the stock with the quantity already on it, straight from the broker row the
   *  trader just looked at - the Overview asks the account for nothing of its own. Positions keep
   *  going to the ticket, because closing one is what a press on a position means. */
  const openHolding = (row: Holding) => {
    router.push(
      `/stock?exchange=${encodeURIComponent(row.exchange)}&symbol=${encodeURIComponent(row.symbol)}`
      + `&held=${Math.abs(row.quantity)}&tab=portfolio`,
    );
  };

  const positionCell = (item: PositionRow, column: SortColumn<PositionRow>) => {
    switch (column.key) {
      case "side":
        return { text: item.side, style: item.side === "BUY" ? styles.buyValue : item.side === "SELL" ? styles.sellValue : styles.dimValue };
      case "quantity":
        return { text: formatNumber(item.quantity, 0) };
      case "entry":
        return { text: item.entryPrice === null ? "" : priceText(item.entryPrice), style: item.entryPrice === null ? styles.dimValue : undefined };
      case "current":
        return {
          text: item.markPrice === null ? "" : priceText(item.markPrice),
          style: item.markPrice === null ? styles.dimValue : item.live ? styles.streamValue : undefined,
        };
      case "unrealized":
        return { text: item.unrealizedPnl === null ? "" : sumText(item.unrealizedPnl), style: pnlStyle(item.unrealizedPnl) };
      case "today":
        return { text: item.todayPnl === null ? "" : sumText(item.todayPnl), style: pnlStyle(item.todayPnl) };
      case "pnlPercent": {
        const percent = pnlPercent(item);
        return { text: percent === null ? "" : formatPercent(percent), style: pnlStyle(percent) };
      }
      default: {
        const optionDetails = item.strike && item.expiry
          ? `${item.strike} ${item.right ?? ""} ${item.expiry}`.trim()
          : undefined;
        return { text: item.symbol, sub: optionDetails };
      }
    }
  };

  const holdingCell = (item: HoldingRow, column: SortColumn<HoldingRow>) => {
    switch (column.key) {
      case "symbol":
        return { text: item.symbol, sub: item.name };
      case "quantity":
        return { text: formatNumber(item.quantity, 0) };
      case "average":
        return { text: item.averagePrice === null ? "" : priceText(item.averagePrice), style: item.averagePrice === null ? styles.dimValue : undefined };
      case "current":
        return {
          text: item.currentPrice === null ? "" : priceText(item.currentPrice),
          style: item.currentPrice === null ? styles.dimValue : item.live ? styles.streamValue : undefined,
          sub: item.changePercent === null ? "" : formatPercent(item.changePercent),
          subStyle: pnlStyle(item.changePercent),
        };
      case "value":
        return { text: item.marketValue === null ? "" : sumText(item.marketValue), style: item.marketValue === null ? styles.dimValue : undefined };
      case "unrealized":
        return { text: item.unrealizedPnl === null ? "" : sumText(item.unrealizedPnl), style: pnlStyle(item.unrealizedPnl) };
      case "today":
        return { text: item.todayPnl === null ? "" : sumText(item.todayPnl), style: pnlStyle(item.todayPnl) };
      default:
        return { text: item.symbol };
    }
  };

  /** The one line that says the book on screen is this phone's last read of it, not prod's current one.
   *  It names the minute, because a remembered position without a time on it reads like a live one. */
  const copyLine = (copy: { source: string; line: string | null }) => (
    copy.source === "last-fetched" && copy.line
      ? <Text style={styles.savedLine}>{copy.line}</Text>
      : null
  );

  const renderPositions = () => {
    if (isLoading && !account && savedPositions.length === 0) {
      return (
        <View style={[styles.container, styles.loading]}>
          <ActivityIndicator size="large" color={resolvedTheme === "dark" ? "#38bdf8" : "#0284c7"} />
        </View>
      );
    }

    if (isError && savedPositions.length === 0) {
      return (
        <View style={[styles.container, styles.empty]}>
          <Text style={styles.emptyText}>Failed to load positions. Pull to refresh.</Text>
        </View>
      );
    }

    if (positions.length === 0 && blocked(positionsState)) return notice(positionsState, "Positions");

    if (positions.length === 0) {
      return (
        <View style={[styles.empty, { flex: 1 }]}>
          <Text style={styles.emptyText}>No open positions</Text>
        </View>
      );
    }

    return (
      <>
        {copyLine(positionCopy)}
        {totalsCard(positionTotals)}
        <SortableTable
          rows={positionRows}
          columns={POSITION_COLUMNS}
          sort={positionSort}
          onSort={(column) => setPositionSort(nextSort(column, positionSort))}
          cell={positionCell}
          keyOf={(item, index) => `${item.broker}:${item.account}:${item.symbol}:${item.expiry ?? ""}:${index}`}
          onRowPress={handleOpenTicket}
          theme={theme}
          refreshControl={
            <RefreshControl refreshing={false} onRefresh={() => { refetch(); refetchAccount(); }} colors={[resolvedTheme === "dark" ? "#38bdf8" : "#0284c7"]} />
          }
        />
      </>
    );
  };

  const renderHoldings = () => {
    if (isLoading && !account && savedHoldings.length === 0) {
      return (
        <View style={[styles.container, styles.loading]}>
          <ActivityIndicator size="large" color={resolvedTheme === "dark" ? "#38bdf8" : "#0284c7"} />
        </View>
      );
    }

    if (isError && savedHoldings.length === 0) {
      return (
        <View style={[styles.container, styles.empty]}>
          <Text style={styles.emptyText}>Failed to load holdings. Pull to refresh.</Text>
        </View>
      );
    }

    if (holdings.length === 0 && blocked(holdingsState)) return notice(holdingsState, "Holdings");

    if (holdings.length === 0) {
      return (
        <View style={[styles.empty, { flex: 1 }]}>
          <Text style={styles.emptyText}>No holdings</Text>
        </View>
      );
    }

    return (
      <>
        {copyLine(holdingCopy)}
        {totalsCard(holdingTotals)}
        <SortableTable
          rows={holdingRows}
          columns={HOLDING_COLUMNS}
          sort={holdingSort}
          onSort={(column) => setHoldingSort(nextSort(column, holdingSort))}
          cell={holdingCell}
          keyOf={(item, index) => `${item.accountId}:${item.exchange}:${item.symbol}:${index}`}
          onRowPress={openHolding}
          theme={theme}
          refreshControl={
            <RefreshControl refreshing={false} onRefresh={() => { refetch(); refetchAccount(); }} colors={[resolvedTheme === "dark" ? "#38bdf8" : "#0284c7"]} />
          }
        />
      </>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.tabContainer}>
        {TABS.map((entry) => (
          <TouchableOpacity
            key={entry.id}
            style={[styles.tabButton, tab === entry.id && styles.tabButtonActive]}
            onPress={() => setTab(entry.id)}
          >
            <Text style={[styles.tabLabel, tab === entry.id && styles.tabLabelActive]}>{entry.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === "positions" ? renderPositions() : renderHoldings()}

      {/* Mounted only while a ticket is open, exactly as on the watchlist: the row press below builds a
          ticket from that position, and a sheet nobody renders is a press that answers nothing. */}
      {ticket.visible ? <BuySheet ticket={ticket} /> : null}

      {/* The ticket stays reachable from both tabs, exactly as it was from the single screen. */}
      <TouchableOpacity style={styles.fab} onPress={() => handleOpenTicket()} accessibilityLabel="New order">
        <Ionicons name="add" size={28} color="white" />
      </TouchableOpacity>
    </View>
  );
}
