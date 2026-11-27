/**
 * Stock Overview screen - what a tap on a symbol opens
 *
 * Every figure here is one the deployed backend already publishes on `GET /v1/equities/quote`: the price and
 * the day's statics, and - when the account's socket holds that view - the five-level book. Nothing is
 * estimated to fill a gap. A field the server omitted reads "not sent", and the read carries its own
 * provenance badge, because a blank the trader cannot explain is worse than a short screen.
 *
 * A symbol tapped out of the catalogue is not in any leased watchlist page, so its first priced frame can
 * arrive seconds after the screen opened. The read therefore asks again until a price lands, the socket's own
 * trade paints the header when the REST read has not answered, and a read that came back short draws the
 * snapshot with its stated reason instead of replacing the whole screen with an error.
 *
 * The Buy and Sell buttons hand off to the shared order ticket exactly as the watchlist row does, so the
 * ticket stays the one place an instruction is built and nothing places until its own button is pressed.
 *
 * A tab is only offered where it has a destination. Option chains exist for the underlyings the exchange lists
 * contracts on, so the tab is greyed for a stock the derivatives master does not name, with its reason printed
 * under the tabs, instead of navigating to a screen that fails on a symbol it never had chains for.
 */

import React, { useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useCanGoBack, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { bookStamp, depthBook, offersChainTab, queryKeys, quoteProvenance, rangePosition, streamId, useInstrumentTick, useQuoteSubscription, type EquityQuote } from "@nraialgo/shared/api";
import { useOrderTicket } from "@nraialgo/shared/hooks";
import { formatISTDate, formatNumber, formatQuantity } from "@nraialgo/shared/utils";
import { BuySheet } from "@/components/BuySheet";
import { tabRoute } from "@/utils/tabRoute";
import { useTheme } from "@/components/ThemeProvider";
import { useApi } from "@/hooks/useApi";

/** Breeze shows five levels; a shallower book is drawn as the levels the socket actually filled. */
const LADDER_ROWS = 5;

/**
 * How often the read is asked again. A symbol the trader tapped out of the catalogue is not in any leased
 * watchlist page, so its first priced frame can arrive a few seconds after the screen opened; asking again
 * quickly is what turns "does not open" into a snapshot. Once a price has landed, the socket carries the
 * screen and the read has no reason to repeat at that pace.
 */
const QUOTE_POLL_FIRST_MS = 3_000;
const QUOTE_POLL_SETTLED_MS = 15_000;

export default function StockScreen() {
  const params = useLocalSearchParams<{ exchange?: string; symbol?: string; held?: string; list?: string; tab?: string }>();
  const router = useRouter();
  const { useEquityQuote, useChainUnderlyings, useWatchlist, useAddToWatchlist, useRemoveFromWatchlist } = useApi();
  const { resolvedTheme } = useTheme();
  const ticket = useOrderTicket();

  const symbol = String(params.symbol ?? "").trim().toUpperCase();
  /** Back names the screen the press came from. Popping was not enough: the tab group came back on the More
   *  tab whatever tab the trader pressed, and the search screen came back with its box emptied, so each
   *  destination is navigated by name instead. A link can open this screen as the first route in the stack,
   *  where there is nothing beneath it, so the arrow replaces it instead of throwing an unhandled GO_BACK. */
  const canGoBack = useCanGoBack();
  const backTo = tabRoute(params.tab);
  const goBack = () => (!canGoBack ? router.replace(backTo) : router.navigate(backTo));
  const [exchange, setExchange] = useState(() => String(params.exchange ?? "NSE").trim().toUpperCase() || "NSE");
  // The list an add lands in is the one the press came from; a screen opened without one uses the first.
  const listNumber = Math.max(1, Number(params.list ?? 1) || 1);
  const held = Number(params.held);
  const heldQty = Number.isFinite(held) && held !== 0 ? held : null;

  // The other venue is the same endpoint asked with the other exchange, which is how Breeze's own switch works.
  const other = exchange === "NSE" ? "BSE" : exchange === "BSE" ? "NSE" : null;

  const { data: rawQuote, isLoading, error, refetch, isFetching } = useEquityQuote(exchange, symbol, symbol.length > 0, {
    refetchInterval: ({ state }) => (state.data?.ltp ? QUOTE_POLL_SETTLED_MS : QUOTE_POLL_FIRST_MS),
  });
  /**
   * The same derivatives master the chain screen's own picker reads, cached an hour, so the tab is greyed by the
   * server's list of underlyings with contracts rather than by a guess about what a symbol's name looks like.
   */
  const { data: catalogue } = useChainUnderlyings({ queryKey: queryKeys.optionChain.underlyings() });
  const chainTab = offersChainTab(catalogue?.underlyings, symbol);
  const cashId = exchange === "NSE" && symbol.length > 0 ? streamId(symbol) : null;
  useQuoteSubscription(cashId ? [cashId] : [], !!cashId);
  const liveTick = useInstrumentTick(cashId);
  const quote = useMemo<EquityQuote | undefined>(() => {
    if (!liveTick || !liveTick.fresh) return rawQuote;
    if (!rawQuote) {
      // The read has not answered -- or refused -- while this device's own subscription is already carrying
      // the stock's trade. The tick is the better source of the two, so it paints the frame and the trader
      // gets a snapshot with its stamp instead of a screen that says the symbol cannot be opened.
      const stamp = liveTick.at ? new Date(liveTick.at).toISOString() : null;
      const price = liveTick.price > 0 ? liveTick.price : null;
      const prev = liveTick.previousClose ?? null;
      const change = price !== null && prev && prev > 0 ? price - prev : null;
      return {
        exchange,
        symbol,
        ltp: price,
        close: prev,
        change,
        changePct: change !== null && prev ? (change / prev) * 100 : null,
        bid: liveTick.bid ?? null,
        ask: liveTick.ask ?? null,
        bidQuantity: liveTick.bidQty ?? null,
        askQuantity: liveTick.askQty ?? null,
        at: stamp,
        priceDate: stamp,
        source: liveTick.broker,
        quality: "live",
      };
    }
    const ltp = liveTick.price > 0 ? liveTick.price : rawQuote.ltp;
    const prev = liveTick.previousClose ?? rawQuote.close;
    const change = prev && prev > 0 && ltp ? ltp - prev : rawQuote.change;
    const changePct = prev && prev > 0 && change !== null ? (change / prev) * 100 : rawQuote.changePct;
    const hasLiveBidAsk = (liveTick.bid && liveTick.bid > 0) || (liveTick.ask && liveTick.ask > 0);
    return {
      ...rawQuote,
      ltp,
      change,
      changePct,
      // Live only when the tick itself priced the row; otherwise it is the REST quote under a live book.
      quality: liveTick.price > 0 ? "live" : rawQuote.quality,
      bid: hasLiveBidAsk ? liveTick.bid ?? rawQuote.bid : rawQuote.bid,
      ask: hasLiveBidAsk ? liveTick.ask ?? rawQuote.ask : rawQuote.ask,
      bidQuantity: hasLiveBidAsk ? liveTick.bidQty ?? rawQuote.bidQuantity : rawQuote.bidQuantity,
      askQuantity: hasLiveBidAsk ? liveTick.askQty ?? rawQuote.askQuantity : rawQuote.askQuantity,
    };
  }, [rawQuote, liveTick, exchange, symbol]);
  const { data: cross } = useEquityQuote(other ?? "NSE", symbol, !!other && symbol.length > 0);
  // Membership only decides one chip's label, so the list is read once and left alone; the add and remove
  // mutations write their own page back into this cache.
  const { data: saved } = useWatchlist(listNumber, {
    queryKey: queryKeys.watchlist.list(listNumber),
    enabled: symbol.length > 0,
    refetchInterval: false,
  });
  const add = useAddToWatchlist();
  const drop = useRemoveFromWatchlist();

  const colors = useMemo(() => resolvedTheme === "dark"
    ? {
      bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#94a3b8", border: "#334155",
      brand: "#38bdf8", up: "#22c55e", down: "#ef4444", amber: "#f59e0b", track: "#0b1220",
    }
    : {
      bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0",
      brand: "#0284c7", up: "#16a34a", down: "#dc2626", amber: "#b45309", track: "#e2e8f0",
    }, [resolvedTheme]);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    head: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 10 },
    headMain: { flex: 1 },
    symbol: { fontSize: 17, fontWeight: "700", color: colors.text },
    meta: { fontSize: 11, color: colors.muted, marginTop: 2 },
    name: { fontSize: 11, color: colors.muted, marginTop: 3 },
    priceBox: { alignItems: "flex-end" },
    ltp: { fontSize: 19, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"] },
    change: { fontSize: 13, marginTop: 2, fontVariant: ["tabular-nums"] },
    badge: {
      marginTop: 5, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5, borderWidth: 1,
      borderColor: colors.border, flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-end",
    },
    badgeText: { fontSize: 10, fontWeight: "600", color: colors.muted },
    dot: { width: 7, height: 7, borderRadius: 4 },
    tabs: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.border, paddingHorizontal: 6 },
    tab: { paddingHorizontal: 12, paddingVertical: 11 },
    tabOn: { borderBottomWidth: 2, borderBottomColor: colors.amber },
    tabLabel: { fontSize: 13, fontWeight: "600", color: colors.muted },
    tabLabelOn: { color: colors.text },
    tabLabelOff: { opacity: 0.55 },
    tabNote: { marginHorizontal: 14, marginTop: 9, fontSize: 11, color: colors.amber, lineHeight: 16 },
    body: { padding: 14, gap: 12, paddingBottom: 22 },
    chips: { flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" },
    chip: {
      flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 11, paddingVertical: 7,
      borderRadius: 7, borderWidth: 1, borderColor: colors.amber,
    },
    chipGhost: { borderColor: colors.border },
    chipText: { fontSize: 12, fontWeight: "600", color: colors.amber },
    chipTextGhost: { color: colors.muted },
    card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12 },
    ladderHead: { flexDirection: "row", paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
    ladderHeadQty: { width: 66, fontSize: 10, color: colors.muted },
    ladderHeadPx: { flex: 1, fontSize: 10, color: colors.muted, textAlign: "center" },
    ladderRow: { flexDirection: "row", alignItems: "center", paddingVertical: 3 },
    ladderQty: { width: 66, fontSize: 13, fontVariant: ["tabular-nums"] },
    ladderPx: { flex: 1, fontSize: 13, textAlign: "center", fontVariant: ["tabular-nums"] },
    split: { flexDirection: "row", justifyContent: "space-between", marginTop: 10, marginBottom: 5 },
    splitText: { fontSize: 11, color: colors.muted },
    meter: { flexDirection: "row", height: 16, borderRadius: 4, overflow: "hidden", backgroundColor: colors.track },
    meterBid: { backgroundColor: "#16a34a", justifyContent: "center", paddingHorizontal: 7 },
    meterAsk: { backgroundColor: "#dc2626", justifyContent: "center", alignItems: "flex-end", paddingHorizontal: 7 },
    meterText: { fontSize: 10, fontWeight: "700", color: "#ffffff" },
    totals: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
    totalsText: { fontSize: 11, color: colors.muted },
    stamp: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 9 },
    stampText: { fontSize: 11, color: colors.muted },
    reason: { fontSize: 11, color: colors.amber, marginTop: 7, lineHeight: 16 },
    grid2: { flexDirection: "row", gap: 12 },
    cell: { flex: 1 },
    lab: { fontSize: 10, color: colors.muted },
    val: { fontSize: 15, fontWeight: "600", color: colors.text, marginTop: 3 },
    smallVal: { fontSize: 13, fontWeight: "600", color: colors.text, marginTop: 3 },
    missing: { fontSize: 12, fontWeight: "600", color: colors.muted, marginTop: 5 },
    range: { marginTop: 2 },
    track: { height: 3, backgroundColor: colors.border, borderRadius: 2, marginTop: 14, marginBottom: 7 },
    knob: { position: "absolute", top: -4, width: 11, height: 11, borderRadius: 6, backgroundColor: colors.text },
    ends: { flexDirection: "row", justifyContent: "space-between" },
    endText: { fontSize: 11, fontWeight: "600" },
    stats: { flexDirection: "row", gap: 10 },
    foot: {
      flexDirection: "row", gap: 10, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 18,
      borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bg,
    },
    action: { flex: 1, paddingVertical: 14, borderRadius: 9, alignItems: "center" },
    actionText: { fontSize: 16, fontWeight: "700", color: "#ffffff" },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40, gap: 12 },
    empty: { fontSize: 14, color: colors.muted, textAlign: "center", lineHeight: 21 },
    retry: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8, backgroundColor: colors.brand },
    retryText: { fontSize: 14, fontWeight: "600", color: "#ffffff" },
    notice: {
      marginHorizontal: 14, marginTop: 12, padding: 12, gap: 6, borderRadius: 10,
      borderWidth: 1, borderColor: colors.amber, backgroundColor: colors.card,
    },
    noticeText: { fontSize: 13, fontWeight: "600", color: colors.text },
    noticeReason: { fontSize: 12, color: colors.muted, lineHeight: 17 },
    noticeAction: { alignSelf: "flex-start", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 7, borderWidth: 1, borderColor: colors.amber },
    noticeActionText: { fontSize: 13, fontWeight: "700", color: colors.amber },
  }), [colors]);

  const book = depthBook(quote ?? null);
  const stamp = bookStamp(quote ?? null);
  const inList = (saved?.items ?? []).some(row => row.symbol === symbol && row.exchange === exchange);
  const busy = add.isPending || drop.isPending;

  const signed = (value: number | null | undefined) =>
    value === null || value === undefined ? "no change figure" : `${value > 0 ? "+" : ""}${formatNumber(value)}`;

  const tone = (value: number | null | undefined) =>
    (value ?? 0) > 0 ? colors.up : (value ?? 0) < 0 ? colors.down : colors.muted;

  const shown = (value: number | null | undefined, decimals = 2) =>
    typeof value === "number" && Number.isFinite(value) ? formatNumber(value, decimals) : null;

  /** Whether the frame has a number to put where a price belongs. Everything else is drawn from what did
   *  arrive, so a read that came back short is a short screen rather than one that was refused. */
  const priced = shown(quote?.ltp) !== null;
  /** Why there is no price, in the words the account supplied: the read's own error, else the book's reason. */
  const refusal = (error?.message ?? quote?.depthMessage ?? "").trim() || null;
  /** A read still on its first attempt gets a spinner; one that answered is drawn however little it holds. */
  const waiting = isLoading && !priced;
  /** A frame with nothing priced cannot carry the server's "Today": the badge says what the screen holds. */
  const provenance = priced
    ? quoteProvenance(quote ?? null)
    : { word: "No price", live: false, date: quote?.priceDate ?? null };

  const openTicket = (side: "BUY" | "SELL") => {
    ticket.open({
      symbol,
      exchange,
      product: exchange === "NSE" || exchange === "BSE" ? "CNC" : "NRML",
      side,
      quantity: 1,
      orderType: "LIMIT",
      price: 0,
      source: "watchlist",
      tag: `overview:${symbol}`,
    });
  };

  const toggleList = () => {
    const payload = { exchange, symbol, list: listNumber };
    if (inList) drop.mutate(payload);
    else add.mutate(payload);
  };

  /** A static the read did not carry says so, rather than showing a dash that could be a zero. */
  const figure = (value: number | null | undefined, small = false) => {
    const text = shown(value);
    return text === null
      ? <Text style={styles.missing}>Not sent</Text>
      : <Text style={small ? styles.smallVal : styles.val}>{text}</Text>;
  };

  /** The bar only exists when the server published both ends of a range that has room in it. */
  const range = (value: number | null | undefined, low: number | null | undefined, high: number | null | undefined) => {
    const position = rangePosition(value, low, high);
    if (position === null) return <Text style={styles.missing}>No range in this read</Text>;
    return (
      <View style={styles.range}>
        <View style={styles.track}>
          <View style={[styles.knob, { left: `${position}%` }]} />
        </View>
        <View style={styles.ends}>
          <Text style={[styles.endText, { color: colors.down }]}>{formatNumber(low)}</Text>
          <Text style={[styles.endText, { color: colors.up }]}>{formatNumber(high)}</Text>
        </View>
      </View>
    );
  };

  if (!symbol) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>No symbol was passed to this screen.</Text>
        <TouchableOpacity style={styles.retry} onPress={goBack}>
          <Text style={styles.retryText}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const depth = Math.min(LADDER_ROWS, Math.max(book.bids.length, book.asks.length));

  return (
    <View style={styles.container}>
      <View style={styles.head}>
        <TouchableOpacity onPress={goBack} hitSlop={10} accessibilityLabel="Go back">
          <Ionicons name="arrow-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headMain}>
          <Text style={styles.symbol}>{symbol}</Text>
          <Text style={styles.meta}>
            {`EQ · ${exchange}`}
            {heldQty !== null ? ` · Held ${formatQuantity(heldQty)} sh` : ""}
          </Text>
          {quote?.name && quote.name.toUpperCase() !== symbol ? <Text style={styles.name}>{quote.name}</Text> : null}
        </View>
        <View style={styles.priceBox}>
          <Text style={styles.ltp}>{shown(quote?.ltp) ?? "No price"}</Text>
          <Text style={[styles.change, { color: tone(quote?.change) }]}>{signed(quote?.change)}</Text>
          <View style={styles.badge}>
            <View style={[styles.dot, { backgroundColor: provenance.live ? colors.up : colors.amber }]} />
            <Text style={styles.badgeText}>
              {provenance.word}
              {provenance.date && !provenance.live ? ` · ${formatISTDate(provenance.date)}` : ""}
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.tabs}>
        <View style={[styles.tab, styles.tabOn]}>
          <Text style={[styles.tabLabel, styles.tabLabelOn]}>Overview</Text>
        </View>
        {!chainTab ? (
          <View style={styles.tab} accessibilityLabel={`Option Chain is not listed for ${symbol}`} accessibilityState={{ disabled: true }}>
            <Text style={[styles.tabLabel, styles.tabLabelOff]}>Option Chain</Text>
          </View>
        ) : (
          <TouchableOpacity style={styles.tab} onPress={() => router.push(`/(tabs)/option-chain?symbol=${encodeURIComponent(symbol)}`)}>
            <Text style={styles.tabLabel}>Option Chain</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={styles.tab}
          onPress={() => router.push(`/terminal-charts?symbol=${encodeURIComponent(`${exchange === "BSE" ? "BSE" : "NSE"}:${symbol}`)}`)}
        >
          <Text style={styles.tabLabel}>Chart</Text>
        </TouchableOpacity>
      </View>

      {!chainTab ? (
        <Text style={styles.tabNote}>
          {`No listed options for ${exchange}:${symbol}. Option chains cover F&O stocks and indices.`}
        </Text>
      ) : null}

      {waiting || priced ? null : (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>No price on this read yet.</Text>
          <Text style={styles.noticeReason}>
            {refusal ?? "Neither the paced quote read nor this account's feed has priced this stock."}
          </Text>
          <TouchableOpacity style={styles.noticeAction} onPress={() => refetch()} disabled={isFetching}>
            <Text style={styles.noticeActionText}>{isFetching ? "Trying…" : "Try again"}</Text>
          </TouchableOpacity>
        </View>
      )}

      {waiting ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          <View style={styles.chips}>
            <TouchableOpacity style={styles.chip} onPress={toggleList} disabled={busy}>
              <Ionicons name={inList ? "star" : "star-outline"} size={13} color={colors.amber} />
              <Text style={styles.chipText}>
                {busy ? "Working…" : inList ? `In Watchlist ${listNumber} · remove` : `Add to Watchlist ${listNumber}`}
              </Text>
            </TouchableOpacity>
            {other && shown(cross?.ltp) !== null ? (
              <TouchableOpacity style={[styles.chip, styles.chipGhost]} onPress={() => setExchange(other)}>
                <Text style={[styles.chipText, styles.chipTextGhost]}>
                  {`${other} ${formatNumber(cross?.ltp)} ${signed(cross?.changePct)}%`}
                </Text>
              </TouchableOpacity>
            ) : null}
            {isFetching && quote ? <Text style={styles.meta}>refreshing</Text> : null}
          </View>

          <View style={styles.card}>
            <View style={styles.ladderHead}>
              <Text style={styles.ladderHeadQty}>Qty</Text>
              <Text style={styles.ladderHeadPx}>Bid</Text>
              <Text style={styles.ladderHeadPx}>Offer</Text>
              <Text style={[styles.ladderHeadQty, { textAlign: "right" }]}>Qty</Text>
            </View>
            {depth === 0 ? (
              <Text style={[styles.stampText, { marginTop: 10 }]}>
                {quote?.depthMessage ?? "The broker has not sent a book for this symbol yet."}
              </Text>
            ) : Array.from({ length: depth }, (_, index) => {
              const bid = book.bids[index];
              const ask = book.asks[index];
              return (
                <View key={index} style={styles.ladderRow}>
                  <Text style={[styles.ladderQty, { color: colors.up }]}>{bid ? formatQuantity(bid.quantity) : ""}</Text>
                  <Text style={[styles.ladderPx, { color: colors.up }]}>{bid ? formatNumber(bid.price) : ""}</Text>
                  <Text style={[styles.ladderPx, { color: colors.down }]}>{ask ? formatNumber(ask.price) : ""}</Text>
                  <Text style={[styles.ladderQty, { color: colors.down, textAlign: "right" }]}>{ask ? formatQuantity(ask.quantity) : ""}</Text>
                </View>
              );
            })}

            {book.bidShare !== null ? (
              <>
                <View style={styles.split}>
                  <Text style={styles.splitText}>Bid</Text>
                  <Text style={styles.splitText}>Offer</Text>
                </View>
                <View style={styles.meter}>
                  <View style={[styles.meterBid, { flex: book.bidShare }]}>
                    <Text style={styles.meterText}>{`${book.bidShare.toFixed(1)}%`}</Text>
                  </View>
                  <View style={[styles.meterAsk, { flex: 100 - book.bidShare }]}>
                    <Text style={styles.meterText}>{`${(100 - book.bidShare).toFixed(1)}%`}</Text>
                  </View>
                </View>
                <View style={styles.totals}>
                  <Text style={styles.totalsText}>{`TBQ ${formatQuantity(book.tbq)}`}</Text>
                  <Text style={styles.totalsText}>{`${formatQuantity(book.tsq)} TSQ`}</Text>
                </View>
              </>
            ) : null}

            {stamp.time ? (
              <View style={styles.stamp}>
                <View style={[styles.dot, { backgroundColor: stamp.live ? colors.up : colors.amber }]} />
                <Text style={styles.stampText}>
                  {`${stamp.live ? "Full book" : "Top of book only"} · stamped ${stamp.time} IST`}
                </Text>
              </View>
            ) : null}
            {stamp.reason ? <Text style={styles.reason}>{stamp.reason}</Text> : null}
          </View>

          <View style={styles.card}>
            <View style={styles.grid2}>
              <View style={styles.cell}>
                <Text style={styles.lab}>OPEN</Text>
                {figure(quote?.open)}
              </View>
              <View style={styles.cell}>
                <Text style={styles.lab}>TODAY'S RANGE</Text>
                {range(quote?.ltp, quote?.low, quote?.high)}
              </View>
            </View>
            <View style={[styles.grid2, { marginTop: 14 }]}>
              <View style={styles.cell}>
                <Text style={styles.lab}>PREV. CLOSE</Text>
                {figure(quote?.close)}
              </View>
              <View style={styles.cell}>
                <Text style={styles.lab}>52 WEEK</Text>
                {range(quote?.ltp, quote?.low52, quote?.high52)}
              </View>
            </View>
          </View>

          <View style={styles.card}>
            <View style={styles.stats}>
              <View style={styles.cell}>
                <Text style={styles.lab}>VOLUME</Text>
                <Text style={styles.smallVal}>{quote?.volume ? formatQuantity(quote.volume) : "Not sent"}</Text>
              </View>
              <View style={styles.cell}>
                <Text style={styles.lab}>AVG. TRADED PRICE</Text>
                <Text style={styles.smallVal}>{shown(quote?.averagePrice) ?? "Not sent"}</Text>
              </View>
              <View style={styles.cell}>
                <Text style={styles.lab}>CHANGE</Text>
                <Text style={[styles.smallVal, { color: tone(quote?.changePct) }]}>
                  {quote?.changePct === null || quote?.changePct === undefined
                    ? "Not sent"
                    : `${quote.changePct > 0 ? "+" : ""}${formatNumber(quote.changePct)}%`}
                </Text>
              </View>
            </View>
          </View>
        </ScrollView>
      )}

      <View style={styles.foot}>
        <TouchableOpacity style={[styles.action, { backgroundColor: "#16a34a" }]} onPress={() => openTicket("BUY")}>
          <Text style={styles.actionText}>Buy</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.action, { backgroundColor: "#dc2626" }]} onPress={() => openTicket("SELL")}>
          <Text style={styles.actionText}>Sell</Text>
        </TouchableOpacity>
      </View>

      {/* Mounted only while a ticket is open, as on the watchlist and portfolio, so every press seeds
          the sheet from this symbol instead of the previous one's half-typed quantity. */}
      {ticket.visible ? <BuySheet ticket={ticket} /> : null}
    </View>
  );
}
