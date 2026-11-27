/**
 * Orders Screen - Live broker orders from ICICI
 *
 * Fetches orders directly from the broker account, so every order in the account
 * appears here — whether placed from this app or from the broker's own app.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useScreenFocused } from "@/hooks/useScreenFocused";
import { View, Text, FlatList, StyleSheet, ActivityIndicator, TouchableOpacity, RefreshControl, Modal } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/components/ThemeProvider";
import OrderNoticeList from "@/components/OrderNoticeList";
import { formatRupees, formatNumber } from "@nraialgo/shared/utils";
import { useApi } from "@/hooks/useApi";
import {
  GTT_REFUSED_REASON, INTENT_WINDOW, cancelDecision, cancelLegs, gttCancelState,
  iciciAccountSection, iciciOrders, queryKeys,
  type BrokerOrder, type CancelLeg, type GttOrder, type OrderIntent,
} from "@nraialgo/shared/api";

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

/** What the app calls the instruction: the name the desk filed it under, else the reference itself. */
const basketOf = (intent: OrderIntent): string => intent.basketName?.trim() || intent.clientId;

/** Prod's journal is the only place a cancel is recorded, so this is written the moment the 202 lands. */
const WAITING = "Cancellation asked for. Waiting for ICICI to confirm it.";

const legWord = (leg: CancelLeg): string => {
  if (leg.unfilled <= 0) return `${formatNumber(leg.quantity)} filled · nothing left`;
  if (leg.quantity - leg.unfilled <= 0) return `${formatNumber(leg.quantity)} · unfilled`;
  return `${formatNumber(leg.quantity - leg.unfilled)} filled, ${formatNumber(leg.unfilled)} left`;
};

/**
 * What a row may honestly do, in the trader's words.
 *
 * Each line answers a question the trader is actually asking — can I stop this, and if not, why not — and
 * every refusal names the fact behind it. `unchecked` and `outside` are kept apart because one means the
 * app has not looked yet and the other means it looked and found nothing, which decide whether a cancel
 * exists somewhere at all.
 */
function cancelWord(decision: ReturnType<typeof cancelDecision>, window: number): { action: string | null; reason: string } {
  switch (decision.kind) {
    case "offer": {
      const legs = decision.legs;
      return {
        action: "Cancel unfilled",
        reason: `Placed here as ${basketOf(decision.intent)} · ${legs.length} unfilled leg${legs.length === 1 ? "" : "s"} in that order`,
      };
    }
    case "requested":
      return { action: null, reason: WAITING };
    case "stopped": {
      const rest = decision.filled > 0
        ? `${formatNumber(decision.filled)} of ${formatNumber(decision.quantity)} had already filled and stays in your positions.`
        : "Nothing filled, so this leg left no position.";
      return { action: null, reason: `The unfilled part stopped. ${rest}` };
    }
    case "manual":
      return {
        action: null,
        reason: decision.intent.message?.trim() || "Automatic cancellation has stopped for this order. Check it in ICICI's terminal.",
      };
    case "filled":
      return { action: null, reason: "Filled leg. Nothing left to cancel." };
    case "outside":
      return {
        action: null,
        reason: decision.truncated
          ? `Not among this app's newest ${window} instructions — cancel it in ICICI.`
          : "Not placed in this app — cancel it in ICICI.",
      };
    case "unchecked":
      return { action: null, reason: "Not checked against this app's instructions: that list is still loading or did not answer." };
  }
}

export default function OrdersScreen() {
  const { useIciciAccount, useGttOrders, useOrderIntents, useCancelOrder, useCancelGtt, readFreshOrders } = useApi();
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
  // Opening this screen (or coming back to it) and every pull read ICICI's order book directly, once.
  const [freshReading, setFreshReading] = useState(false);
  // The journal that says whether a broker row is this app's to cancel. `GET /v1/orders` is a Postgres read
  // of the app's own instruction table, so resolving a row costs ICICI nothing — no broker call, no meter.
  const {
    data: intentRows, isLoading: intentsLoading, isError: intentsError,
  } = useOrderIntents({ limit: INTENT_WINDOW }, {
    queryKey: queryKeys.orders.intents({ limit: INTENT_WINDOW }),
    subscribed: focused,
    gcTime: Infinity,
    staleTime: 10_000,
  });
  // null is "the app does not know yet", which the card prints as a check that has not run rather than an
  // order the app never placed. An empty journal is a real answer and keeps the second wording.
  const journal = intentsLoading || intentsError ? null : (intentRows ?? null);

  // One sheet for both destructive presses, because both stop something at the broker and both must name
  // what they leave behind. Opening it sends nothing; only the labelled press does.
  const [sheet, setSheet] = useState<
    | { kind: "order"; clientId: string; basket: string; legs: CancelLeg[]; stopping: CancelLeg[] }
    | { kind: "gtt"; id: string; symbol: string; line: string }
    | null
  >(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // Which instructions this screen has already asked prod to stop. A 202 means the journal row is written,
  // so flipping the card now is the server's own state a moment early — not a guess — and it stops a second
  // press on a request the server would answer as a no-op.
  const [asked, setAsked] = useState<Record<string, boolean>>({});
  const readOrdersNow = useCallback(() => {
    setFreshReading(true);
    void readFreshOrders().catch(() => undefined).finally(() => setFreshReading(false));
  }, [readFreshOrders]);
  // readFreshOrders is the one API singleton's function, so this runs once per show, not per render.
  useEffect(() => { if (focused) void readFreshOrders().catch(() => undefined); }, [focused, readFreshOrders]);
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
    if (!ordersFetching && !freshReading) setPulled(false);
  }, [ordersFetching, freshReading]);

  // One press = one command, with no auto-retry: a request that never answered is not proof nothing was
  // sent, so the sheet stays open on a failure, prints the server's own sentence, and leaves the row exactly
  // where it was for the trader to read ICICI's book before trying again. The cache invalidation lives in
  // the hook, so the list re-reads itself whatever this screen does with the answer.
  const cancelFallback = "Cancellation was not confirmed. Orders may still be active. Check the broker order book before trying again.";
  const cancelOrder = useCancelOrder({
    onSuccess: (snapshot) => {
      // A 202 means prod's journal row is written, so the card flips to "asked" from the server's own state.
      setAsked(prev => ({ ...prev, [snapshot.clientId]: true }));
      setSheet(null);
      setCancelError(null);
    },
    onError: (error) => setCancelError(error.message || cancelFallback),
  });
  // Prod answers a GTT delete with the row it just wrote, and the invalidation inside the mutation re-reads
  // the list, so the card repaints from the journal's own state rather than from a local guess.
  const cancelGttNow = useCancelGtt({
    onSuccess: () => { setSheet(null); setCancelError(null); },
    onError: (error) => setCancelError(error.message || cancelFallback),
  });
  const cancelling = cancelOrder.isPending || cancelGttNow.isPending;

  const closeSheet = () => { setSheet(null); setCancelError(null); };

  const sendCancel = () => {
    if (!sheet || cancelling) return;
    if (sheet.kind === "order") void cancelOrder.mutate(sheet.clientId);
    else void cancelGttNow.mutate(sheet.id);
  };

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
    // The card's own action line: a press where prod answers, the fact where it does not.
    action: { fontSize: 11, color: colors.muted, marginTop: 6 },
    actionWrap: { marginTop: 8, borderRadius: 8, borderWidth: 1, borderColor: colors.sell, paddingVertical: 9, alignItems: "center" },
    actionText: { fontSize: 13, fontWeight: "700", color: colors.sell },
    requested: { color: "#f59e0b", fontWeight: "700" },
    // Same sheet shape the basket builder uses, so a destructive press looks the same on every screen.
    sheet: { backgroundColor: colors.bg, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 34 },
    sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6, gap: 10 },
    sheetClose: { padding: 4 },
    title: { fontSize: 16, fontWeight: "700", color: colors.text, flexShrink: 1 },
    small: { fontSize: 12, color: colors.muted, lineHeight: 18 },
    legRow: { flexDirection: "row", justifyContent: "space-between", gap: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border },
    legName: { fontSize: 13, fontWeight: "600", color: colors.text, flexShrink: 1 },
    legNote: { fontSize: 12, color: colors.muted, textAlign: "right" },
    block: { marginTop: 12, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 14, alignItems: "center" },
    dangerous: { backgroundColor: colors.sell },
    dangerousText: { color: "#ffffff", fontSize: 15, fontWeight: "700" },
    quiet: { borderWidth: 1, borderColor: colors.border },
    quietText: { color: colors.text, fontSize: 15, fontWeight: "600" },
    alert: { marginTop: 10, fontSize: 12, color: colors.sell, lineHeight: 18 },
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

  // A row ICICI still calls open is the only one with something to stop, so only it carries an action line.
  // Everything it says comes from the two reads the screen already holds: the broker's book and the app's
  // own instruction journal, joined on the id the exchange stamped.
  const actionLine = (order: BrokerOrder) => {
    if (normalizeStatus(order.status) !== "OPEN") return null;
    const decision = cancelDecision(order, journal);
    const word = cancelWord(decision, INTENT_WINDOW);
    if (decision.kind !== "offer") {
      return <Text style={[styles.action, decision.kind === "requested" ? styles.requested : undefined]}>{word.reason}</Text>;
    }
    const intent = decision.intent;
    if (asked[intent.clientId]) return <Text style={[styles.action, styles.requested]}>{WAITING}</Text>;
    const basket = basketOf(intent);
    return (
      <>
        <Text style={styles.action}>{word.reason}</Text>
        <TouchableOpacity
          style={styles.actionWrap}
          accessibilityRole="button"
          accessibilityLabel={`Cancel the unfilled legs of ${basket}`}
          onPress={() => {
            setCancelError(null);
            setSheet({ kind: "order", clientId: intent.clientId, basket, legs: cancelLegs(intent), stopping: decision.legs });
          }}
        >
          <Text style={styles.actionText}>{word.action}</Text>
        </TouchableOpacity>
      </>
    );
  };

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
        {actionLine(order)}
      </View>
    );
  };

  // A GTT has its own journal, so the press is offered only for the two states prod acts on: never sent, or
  // active at the broker. A GTT that already fired is not this control's business — the order it placed
  // lives in the book and has to be dealt with there — and prod refuses anything else in its own words.
  const gttAction = (gtt: GttOrder, symbol: string, side: string, quantity: number, price: number) => {
    const state = gttCancelState(gtt);
    if (state === "closed") return null;
    if (state === "waiting") return <Text style={[styles.action, styles.requested]}>{WAITING}</Text>;
    if (state === "refused") return <Text style={styles.action}>{GTT_REFUSED_REASON}</Text>;
    return (
      <TouchableOpacity
        style={styles.actionWrap}
        accessibilityRole="button"
        accessibilityLabel={`Cancel the GTT on ${symbol}`}
        onPress={() => {
          setCancelError(null);
          setSheet({
            kind: "gtt",
            id: gtt.id,
            symbol,
            line: `${side} ${formatNumber(quantity)} · trigger ₹${gtt.trigger_price}${price > 0 ? ` · limit ${formatRupees(price)}` : ""}`,
          });
        }}
      >
        <Text style={styles.actionText}>Cancel GTT</Text>
      </TouchableOpacity>
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
        {gttAction(gtt, symbol, side, quantity, price)}
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

  // The card now reads two things that arrive after the first render — the instruction journal and this
  // screen's own asked-flags — so both belong in the memo's dependencies. Memoising on styles alone would
  // keep the first render's closure and print "not checked against this app's instructions" forever.
  const renderOrderItem = useCallback(({ item }: { item: BrokerOrder }) => renderOrderCard(item), [styles, colors, journal, asked]);
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
      {/* Where a cancel comes from, stated once instead of by implication on every card. */}
      <Text style={styles.note}>
        {"Cancel is offered for orders this app's desk filed, because the server stops what it journaled. An order placed in ICICI is cancelled in ICICI."}
      </Text>
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
      refreshControl={<RefreshControl refreshing={brokerRead || pulled || freshReading} onRefresh={() => { setPulled(true); readOrdersNow(); }} colors={[colors.accent]} tintColor={colors.accent} title={brokerRead ? "Reading ICICI..." : undefined} titleColor={colors.muted} />}
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
          <TouchableOpacity style={{ marginTop: 16, paddingVertical: 12, alignItems: "center" }} onPress={() => { setPulled(true); readOrdersNow(); }}>
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

  // Every tab names how many it holds; a list still loading shows a dash rather than a false zero.
  const tabCounts: Record<TabId, string> = {
    open: iciciAccount ? String(openOrders.length) : "–",
    closed: iciciAccount ? String(closedOrders.length) : "–",
    all: iciciAccount ? String(allOrders.length) : "–",
    gtt: gtts ? String(gtts.length) : "–",
  };

  // Opening this sheet sends nothing. Every leg of the instruction is listed, filled ones included, because
  // the reference prod cancels is the basket's — and the press is labelled with the count it actually stops.
  const orderSheet = sheet?.kind === "order" ? sheet : null;
  const gttSheet = sheet?.kind === "gtt" ? sheet : null;
  const cancelSheet = (
    <Modal visible={sheet !== null} transparent animationType="slide" onRequestClose={closeSheet}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}>
        <View style={styles.sheet}>
          <View style={styles.sheetHead}>
            <Text style={styles.title}>{orderSheet ? `Cancel the unfilled legs of ${orderSheet.basket}?` : "Cancel this GTT?"}</Text>
            <TouchableOpacity style={styles.sheetClose} onPress={closeSheet} accessibilityRole="button" accessibilityLabel="Close without cancelling">
              <Ionicons name="close" size={22} color={colors.muted} />
            </TouchableOpacity>
          </View>
          {orderSheet ? (
            <>
              <Text style={styles.small}>
                ICICI will be asked to cancel what has not filled yet. Legs already filled are not reversed — they stay in your positions.
              </Text>
              {orderSheet.legs.map((leg, i) => (
                <View key={`${leg.tradingsymbol}-${leg.side}-${i}`} style={styles.legRow}>
                  <Text style={styles.legName}>{leg.tradingsymbol}</Text>
                  <Text style={styles.legNote}>{`${leg.side} ${legWord(leg)}`}</Text>
                </View>
              ))}
              <Text style={[styles.small, { marginTop: 8 }]}>
                {'The order stays on this screen as "cancel requested" until ICICI confirms it. A cancel that is not confirmed is not a cancelled order.'}
              </Text>
            </>
          ) : (
            <>
              {gttSheet ? <Text style={styles.title}>{`${gttSheet.symbol} · ${gttSheet.line}`}</Text> : null}
              <Text style={styles.small}>
                If ICICI is holding this GTT the app asks for the delete; if it was never sent, the app cancels it in its own journal. An order the GTT already triggered stays in your book.
              </Text>
            </>
          )}
          {cancelError ? <Text style={styles.alert}>{cancelError}</Text> : null}
          <TouchableOpacity
            style={[styles.block, styles.dangerous]}
            onPress={sendCancel}
            disabled={cancelling}
            accessibilityRole="button"
            accessibilityLabel={orderSheet ? `Confirm cancelling ${orderSheet.stopping.length} unfilled legs` : "Confirm cancelling this GTT"}
          >
            <Text style={styles.dangerousText}>
              {cancelling
                ? "Cancelling"
                : orderSheet
                  ? `Cancel ${orderSheet.stopping.length} unfilled leg${orderSheet.stopping.length === 1 ? "" : "s"}`
                  : "Cancel GTT"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.block, styles.quiet]} onPress={closeSheet} accessibilityRole="button" accessibilityLabel="Keep the orders and close">
            <Text style={styles.quietText}>{gttSheet ? "Keep the GTT" : "Keep the orders"}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );

  return (
    <View style={styles.container}>
      {/* The notices a toast said out loud and the trader did not tap are still here, unread, above the book.
          Renders nothing until prod has a live notice for this account. */}
      <OrderNoticeList />
      <View style={styles.tabBar}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.id}
            style={[styles.tab, tab === t.id && styles.tabActive]}
            onPress={() => setTab(t.id)}
          >
            <Text style={[styles.tabText, tab === t.id && styles.tabTextActive]}>{`${t.label} (${tabCounts[t.id]})`}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {renderContent()}
      {cancelSheet}
    </View>
  );
}
