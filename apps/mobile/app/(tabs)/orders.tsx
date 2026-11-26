/**
 * Orders Screen - Live broker orders from ICICI
 *
 * Fetches orders directly from the broker account, so every order in the account
 * appears here — whether placed from this app or from the broker's own app.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useScreenFocused } from "@/hooks/useScreenFocused";
import { View, Text, FlatList, StyleSheet, ActivityIndicator, TouchableOpacity, RefreshControl } from "react-native";
import { useTheme } from "@/components/ThemeProvider";
import { formatRupees, formatNumber } from "@nraialgo/shared/utils";
import { useApi } from "@/hooks/useApi";
import { iciciAccountSection, iciciOrders, queryKeys, type BrokerOrder, type GttOrder } from "@nraialgo/shared/api";

type TabId = "open" | "closed" | "all" | "gtt";

const TABS: { id: TabId; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
  { id: "gtt", label: "GTT Orders" },
];

/** Match the web app's normalizeStatus — ICICI uses many status words that all map to three states. */
type OrderStatus = "COMPLETE" | "REJECTED" | "OPEN" | "CANCELLED" | "OTHER";
function normalizeStatus(value: string | null | undefined): OrderStatus {
  const text = String(value ?? "").trim().toUpperCase();
  if (/^(COMPLETE|COMPLETED|EXECUTED|FILLED|TRADED)$/.test(text)) return "COMPLETE";
  if (/^REJECT/.test(text)) return "REJECTED";
  if (/^(CANCEL|CANCELLED|CANCELED)/.test(text)) return "CANCELLED";
  if (/^(OPEN|PENDING|TRIGGER PENDING|ORDERED|REQUESTED|PARTIALLY|PUT ORDER REQ|VALIDATION PENDING|AMO REQ)/.test(text)) return "OPEN";
  return "OTHER";
}

/** ICICI timestamps arrive in multiple formats without timezone but are always IST.
 *  Common formats: "24-Nov-2026 10:29:29", "2026-11-24 10:29:29", "2026-11-24T10:29:29"
 *  Parse them as IST so the displayed time is correct regardless of the device's own zone. */
function parseIstTimestamp(value: string | null): Date | null {
  if (!value) return null;
  
  // Check if already has timezone
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(value);
  if (hasZone) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms) : null;
  }
  
  // Try to parse "DD-Mon-YYYY HH:MM:SS" format (e.g., "24-Nov-2026 10:29:29")
  const dmyMatch = value.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}:\d{2}:\d{2})$/);
  if (dmyMatch) {
    const [, day, monStr, year, time] = dmyMatch;
    const months: Record<string, string> = {
      Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
      Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12"
    };
    const mon = months[monStr.charAt(0).toUpperCase() + monStr.slice(1).toLowerCase()];
    if (mon) {
      const iso = `${year}-${mon}-${day.padStart(2, "0")}T${time}+05:30`;
      const ms = Date.parse(iso);
      return Number.isFinite(ms) ? new Date(ms) : null;
    }
  }
  
  // Try ISO-like format "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DDTHH:MM:SS"
  const iso = value.replace(" ", "T") + "+05:30";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function formatOrderTime(value: string | null): string {
  const date = parseIstTimestamp(value);
  if (!date) return "—";
  return date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

/**
 * A market order has no price because none was ever sent, which is not the same fact as a limit order the
 * broker returned without one. A dash says "looked and found nothing" to both, so the row that is behaving
 * normally reads as a gap in the data.
 */
function priceCell(order: BrokerOrder): string {
  if (order.price) return formatRupees(order.price);
  return /^(MARKET|MO)$/.test(String(order.orderType ?? "").trim().toUpperCase()) ? "Market price" : "No price sent";
}

/**
 * When prod last read ICICI, in the trader's own clock. A list with no read time on it cannot be told
 * apart from a list that never arrived, so the absence is printed rather than hidden.
 */
function asOfWord(value: string | null | undefined): string {
  if (!value) return "no read time printed";
  const ms = Date.parse(value);
  return Number.isFinite(ms)
    ? `read at ${new Date(ms).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })} IST`
    : `read at ${value}`;
}

export default function OrdersScreen() {
  const { useIciciAccount, useGttOrders } = useApi();
  const { resolvedTheme } = useTheme();
  const [tab, setTab] = useState<TabId>("open");

  // A hidden tab stops polling (see useScreenFocused); it refreshes once when shown again.
  const focused = useScreenFocused();
  const {
    data: iciciAccount, isLoading: ordersLoading, isFetching: ordersFetching,
    isError: ordersError, refetch: refetchOrders,
  } = useIciciAccount({
    queryKey: queryKeys.brokerAccount.icici(),
    subscribed: focused,
    gcTime: Infinity,
    staleTime: 10_000,
  });
  const { data: gtts, isLoading: gttLoading, isError: gttError, refetch: refetchGtts } = useGttOrders({
    queryKey: queryKeys.orders.gtt(),
    subscribed: focused,
    gcTime: Infinity,
    staleTime: 30_000,
  });

  const allOrders = useMemo(() => iciciAccount ? iciciOrders(iciciAccount) : [], [iciciAccount]);
  // What prod says about this particular list — cold, degraded, stale or its own answer — so an empty
  // tab can name the reason instead of telling the trader the broker has nothing.
  const ordersState = iciciAccountSection(iciciAccount, "order");
  // A display read never waits for the broker: /v1/broker-auth/icici/account answers from the saved
  // snapshot and runs the ICICI order-list call behind it, saying so with `refreshing`. One pull therefore
  // always showed the previous book, so the screen re-reads the moment that read lands.
  const brokerRead = iciciAccount?.refreshing === true;
  const waitingOnBroker = useRef(false);
  // The spinner answers the pull, not the 30-second safety poll the account query also runs; otherwise the
  // list appears to refresh itself all day and a real gesture is indistinguishable from it.
  const [pulled, setPulled] = useState(false);
  useEffect(() => {
    if (brokerRead) waitingOnBroker.current = true;
    else if (waitingOnBroker.current) {
      waitingOnBroker.current = false;
      void refetchOrders();
    }
  }, [brokerRead, refetchOrders]);
  useEffect(() => {
    if (!ordersFetching) setPulled(false);
  }, [ordersFetching]);

  const colors = useMemo(() => resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#64748b", border: "#334155", accent: "#38bdf8", buy: "#22c55e", sell: "#ef4444" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", accent: "#0284c7", buy: "#16a34a", sell: "#dc2626" }, [resolvedTheme]);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    tabBar: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.card },
    tab: { flex: 1, paddingVertical: 12, alignItems: "center" },
    tabActive: { borderBottomWidth: 2, borderBottomColor: colors.accent },
    tabText: { fontSize: 13, fontWeight: "500", color: colors.muted },
    tabTextActive: { color: colors.accent, fontWeight: "600" },
    listContent: { padding: 12, paddingBottom: 100 },
    card: {
      backgroundColor: colors.card,
      borderRadius: 10,
      padding: 12,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: colors.border,
    },
    header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
    symbol: { fontSize: 14, fontWeight: "600", color: colors.text },
    badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, fontSize: 10, fontWeight: "600" },
    badgeWorking: { backgroundColor: "rgba(56,189,248,0.15)", color: "#38bdf8" },
    badgeDone: { backgroundColor: "rgba(34,197,94,0.15)", color: "#22c55e" },
    badgeRejected: { backgroundColor: "rgba(239,68,68,0.15)", color: "#ef4444" },
    badgePartial: { backgroundColor: "rgba(245,158,11,0.15)", color: "#f59e0b" },
    badgeActive: { backgroundColor: "rgba(56,189,248,0.15)", color: "#38bdf8" },
    badgeExpired: { backgroundColor: "rgba(100,116,139,0.15)", color: "#64748b" },
    row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
    label: { fontSize: 11, color: colors.muted },
    value: { fontSize: 12, fontWeight: "500", color: colors.text },
    buyValue: { color: colors.buy },
    sellValue: { color: colors.sell },
    empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40 },
    emptyContent: { flexGrow: 1, alignItems: "center", justifyContent: "center" },
    emptyText: { fontSize: 14, color: colors.muted, textAlign: "center" },
    loading: { flex: 1, alignItems: "center", justifyContent: "center" },
    sectionHeader: { fontSize: 11, fontWeight: "600", color: colors.muted, textTransform: "uppercase", paddingVertical: 8, paddingHorizontal: 4, backgroundColor: colors.bg },
    note: { fontSize: 11, color: colors.muted, paddingBottom: 8 },
    noteWarn: { color: "#f59e0b" },
  }), [colors]);

  // The broker's own words decide the tab, and no row is allowed to fall between them. ICICI sends more
  // state strings than the collapse knows ("EXPIRED", "APPROVAL PENDING"), and until now an order in one of
  // those sat in neither list — a missing row reads as an order that never was.
  const { openOrders, closedOrders, otherOrders } = useMemo(() => {
    const open: BrokerOrder[] = [];
    const closed: BrokerOrder[] = [];
    const other: BrokerOrder[] = [];
    for (let i = 0; i < allOrders.length; i++) {
      const order = allOrders[i];
      const s = normalizeStatus(order.status);
      if (s === "OPEN") {
        open.push(order);
      } else if (s === "COMPLETE" || s === "CANCELLED" || s === "REJECTED") {
        closed.push(order);
      } else {
        other.push(order);
      }
    }
    return { openOrders: open, closedOrders: closed, otherOrders: other };
  }, [allOrders]);

  const isLoading = tab === "gtt" ? gttLoading : ordersLoading;
  const isError = tab === "gtt" ? gttError : ordersError;
  const refetch = tab === "gtt" ? refetchGtts : refetchOrders;

  const renderOrderCard = (order: BrokerOrder) => {
    const status = normalizeStatus(order.status);
    const isOpen = status === "OPEN";
    const isComplete = status === "COMPLETE";
    return (
      <View key={order.orderId} style={styles.card}>
        <View style={styles.header}>
          <Text style={styles.symbol}>{order.symbol || order.orderId}</Text>
          <Text style={[styles.badge, isOpen ? styles.badgeWorking : isComplete ? styles.badgeDone : styles.badgeRejected]}>
            {order.status}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={[styles.value, order.side === "BUY" ? styles.buyValue : styles.sellValue]}>
            {order.side} {formatNumber(order.filledQuantity)}/{formatNumber(order.quantity)}
          </Text>
          <Text style={styles.value}>
            {priceCell(order)}
          </Text>
        </View>
        {order.message ? <Text style={styles.label}>{order.message}</Text> : null}
        <View style={[styles.row, { marginTop: 4 }]}>
          <Text style={styles.label}>{order.exchange}</Text>
          <Text style={styles.label}>{formatOrderTime(order.timestamp)}</Text>
        </View>
      </View>
    );
  };

  const renderGttCard = (gtt: GttOrder) => {
    const spec = gtt.order_spec as Record<string, unknown>;
    const symbol = (spec?.tradingsymbol as string) || (spec?.symbol as string) || "GTT";
    const side = (spec?.side as string) || "";
    const quantity = Number(spec?.quantity) || 0;
    const price = Number(spec?.price) || 0;
    const exchange = (spec?.exchange as string) || "";
    return (
      <View key={gtt.id} style={styles.card}>
        <View style={styles.header}>
          <Text style={styles.symbol}>{symbol}</Text>
          <Text style={[styles.badge, gtt.state === "active" ? styles.badgeActive : gtt.state === "failed" ? styles.badgeRejected : gtt.state === "cancelled" ? styles.badgeExpired : styles.badgeWorking]}>
            {gtt.state.toUpperCase().replace("_", " ")}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={[styles.value, side === "BUY" ? styles.buyValue : styles.sellValue]}>
            {side} {formatNumber(quantity)}
          </Text>
          <Text style={styles.value}>Trigger: ₹{gtt.trigger_price}</Text>
        </View>
        {price > 0 && (
          <View style={styles.row}>
            <Text style={styles.label}>Limit</Text>
            <Text style={styles.value}>{formatRupees(price)}</Text>
          </View>
        )}
        {gtt.last_error && (
          <View style={styles.row}>
            <Text style={styles.label}>Reason</Text>
            <Text style={styles.value}>{gtt.last_error}</Text>
          </View>
        )}
        <View style={[styles.row, { marginTop: 4 }]}>
          <Text style={styles.label}>
            {gtt.provider}{exchange ? ` · ${exchange}` : ""} · {new Date(gtt.created_at).toLocaleDateString()}
          </Text>
        </View>
      </View>
    );
  };

  // A failed read belongs to one tab, so it covers only that tab's body: the bar stays mounted and the
  // other two lists remain reachable instead of the whole screen answering with one error.
  const statusPane = () => {
    if (isLoading) {
      return (
        <View style={[styles.empty, { flex: 1 }]}>
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      );
    }
    if (!isError) return null;
    return (
      <View style={[styles.empty, { flex: 1 }]}>
        <Text style={styles.emptyText}>Failed to load {tab === "gtt" ? "GTT orders" : "orders"}</Text>
        <TouchableOpacity style={{ marginTop: 16, paddingVertical: 12, alignItems: "center" }} onPress={() => void refetch()}>
          <Text style={{ color: colors.accent, fontWeight: "600" }}>Tap to retry</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderOrderItem = useCallback(({ item }: { item: BrokerOrder }) => renderOrderCard(item), [styles, colors]);
  const renderGttItem = useCallback(({ item }: { item: GttOrder }) => renderGttCard(item), [styles, colors]);

  // Two broker rows can carry the same blank order id, and a FlatList renders one item per key — the row
  // that vanished was there, just not keyed. A blank id gets a key of its own.
  const orderKey = (order: BrokerOrder, index: number) =>
    order.orderId || `${order.symbol ?? "order"}-${order.timestamp ?? ""}-${index}`;

  // What the list is, in prod's own words: whose book, when it was read, and which exchanges the rows came
  // from. The exchange scope is read from the rows rather than written here, because prod has already widened
  // it once (NSE + NFO, then BSE + BFO) and a hard-coded claim on screen outlives the code that made it true.
  const seenExchanges = useMemo(() => {
    const found = new Set<string>();
    for (const order of allOrders) {
      const code = String(order.exchange ?? "").trim().toUpperCase();
      if (code) found.add(code);
    }
    return [...found].sort();
  }, [allOrders]);

  const orderHeader = (
    <View>
      <Text style={styles.note}>
        {`ICICI order book · ${asOfWord(iciciAccount?.asOf)} · today's session${
          seenExchanges.length ? `, ${seenExchanges.join(" + ")}` : ""}`}
      </Text>
      {ordersState.reason ? <Text style={[styles.note, styles.noteWarn]}>{ordersState.reason}</Text> : null}
      {otherOrders.length > 0 ? (
        <Text style={[styles.note, styles.noteWarn]}>
          {`${otherOrders.length} order${otherOrders.length === 1 ? " is" : "s are"} in a state ICICI words differently, so ${
            tab === "all" ? "they sit here and in neither Open nor Closed" : "they are listed under All"}`}
        </Text>
      ) : null}
    </View>
  );

  const orderList = (data: BrokerOrder[], emptyText: string) => (
    <FlatList
      data={data}
      keyExtractor={orderKey}
      renderItem={renderOrderItem}
      contentContainerStyle={[styles.listContent, data.length === 0 && styles.emptyContent]}
      ListHeaderComponent={orderHeader}
      ListEmptyComponent={<Text style={styles.emptyText}>{emptyText}</Text>}
      initialNumToRender={10}
      maxToRenderPerBatch={10}
      windowSize={5}
      removeClippedSubviews
      refreshControl={<RefreshControl refreshing={brokerRead || pulled} onRefresh={() => { setPulled(true); void refetchOrders(); }} colors={[colors.accent]} tintColor={colors.accent} title={brokerRead ? "Reading ICICI..." : undefined} titleColor={colors.muted} />}
    />
  );

  const renderContent = () => {
    const pane = statusPane();
    if (pane) return pane;

    // "No orders" is a claim about the broker's book, so it is only printed when the book is actually
    // there. A cold or half-filled read answers with the server's own reason instead.
    if (tab !== "gtt" && (ordersState.kind === "unavailable" || ordersState.kind === "cold")) {
      return (
        <View style={[styles.empty, { flex: 1 }]}>
          <Text style={styles.emptyText}>{ordersState.reason ?? "The broker's order book is not available."}</Text>
          <TouchableOpacity style={{ marginTop: 16, paddingVertical: 12, alignItems: "center" }} onPress={() => { setPulled(true); void refetchOrders(); }}>
            <Text style={{ color: colors.accent, fontWeight: "600" }}>Read ICICI again</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (tab === "open") return orderList(openOrders, "No open orders in today's book");
    if (tab === "closed") return orderList(closedOrders, "No closed orders in today's book");
    if (tab === "all") return orderList(allOrders, "ICICI returned no orders for this session");

    if (tab === "gtt") {
      if (!gtts || gtts.length === 0) {
        return <View style={styles.empty}><Text style={styles.emptyText}>No GTT orders</Text></View>;
      }
      return (
        <FlatList
          data={gtts}
          keyExtractor={(item) => item.id}
          renderItem={renderGttItem}
          contentContainerStyle={styles.listContent}
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={5}
          removeClippedSubviews
          refreshControl={<RefreshControl refreshing={false} onRefresh={() => void refetchGtts()} colors={[colors.accent]} />}
        />
      );
    }

    return null;
  };

  return (
    <View style={styles.container}>
      <View style={styles.tabBar}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.id}
            style={[styles.tab, tab === t.id && styles.tabActive]}
            onPress={() => setTab(t.id)}
          >
            <Text style={[styles.tabText, tab === t.id && styles.tabTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {renderContent()}
    </View>
  );
}
