/**
 * Watchlist screen
 *
 * Everything here is prod data: the built-in lists NSE publishes, the user's own five lists, and the
 * search that adds to them. The index strip that used to head this screen is on every screen now.
 *
 * A REST read prices the list once, so a row that only ever comes from one is a number from the moment that
 * read happened. The prices that move are the ones this screen subscribes to on prod's tick stream, by the
 * canonical id the stream parses for that exchange and symbol; only a price the server published as fresh
 * marks a row, and a marked row says so in its own colour.
 */

import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  BUILTIN_LISTS,
  markWatchlist,
  queryKeys,
  streamIdFor,
  useQuoteFeed,
  type BuiltinListName,
  type Marked,
  type WatchlistInfo,
  type WatchlistRow,
} from "@nraialgo/shared/api";
import { useOrderTicket } from "@nraialgo/shared/hooks";
import { formatNumber } from "@nraialgo/shared/utils";
import { useAuthStore } from "@nraialgo/shared/stores";
import { BuySheet } from "@/components/BuySheet";
import { WatchlistManager } from "@/components/WatchlistManager";
import { useTheme } from "@/components/ThemeProvider";
import { useApi } from "@/hooks/useApi";

type Tab = { kind: "predefined" } | { kind: "list"; number: number };

const SEGMENT: Record<string, string> = { NSE: "NSE EQ", BSE: "BSE EQ" };

const WATCHLIST_ROW_HEIGHT = 65;

export default function WatchlistScreen() {
  const { useIndices, useWatchlist, useBuiltinWatchlist, useEquitySearch,
    useAddToWatchlist, useRemoveFromWatchlist, useCreateWatchlist } = useApi();
  const { resolvedTheme } = useTheme();
  const ticket = useOrderTicket();
  // The stream is a signed-in, per-workspace connection: registered while it can answer, never while it
  // would be refused, and one socket for the whole app rather than one per screen.
  const { isAuthenticated, user, accessToken } = useAuthStore();
  const authenticated = isAuthenticated || !!user || !!accessToken;

  const [tab, setTab] = useState<Tab>({ kind: "predefined" });
  const [builtin, setBuiltin] = useState<BuiltinListName>("nifty_50");
  const [page, setPage] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  // Which row the open sheet may also take out of this list. Kept beside the ticket rather than
  // inside it, because the ticket is shared and knows nothing about lists.
  const [removable, setRemovable] = useState<{ exchange: string; symbol: string } | null>(null);

  // Adding from the Predefined tab targets the list tab the owner last opened, so switching to
  // the reference list does not silently retarget the add into List 1.
  const [lastList, setLastList] = useState(1);
  const listNumber = tab.kind === "list" ? tab.number : lastList;

  const { data: strip } = useIndices();
  const { data: saved, error: savedError } = useWatchlist(listNumber);
  const { data: builtins, error: builtinError } = useBuiltinWatchlist(builtin, page, {
    queryKey: queryKeys.watchlist.builtin(builtin, page),
    enabled: tab.kind === "predefined",
  });
  const { data: found } = useEquitySearch(debouncedSearch);
  const add = useAddToWatchlist();
  const drop = useRemoveFromWatchlist();
  const create = useCreateWatchlist();

  const colors = useMemo(() => resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#94a3b8", border: "#334155", brand: "#38bdf8" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", brand: "#0284c7" }, [resolvedTheme]);
  const up = resolvedTheme === "dark" ? "#22c55e" : "#16a34a";
  const down = "#ef4444";

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    tabs: { flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.bg },
    tab: { paddingHorizontal: 14, paddingVertical: 12 },
    tabLabel: { fontSize: 14, fontWeight: "600", color: colors.muted },
    tabOn: { borderBottomWidth: 2, borderBottomColor: colors.brand },
    tabLabelOn: { color: colors.text },
    iconButton: { paddingHorizontal: 12, paddingVertical: 12 },
    bar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
    dropdown: {
      flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between",
      backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 8,
      paddingHorizontal: 12, paddingVertical: 10,
    },
    dropdownText: { fontSize: 14, fontWeight: "600", color: colors.text },
    option: { backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.border, paddingHorizontal: 16, paddingVertical: 12 },
    optionText: { fontSize: 14, color: colors.text },
    search: {
      flex: 1, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 8,
      paddingHorizontal: 12, paddingVertical: 9, color: colors.text, fontSize: 15,
    },
    counter: { fontSize: 12, color: colors.muted },
    status: { paddingHorizontal: 14, paddingBottom: 8, fontSize: 12, color: colors.muted },
    row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: colors.border },
    left: { flex: 1, paddingRight: 8 },
    symbol: { fontSize: 15, fontWeight: "600", color: colors.text },
    segment: { fontSize: 11, color: colors.muted, marginTop: 2 },
    middle: { flex: 1.1, paddingRight: 8 },
    name: { fontSize: 12, color: colors.muted },
    right: { alignItems: "flex-end", minWidth: 86 },
    price: { fontSize: 15, fontWeight: "700" },
    change: { fontSize: 11, marginTop: 1 },
    noPrice: { fontSize: 12, color: colors.muted },
    action: { paddingLeft: 10, paddingVertical: 4 },
    pager: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 12 },
    pagerButton: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
    pagerText: { fontSize: 13, fontWeight: "600", color: colors.text },
    pagerLabel: { fontSize: 12, color: colors.muted },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40, gap: 10 },
    empty: { fontSize: 14, color: colors.muted, textAlign: "center", lineHeight: 21 },
    error: { paddingHorizontal: 14, paddingTop: 12, fontSize: 13, color: down },
  }), [colors, down]);

  const maxLists = saved?.maxLists ?? 5;
  // Prod's `lists` only carries the slots that already hold rows or a saved name, so an empty
  // slot would vanish. The web dock always shows all five, so the tabs are filled from the
  // server's own maximum and prod's counts patch into the matching numbers.
  const lists: WatchlistInfo[] = Array.from({ length: maxLists }, (_, index) =>
    saved?.lists?.find(info => info.number === index + 1) ?? { number: index + 1, count: 0 });
  const limit = saved?.limit ?? 50;
  const label = (info: WatchlistInfo) => info.name || `Watchlist ${info.number}`;
  const inList = new Set((saved?.items ?? []).map(row => `${row.exchange}:${row.symbol}`));

  const priceTone = (change: number | null) => (change === null ? colors.text : change > 0 ? up : change < 0 ? down : colors.text);

  const fail = (message: string) => Alert.alert("Not changed", message);

  const signed = (value: number | null) => (value === null ? "—" : `${value > 0 ? "+" : ""}${formatNumber(value)}`);

  const addTo = (row: { exchange: string; symbol: string; name?: string }) => {
    add.mutate(
      { exchange: row.exchange, symbol: row.symbol, list: listNumber },
      { onSuccess: () => setSearch(""), onError: error => fail(error.message) },
    );
  };

  // Prod sends every instruction as a limit, so the ticket opens with an empty price and the ask
  // and bid shown under it, rather than a number this app invented. The product is set here because
  // the ticket keeps the last one used, and an options ticket would otherwise leak NRML into a cash
  // stock, which the broker refuses.
  // `removable` marks the rows the sheet can also take out of this list, so trading and editing the
  // list happen in the one popup instead of a system dialog.
  const openBuy = (
    row: { exchange: string; symbol: string },
    side: "BUY" | "SELL" = "BUY",
    removable = false,
  ) => {
    setRemovable(removable ? { exchange: row.exchange, symbol: row.symbol } : null);
    ticket.open({
      symbol: row.symbol,
      exchange: row.exchange,
      product: row.exchange === "NSE" || row.exchange === "BSE" ? "CNC" : "NRML",
      side,
      quantity: 1,
      orderType: "LIMIT",
      price: 0,
      source: "watchlist",
      tag: `watchlist:${row.symbol}`,
    });
  };

  const removeFromList = () => {
    if (!removable) return;
    drop.mutate({ ...removable, list: listNumber }, {
      onSuccess: () => ticket.close(),
      onError: error => fail(error.message),
    });
  };

  const createList = () =>
    create.mutate(undefined, {
      onSuccess: created => {
        setLastList(created.list);
        setTab({ kind: "list", number: created.list });
        setManagerOpen(false);
      },
      onError: error => fail(error.message),
    });

  const stripLive = strip?.marketOpen === true && strip.indices.some(row => row.status === "live");
  // The strip carries its own quote timestamps, so the screen can say which session a
  // quiet price came from without asking prod for a second, unrelated snapshot.
  const stripAt = strip?.indices.map(row => row.at).find(iso => iso !== null) ?? null;
  const statusLine = strip
    ? `${strip.marketOpen ? "Market open" : "Market closed"} · ${strip.provider}` +
      (stripLive ? " · live" : stripAt ? ` · price ${stripAt.slice(0, 10)}` : "")
    : "Loading the index strip";

  const rows = tab.kind === "predefined" ? builtins?.items ?? [] : saved?.items ?? [];
  // Watchlist rows are cash instruments, so each one's stream id comes straight from the exchange and symbol
  // prod sent beside it. An exchange the stream does not publish builds no id and is never subscribed: one
  // subscription the server cannot parse closes the socket for the whole app, not just this row.
  const instruments = useMemo(() => [...new Set(rows.map((row) => streamIdFor({
    exchange: row.exchange, symbol: row.symbol, product: "CASH", expiry: null, strike: null, right: null,
  })).filter((id): id is string => !!id))].sort(), [rows]);
  const feed = useQuoteFeed(instruments, authenticated && instruments.length > 0);
  const liveRows = useMemo(() => markWatchlist(rows, feed.quotes), [rows, feed.quotes]);
  const ticking = liveRows.some(row => row.live);
  // Prod returns a list's symbols before it has finished pricing them, so an empty price here
  // usually means "still being read" rather than "this stock has no price". Say which.
  const pricesPending = (tab.kind === "predefined" ? builtins?.pricesPending : saved?.pricesPending) === true;
  const busy = tab.kind === "predefined" ? !builtins && !builtinError : !saved && !savedError;
  const pages = builtins?.total && builtins.pageSize ? Math.ceil(builtins.total / builtins.pageSize) : 1;
  // A socket that is open but has sent no usable price is not a quiet market the app can prove, so the line
  // says which of the three states this list is in instead of leaving one word to cover all of them. An empty
  // list subscribes to nothing, so it gets no stream word at all.
  const streamWord = instruments.length === 0
    ? null
    : ticking ? "ticking" : feed.connected ? "waiting for ticks" : "no live stream";
  const listLine = pricesPending ? `${statusLine} · prices for this list are still arriving` : statusLine;

  const renderRow = ({ item }: { item: WatchlistRow & Marked }) => {
    const already = inList.has(`${item.exchange}:${item.symbol}`);
    return (
      <TouchableOpacity
        style={styles.row}
        onPress={() => (tab.kind === "predefined" ? (already ? openBuy(item, "BUY", true) : addTo(item)) : openBuy(item, "BUY", true))}
        disabled={add.isPending}
      >
        <View style={styles.left}>
          <Text style={styles.symbol}>{item.symbol}</Text>
          <Text style={styles.segment}>{SEGMENT[item.exchange] ?? item.exchange}</Text>
        </View>
        <View style={styles.middle}>
          {item.name && item.name !== item.symbol ? <Text style={styles.name} numberOfLines={1}>{item.name}</Text> : null}
        </View>
        <View style={styles.right}>
          {item.ltp === null ? (
            <Text style={styles.noPrice}>{pricesPending ? "Waiting for price" : "No price"}</Text>
          ) : (
            <>
              <Text style={[styles.price, { color: priceTone(item.change) }]}>{formatNumber(item.ltp)}</Text>
              <Text style={[styles.change, { color: priceTone(item.change) }]}>
                {item.change === null ? "no change figure" : `${signed(item.change)} (${signed(item.changePct)}%)`}
              </Text>
            </>
          )}
        </View>
        {tab.kind === "predefined" ? (
          // The row itself adds the symbol to the list; this mark is the buy entry point, so a row
          // that is already saved still has a way to open a ticket.
          <TouchableOpacity style={styles.action} onPress={() => openBuy(item, "BUY", already)} hitSlop={12}>
            <Ionicons name={already ? "checkmark-circle" : "add-circle-outline"} size={22} color={already ? up : colors.brand} />
          </TouchableOpacity>
        ) : (
          // A saved row trades and un-saves from the sheet the row opens, so this only marks that
          // the row is pressable. The three figures it used to hide are all in the sheet now.
          <View style={styles.action}>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* The index strip itself is no longer here: the root layout paints it above every route. */}
      <View style={styles.tabs}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <TouchableOpacity style={[styles.tab, tab.kind === "predefined" && styles.tabOn]} onPress={() => setTab({ kind: "predefined" })}>
            <Text style={[styles.tabLabel, tab.kind === "predefined" && styles.tabLabelOn]}>Predefined</Text>
          </TouchableOpacity>
          {lists.map(info => (
            <TouchableOpacity key={info.number} style={[styles.tab, tab.kind === "list" && tab.number === info.number && styles.tabOn]} onPress={() => { setLastList(info.number); setTab({ kind: "list", number: info.number }); }}>
              <Text style={[styles.tabLabel, tab.kind === "list" && tab.number === info.number && styles.tabLabelOn]}>{label(info)}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <View style={{ flex: 1 }} />
        <TouchableOpacity style={styles.iconButton} onPress={() => setManagerOpen(true)}>
          <Ionicons name="settings-outline" size={20} color={colors.muted} />
        </TouchableOpacity>
      </View>

      {tab.kind === "predefined" ? (
        <>
          <View style={styles.bar}>
            <TouchableOpacity style={styles.dropdown} onPress={() => setPickerOpen(open => !open)}>
              <Text style={styles.dropdownText}>
                {BUILTIN_LISTS.find(entry => entry.name === builtin)?.label ?? builtin}
              </Text>
              <Ionicons name={pickerOpen ? "chevron-up" : "chevron-down"} size={18} color={colors.muted} />
            </TouchableOpacity>
          </View>
          {pickerOpen ? (
            BUILTIN_LISTS.map(entry => (
              <TouchableOpacity
                key={entry.name}
                style={styles.option}
                onPress={() => { setBuiltin(entry.name); setPage(0); setPickerOpen(false); }}
              >
                <Text style={[styles.optionText, entry.name === builtin && { color: colors.brand, fontWeight: "700" }]}>
                  {entry.label}
                </Text>
              </TouchableOpacity>
            ))
          ) : null}
        </>
      ) : (
        <View style={styles.bar}>
          <TextInput
            style={styles.search}
            placeholder="Search and add a symbol"
            placeholderTextColor={colors.muted}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          <Text style={styles.counter}>{`${saved?.items.length ?? 0}/${limit}`}</Text>
        </View>
      )}

      <Text style={styles.status}>{streamWord ? `${listLine} · ${streamWord}` : listLine}</Text>
      {savedError || builtinError ? (
        <Text style={styles.error}>{String((savedError ?? builtinError)?.message ?? "The watchlist could not be read.")}</Text>
      ) : null}

      {debouncedSearch.length >= 2 && found?.results.length ? (
        <View>
          {found.results.map(hit => (
            <TouchableOpacity key={`${hit.exchange}:${hit.symbol}`} style={styles.option} onPress={() => addTo(hit)} disabled={add.isPending}>
              <Text style={styles.optionText}>
                {hit.symbol} · {hit.exchange} · {inList.has(`${hit.exchange}:${hit.symbol}`) ? "already in this list" : "add to this list"}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}

      {busy ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>
            {tab.kind === "predefined"
              ? "This list has no symbols yet."
              : "Nothing in this list yet.\nSearch above to add a symbol, or add one from the Predefined tab."}
          </Text>
        </View>
      ) : (
        <FlatList
          data={liveRows}
          keyExtractor={item => `${item.exchange}:${item.symbol}`}
          renderItem={renderRow}
          initialNumToRender={15}
          maxToRenderPerBatch={15}
          windowSize={7}
          getItemLayout={(_, index) => ({
            length: WATCHLIST_ROW_HEIGHT,
            offset: WATCHLIST_ROW_HEIGHT * index,
            index,
          })}
          ListFooterComponent={
            <>
              {tab.kind === "predefined" && pages > 1 ? (
                <View style={styles.pager}>
                  <TouchableOpacity style={styles.pagerButton} onPress={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>
                    <Text style={styles.pagerText}>Previous</Text>
                  </TouchableOpacity>
                  <Text style={styles.pagerLabel}>{`Page ${page + 1} of ${pages}`}</Text>
                  <TouchableOpacity style={styles.pagerButton} onPress={() => setPage(p => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1}>
                    <Text style={styles.pagerText}>Next</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </>
          }
        />
      )}

      {/* Mounted only while a ticket is open, so every press seeds the sheet from that row instead
          of leaving the previous symbol's typed quantity and price on screen. */}
      {ticket.visible ? <BuySheet ticket={ticket} onRemove={removable ? removeFromList : undefined} isRemoving={drop.isPending} /> : null}

      <WatchlistManager
        visible={managerOpen}
        onClose={() => setManagerOpen(false)}
        lists={lists}
        maxLists={maxLists}
        activeList={listNumber}
        onSelect={number => { setLastList(number); setTab({ kind: "list", number }); setManagerOpen(false); }}
        onCreate={createList}
      />
    </View>
  );
}
