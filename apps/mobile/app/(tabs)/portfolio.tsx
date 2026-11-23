/**
 * Portfolio Screen - the owner's ICICI book, split the way the web splits it
 *
 * Positions are what is being traded now; Holdings are the delivery stock sitting in the account.
 * Both come out of the same account response, so the two tabs can never be looking at different
 * moments, and both read prod's own state words rather than guessing why a list is empty.
 */

import React, { useMemo, useState } from "react";
import { View, Text, FlatList, RefreshControl, StyleSheet, ActivityIndicator, TouchableOpacity } from "react-native";
import { useOrderTicket } from "@nraialgo/shared/hooks";
import { useTheme } from "@/components/ThemeProvider";
import { BuySheet } from "@/components/BuySheet";
import { formatRupees, formatPercent, formatNumber } from "@nraialgo/shared/utils";
import { Ionicons } from "@expo/vector-icons";
import { useApi } from "@/hooks/useApi";
import { useAuthStore } from "@nraialgo/shared/stores";
import {
  derivativeCodes,
  iciciAccountSection,
  iciciHoldings,
  markHoldings,
  markPositions,
  streamIdFor,
  useQuoteFeed,
  type OpenPosition,
} from "@nraialgo/shared/api";

const TABS = [
  { id: "positions", label: "Positions" },
  { id: "holdings", label: "Holdings" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function PortfolioScreen() {
  const { useOpenPositions, useIciciAccount } = useApi();
  const { resolvedTheme } = useTheme();
  const [tab, setTab] = useState<TabId>("positions");

  const { data, isLoading, isError, refetch } = useOpenPositions();
  // The account response itself is read for its state: which section the broker could fill, which it
  // could not, and the reason it gave. The rows still come from the mapped hooks.
  const { data: account, refetch: refetchAccount } = useIciciAccount();

  const savedPositions = useMemo(() => data ?? [], [data]);
  const savedHoldings = useMemo(() => iciciHoldings(account ?? {}), [account]);
  const positionsState = iciciAccountSection(account, "portfoliopositions");
  const holdingsState = iciciAccountSection(account, "portfolioholdings");

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

  const ticking = positions.some((row) => row.live) || holdings.some((row) => row.live);
  const isConnected = feed.connected;

  const colors = resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#64748b", border: "#334155", live: "#22c55e", accent: "#38bdf8", brand: { "600": "#38bdf8" } }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", live: "#16a34a", accent: "#0284c7", brand: { "600": "#0284c7" } };

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
    title: { fontSize: 24, fontWeight: "700", color: colors.text },
    subtitle: { fontSize: 14, color: colors.muted, marginTop: 4 },
    liveIndicator: { flexDirection: "row", alignItems: "center", gap: 6 },
    liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.live },
    liveText: { fontSize: 12, fontWeight: "600", color: colors.live },
    tabContainer: { flexDirection: "row", backgroundColor: colors.card, marginHorizontal: 16, marginTop: 12, borderRadius: 8, padding: 4, borderWidth: 1, borderColor: colors.border },
    tabButton: { flex: 1, paddingVertical: 10, alignItems: "center", borderRadius: 6 },
    tabButtonActive: { backgroundColor: colors.accent },
    tabLabel: { fontSize: 12, fontWeight: "600", color: colors.muted },
    tabLabelActive: { color: "#ffffff" },
    listContent: { padding: 16, paddingBottom: 100 },
    card: {
      backgroundColor: colors.card,
      borderRadius: 12,
      padding: 16,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: colors.border,
    },
    row: { flexDirection: "row", justifyContent: "space-between" },
    symbol: { fontSize: 16, fontWeight: "600", color: colors.text },
    holdingName: { fontSize: 12, color: colors.muted, marginTop: 2 },
    side: { fontSize: 12, fontWeight: "600", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 },
    sideBuy: { backgroundColor: "rgba(34,197,94,0.15)", color: "#22c55e" },
    sideSell: { backgroundColor: "rgba(239,68,68,0.15)", color: "#ef4444" },
    sideOther: { backgroundColor: "rgba(100,116,139,0.2)", color: colors.muted },
    detailRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
    detailLabel: { fontSize: 13, color: colors.muted },
    detailValue: { fontSize: 13, fontWeight: "500", color: colors.text },
    // A price that arrived on the stream is drawn differently from one the broker merely saved, so the
    // trader never has to guess whether the number in front of them is the market or a snapshot.
    streamValue: { color: colors.accent },
    dimValue: { fontSize: 13, fontWeight: "500", color: colors.muted },
    pnlPositive: { color: "#22c55e" },
    pnlNegative: { color: "#ef4444" },
    empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40 },
    emptyText: { fontSize: 16, color: colors.muted, textAlign: "center" },
    loading: { flex: 1, alignItems: "center", justifyContent: "center" },
    totalRow: { flexDirection: "row", justifyContent: "space-between", paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border, marginTop: 8 },
    staleLine: { fontSize: 12, color: colors.muted, paddingHorizontal: 16, paddingTop: 10 },
    retry: { marginTop: 16, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8, backgroundColor: colors.accent },
    retryText: { fontSize: 14, fontWeight: "600", color: "#ffffff" },
    fab: { position: "absolute", bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: colors.brand?.["600"] || "#0284c7", alignItems: "center", justifyContent: "center", elevation: 4, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4 },
  });

  const priced = positions.filter(p => p.unrealizedPnl !== null);
  const totalUnrealized = priced.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);
  const unpricedCount = positions.length - priced.length;

  const valuedHoldings = holdings.filter(holding => holding.marketValue !== null);
  const totalMarketValue = valuedHoldings.reduce((sum, holding) => sum + (holding.marketValue ?? 0), 0);
  const pnlHoldings = holdings.filter(holding => holding.unrealizedPnl !== null);
  const totalHoldingPnl = pnlHoldings.reduce((sum, holding) => sum + (holding.unrealizedPnl ?? 0), 0);
  const unvaluedCount = holdings.length - valuedHoldings.length;

  // Prod's own words for a list it could not refresh. They label the rows; they never replace them.
  // A degraded section still carries the broker's last confirmed book, and a screen that hid those
  // rows would answer "where is my book?" with a blank while the same rows sit in the response.
  // The notice is therefore only for a list that has nothing in it, and the banner is for everything
  // the server did not call ready.
  const blocked = (state: { kind: string }) => state.kind === "cold" || state.kind === "degraded" || state.kind === "unavailable";

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

  const banner = (state: { kind: string; reason: string | null }, noun: string) => (
    <Text style={styles.staleLine}>
      {state.reason ?? `${noun} shows the broker's last saved values.`}
      {account?.asOf ? ` Saved ${new Date(account.asOf).toLocaleString()}.` : ""}
    </Text>
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

  const renderPositions = () => {
    if (isLoading && !account) {
      return (
        <View style={[styles.container, styles.loading]}>
          <ActivityIndicator size="large" color={resolvedTheme === "dark" ? "#38bdf8" : "#0284c7"} />
        </View>
      );
    }

    if (isError) {
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
        <Text style={[styles.subtitle, { paddingHorizontal: 16, paddingTop: 12 }]}>
          {positions.length} position{positions.length !== 1 ? "s" : ""} • Unrealized P&L: {formatRupees(totalUnrealized, { signed: true })}
          {unpricedCount > 0 ? ` (${unpricedCount} without a broker cost, excluded)` : ""}
        </Text>
        {positionsState.kind === "ready" ? null : banner(positionsState, "Positions")}
        <FlatList
          data={positions}
          keyExtractor={(item, index) => `${item.broker}:${item.account}:${item.symbol}:${item.expiry ?? ""}:${index}`}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.card}
              onPress={() => handleOpenTicket(item)}
              activeOpacity={0.8}
            >
              <View style={styles.row}>
                <Text style={styles.symbol}>{item.symbol}</Text>
                <Text style={[styles.side, item.side === "BUY" ? styles.sideBuy : item.side === "SELL" ? styles.sideSell : styles.sideOther]}>
                  {item.side}
                </Text>
              </View>

              <View style={styles.detailRow}>
                <View>
                  <Text style={styles.detailLabel}>Qty</Text>
                  <Text style={styles.detailValue}>{formatNumber(item.quantity)}</Text>
                </View>
                <View>
                  <Text style={styles.detailLabel}>Entry</Text>
                  <Text style={item.entryPrice === null ? styles.dimValue : styles.detailValue}>
                    {item.entryPrice === null ? "No broker cost" : formatRupees(item.entryPrice)}
                  </Text>
                </View>
                <View>
                  <Text style={styles.detailLabel}>Current price</Text>
                  <Text style={[styles.detailValue, item.markPrice === null ? styles.dimValue : item.live ? styles.streamValue : undefined]}>
                    {item.markPrice === null ? "No broker price" : formatRupees(item.markPrice)}
                  </Text>
                </View>
              </View>

              <View style={styles.detailRow}>
                <View>
                  <Text style={styles.detailLabel}>Unrealized</Text>
                  <Text style={[styles.detailValue, item.unrealizedPnl === null ? styles.dimValue : item.unrealizedPnl >= 0 ? styles.pnlPositive : styles.pnlNegative]}>
                    {item.unrealizedPnl === null ? "No broker P&L" : formatRupees(item.unrealizedPnl, { signed: true })}
                  </Text>
                </View>
                <View>
                  <Text style={styles.detailLabel}>P&L %</Text>
                  <Text style={[styles.detailValue, item.unrealizedPnl === null ? styles.dimValue : item.unrealizedPnl >= 0 ? styles.pnlPositive : styles.pnlNegative]}>
                    {item.unrealizedPnl === null || item.entryPrice === null || item.quantity === 0
                      ? "No broker P&L"
                      : formatPercent((item.unrealizedPnl / (item.entryPrice * item.quantity)) * 100)}
                  </Text>
                </View>
                <View>
                  <Text style={styles.detailLabel}>Broker</Text>
                  <Text style={styles.detailValue}>{item.broker} • {item.account}</Text>
                </View>
              </View>
            </TouchableOpacity>
          )}
          refreshControl={
            <RefreshControl refreshing={false} onRefresh={() => { refetch(); refetchAccount(); }} colors={[resolvedTheme === "dark" ? "#38bdf8" : "#0284c7"]} />
          }
          contentContainerStyle={styles.listContent}
          ListFooterComponent={
            <View style={styles.totalRow}>
              <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>Total Unrealized P&L</Text>
              <Text style={{ fontSize: 14, fontWeight: "600", color: totalUnrealized >= 0 ? "#22c55e" : "#ef4444" }}>
                {formatRupees(totalUnrealized, { signed: true })}
              </Text>
            </View>
          }
        />
      </>
    );
  };

  const renderHoldings = () => {
    if (isLoading && !account) {
      return (
        <View style={[styles.container, styles.loading]}>
          <ActivityIndicator size="large" color={resolvedTheme === "dark" ? "#38bdf8" : "#0284c7"} />
        </View>
      );
    }

    if (isError) {
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
        <Text style={[styles.subtitle, { paddingHorizontal: 16, paddingTop: 12 }]}>
          {holdings.length} holding{holdings.length !== 1 ? "s" : ""} • Market value: {formatRupees(totalMarketValue)} • Unrealized P&L: {formatRupees(totalHoldingPnl, { signed: true })}
          {unvaluedCount > 0 ? ` (${unvaluedCount} without a broker price, excluded)` : ""}
        </Text>
        {holdingsState.kind === "ready" ? null : banner(holdingsState, "Holdings")}
        <FlatList
          data={holdings}
          keyExtractor={(item, index) => `${item.accountId}:${item.exchange}:${item.symbol}:${index}`}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.row}>
                <View style={{ flex: 1, paddingRight: 8 }}>
                  <Text style={styles.symbol}>{item.symbol}</Text>
                  {item.name ? <Text style={styles.holdingName} numberOfLines={1}>{item.name}</Text> : null}
                </View>
                <Text style={[styles.detailValue, item.changePercent === null ? styles.dimValue : item.changePercent >= 0 ? styles.pnlPositive : styles.pnlNegative]}>
                  {item.changePercent === null ? "No broker change" : formatPercent(item.changePercent)}
                </Text>
              </View>

              <View style={styles.detailRow}>
                <View>
                  <Text style={styles.detailLabel}>Quantity</Text>
                  <Text style={styles.detailValue}>{formatNumber(item.quantity)}</Text>
                </View>
                <View>
                  <Text style={styles.detailLabel}>Average price</Text>
                  <Text style={item.averagePrice === null ? styles.dimValue : styles.detailValue}>
                    {item.averagePrice === null ? "No broker cost" : formatRupees(item.averagePrice)}
                  </Text>
                </View>
                <View>
                  <Text style={styles.detailLabel}>Current price</Text>
                  <Text style={[styles.detailValue, item.currentPrice === null ? styles.dimValue : item.live ? styles.streamValue : undefined]}>
                    {item.currentPrice === null ? "No broker price" : formatRupees(item.currentPrice)}
                  </Text>
                </View>
              </View>

              <View style={styles.detailRow}>
                <View>
                  <Text style={styles.detailLabel}>Market value</Text>
                  <Text style={item.marketValue === null ? styles.dimValue : styles.detailValue}>
                    {item.marketValue === null ? "No broker price" : formatRupees(item.marketValue)}
                  </Text>
                </View>
                <View>
                  <Text style={styles.detailLabel}>Unrealized P&L</Text>
                  <Text style={[styles.detailValue, item.unrealizedPnl === null ? styles.dimValue : item.unrealizedPnl >= 0 ? styles.pnlPositive : styles.pnlNegative]}>
                    {item.unrealizedPnl === null ? "No broker P&L" : formatRupees(item.unrealizedPnl, { signed: true })}
                  </Text>
                </View>
                <View>
                  <Text style={styles.detailLabel}>Today's change</Text>
                  <Text style={[styles.detailValue, item.todayPnl === null ? styles.dimValue : item.todayPnl >= 0 ? styles.pnlPositive : styles.pnlNegative]}>
                    {item.todayPnl === null ? "No broker price" : formatRupees(item.todayPnl, { signed: true })}
                  </Text>
                </View>
              </View>
            </View>
          )}
          refreshControl={
            <RefreshControl refreshing={false} onRefresh={() => { refetch(); refetchAccount(); }} colors={[resolvedTheme === "dark" ? "#38bdf8" : "#0284c7"]} />
          }
          contentContainerStyle={styles.listContent}
          ListFooterComponent={
            <View style={styles.totalRow}>
              <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>Total Unrealized P&L</Text>
              <Text style={{ fontSize: 14, fontWeight: "600", color: totalHoldingPnl >= 0 ? "#22c55e" : "#ef4444" }}>
                {formatRupees(totalHoldingPnl, { signed: true })}
              </Text>
            </View>
          }
        />
      </>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Portfolio</Text>
        <View style={styles.liveIndicator}>
          <View style={[styles.liveDot, { backgroundColor: ticking ? colors.live : colors.muted }]} />
          <Text style={[styles.liveText, { color: ticking ? colors.live : colors.muted }]}>
            {ticking ? "LIVE" : !authenticated ? "SIGN IN" : isConnected ? "NO TICKS" : "CONNECTING"}
          </Text>
        </View>
      </View>

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
