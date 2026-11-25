/**
 * Option Chain Screen - NIFTY by default, searchable across every index and F&O stock.
 *
 * Everything here is prod data: /v1/option-chain answers the whole expiry ladder with the chain, so
 * the picker is never left waiting on a second route. The date the desk last showed is kept on the
 * device, so a launch asks the broker for the contract the trader was actually looking at instead of
 * paying for the server's front expiry first and the month-end one after it.
 *
 * One ladder read costs the broker seconds, so the strikes on screen also go on the price stream the app
 * already holds, and their premiums paint from the ticks that arrive between reads - see api/chain-ticks.ts.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import {
  liveSide,
  nearestMonthlyExpiry,
  QUALITY_WORD,
  queryKeys,
  strikeIds,
  streamId,
  tickBeats,
  tickByInstrument,
  tickWord,
  todayIST,
  useQuoteFeed,
  pauseQuoteDispatch,
  resumeQuoteDispatch,
  watchBand,
  type Band,
  type OptionRow,
  type QuoteTick,
  type UnderlyingInfo,
} from "@nraialgo/shared/api";
import { useOrderTicket } from "@nraialgo/shared/hooks";
import { useTradingStore } from "@nraialgo/shared/stores";
import { formatNumber } from "@nraialgo/shared/utils";
import { useTheme } from "@/components/ThemeProvider";
import { BuySheet } from "@/components/BuySheet";
import { useApi } from "@/hooks/useApi";

/** Prod sends prices as decimal strings so nothing rounds on the way here; the ticket takes numbers. */
function amount(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** How long ago these prices landed, so a date the trader is not watching never looks live when it is not. */
function readAge(ms: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 1) return "read just now";
  if (mins < 60) return `read ${mins} min ago`;
  return `read ${Math.round(mins / 60)} h ago`;
}

/**
 * The exchange publishes a strike grid far wider than the contracts it lists on it, so a full-ladder
 * read is mostly rows with no contract on either side. Those rows have no price to show and no trade to
 * place, and a screen of them is what made the chain look unpriced, so only strikes the server actually
 * quoted are put on the list.
 */
const listedRows = (rows: readonly OptionRow[]) => rows.filter(row => row.call || row.put);

/**
 * Every part of the ladder has one height it never changes. That is what lets the list jump straight to
 * a strike and paint only the rows around it: a list whose rows can be any height has to lay out, mount
 * and measure everything above the requested position first, and on a 250-strike grid that is exactly the
 * seconds the trader was waiting for with the screen half drawn.
 */
const ROW_HEIGHT = 84;
const SECTION_HEIGHT = 40;
const STATUS_HEIGHT = 40;
const itemHeight = (item: ChainItem) => (item.kind === "row" ? ROW_HEIGHT : SECTION_HEIGHT);

/** One line in the list: a date's own heading, one of its strikes, or the state of a date still reading. */
type ChainItem =
  | { kind: "section"; key: string; expiry: string; lotSize: number | null; readAt: number }
  | { kind: "row"; key: string; expiry: string; row: OptionRow }
  | { kind: "pending"; key: string; expiry: string }
  | { kind: "failed"; key: string; expiry: string; message: string };

const SELECTION_KEY = "nraialgo.chain-selection";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Strikes held on the price stream beyond the ones actually on screen. Small enough that one band is a
 * couple of dozen contracts, large enough that reading up and down the ladder does not re-subscribe.
 */
const BAND_PAD = 6;

/** What no ticks means on the ladder: every number is the chain read's own, with its own label. */
const NO_TICKS = new Map<string, QuoteTick>();

/**
 * The contract the desk last showed, as far as the device can still remember it. A date that has already
 * settled is dropped rather than resumed, because the broker has no ladder left to answer it with.
 */
function parseSelection(raw: string | null): { underlying: string; expiry: string } | null {
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as { underlying?: unknown; expiry?: unknown };
    const underlying = typeof saved.underlying === "string" ? saved.underlying : "";
    const expiry = typeof saved.expiry === "string" ? saved.expiry : "";
    if (!underlying || !ISO_DATE.test(expiry) || expiry < todayIST()) return null;
    return { underlying, expiry };
  } catch {
    return null;
  }
}

interface OptionRowItemProps {
  row: OptionRow;
  expiry: string;
  styles: Record<string, any>;
  liveCall?: QuoteTick;
  livePut?: QuoteTick;
  onTrade: (onExpiry: string, row: OptionRow, right: "CE" | "PE") => void;
}

const OptionRowItem = React.memo(function OptionRowItem({
  row,
  expiry,
  styles,
  liveCall,
  livePut,
  onTrade,
}: OptionRowItemProps) {
  const callQuote = row.call;
  const putQuote = row.put;
  const callPrice = callQuote ? liveSide(callQuote, liveCall) : null;
  const putPrice = putQuote ? liveSide(putQuote, livePut) : null;
  const callOiChange = callQuote?.oiChangePct;
  const putOiChange = putQuote?.oiChangePct;

  return (
    <View style={[styles.tableRow, row.isAtTheMoney && styles.tableRowAtm]}>
      <View style={[styles.cell, styles.callCell]}>
        {!callQuote ? (
          <>
            <Text style={styles.noPrice}>Not listed</Text>
            <TouchableOpacity style={styles.actionButton} onPress={() => onTrade(expiry, row, "CE")}>
              <Text style={styles.actionButtonText}>Trade</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            {callPrice === null ? <Text style={styles.noPrice}>No price</Text> : <Text style={styles.priceText}>{formatNumber(callPrice.price)}</Text>}
            <Text style={styles.metaText} numberOfLines={1}>
              {callPrice?.word ? `${callPrice.word}  ·  ` : ""}
              {callQuote.iv === null ? "No IV" : `IV ${formatNumber(callQuote.iv, 1)}%`}
              {callQuote.oi === null ? "" : `  ·  OI ${formatNumber(callQuote.oi, 0)}`}
              {callOiChange !== null && callOiChange !== 0 ? (
                <Text style={callOiChange > 0 ? styles.oiChangePos : styles.oiChangeNeg}>
                  {`  ·  ${callOiChange > 0 ? "+" : ""}${formatNumber(callOiChange, 1)}%`}
                </Text>
              ) : null}
            </Text>
            <TouchableOpacity style={styles.actionButton} onPress={() => onTrade(expiry, row, "CE")}>
              <Text style={styles.actionButtonText}>Trade</Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      <View style={[styles.cell, styles.strikeCell]}>
        <Text style={styles.strikeText}>{formatNumber(Number(row.strike), 0)}</Text>
        {row.isAtTheMoney ? <Text style={styles.atmTag}>ATM</Text> : null}
      </View>

      <View style={[styles.cell, styles.putCell]}>
        {!putQuote ? (
          <>
            <Text style={styles.noPrice}>Not listed</Text>
            <TouchableOpacity style={styles.actionButton} onPress={() => onTrade(expiry, row, "PE")}>
              <Text style={styles.actionButtonText}>Trade</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            {putPrice === null ? <Text style={styles.noPrice}>No price</Text> : <Text style={styles.priceText}>{formatNumber(putPrice.price)}</Text>}
            <Text style={styles.metaText} numberOfLines={1}>
              {putPrice?.word ? `${putPrice.word}  ·  ` : ""}
              {putQuote.iv === null ? "No IV" : `IV ${formatNumber(putQuote.iv, 1)}%`}
              {putQuote.oi === null ? "" : `  ·  OI ${formatNumber(putQuote.oi, 0)}`}
              {putOiChange !== null && putOiChange !== 0 ? (
                <Text style={putOiChange > 0 ? styles.oiChangePos : styles.oiChangeNeg}>
                  {`  ·  ${putOiChange > 0 ? "+" : ""}${formatNumber(putOiChange, 1)}%`}
                </Text>
              ) : null}
            </Text>
            <TouchableOpacity style={styles.actionButton} onPress={() => onTrade(expiry, row, "PE")}>
              <Text style={styles.actionButtonText}>Trade</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
});

export default function OptionChainScreen() {
  const { useOptionChain, useOptionChains, useChainUnderlyings } = useApi();
  const { resolvedTheme } = useTheme();
  const {
    optionChain: { underlying, expiry },
    setOptionChainUnderlying,
    setOptionChainExpiry,
    setOptionChainFilters,
  } = useTradingStore();

  // One ticket object, handed to the sheet: the sheet renders from `ticket.visible`, so a screen that
  // opened a ticket without rendering it would press and show nothing at all.
  const ticket = useOrderTicket();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [expiryOpen, setExpiryOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [allExpiries, setAllExpiries] = useState(false);
  const [resumed, setResumed] = useState(false);

  // The saved contract is read off the device before the first chain read is asked for. Waiting for that
  // costs milliseconds, while starting without it costs a whole broker read for a date about to be replaced.
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(SELECTION_KEY)
      .then(raw => {
        const saved = parseSelection(raw);
        if (alive && saved) setOptionChainFilters(saved);
      })
      .catch(() => {
        // A desk that cannot read its own memory opens the way it did before the memory existed.
      })
      .finally(() => {
        if (alive) setResumed(true);
      });
    return () => {
      alive = false;
    };
  }, [setOptionChainFilters]);

  // An empty expiry is a question, not a missing value: the server returns its nearest listed expiry.
  const { data: chain, error, refetch, isFetching, isLoading } = useOptionChain(underlying, expiry, { enabled: resumed && !!underlying });

  /**
   * A press on a stock's "Option Chain" tab carries its symbol, and the deep link has always promised the
   * same. It is applied once the saved selection has been read back, because that read lands a few
   * milliseconds later and would otherwise quietly replace the underlying the trader just chose.
   */
  const seeded = String(useLocalSearchParams<{ symbol?: string }>().symbol ?? "").trim().toUpperCase();
  const seedApplied = useRef(false);
  useEffect(() => {
    if (!resumed || !seeded || seedApplied.current) return;
    seedApplied.current = true;
    setOptionChainUnderlying(seeded);
  }, [resumed, seeded, setOptionChainUnderlying]);

  // Every listed date of this underlying, each cached exactly as a single-expiry read would be. The hook
  // is called unconditionally and asked for nothing outside the all-expiries view.
  const sections = useOptionChains(underlying, chain?.expiries ?? [], allExpiries);

  // A desk displays the nearest expiry or user-chosen expiry. The nearest monthly expiry is tagged in the picker.
  const isMatchingChain = Boolean(chain && chain.underlying === underlying);
  const monthly = isMatchingChain && chain ? nearestMonthlyExpiry(chain.expiries, todayIST()) : "";
  const derivedFor = useRef("");
  useEffect(() => {
    if (!chain || chain.underlying !== underlying || expiry || derivedFor.current === chain.underlying) return;
    derivedFor.current = chain.underlying;
    // Align expiry with server-returned nearest expiry to avoid redundant second network round-trip
    if (chain.expiry) setOptionChainExpiry(chain.expiry);
  }, [chain, underlying, expiry, setOptionChainExpiry]);

  // What makes the next launch a single read. It is written from the chain that arrived, not from the
  // ask, so a date the server corrected is never remembered as the one that was wanted.
  useEffect(() => {
    if (!chain || chain.underlying !== underlying) return;
    AsyncStorage.setItem(SELECTION_KEY, JSON.stringify({ underlying: chain.underlying, expiry: chain.expiry })).catch(() => {});
  }, [chain?.underlying, chain?.expiry, underlying]);

  // One list either way: the strikes of the chosen date, or every listed date with its own heading and its
  // own read, so a date that is still arriving or that failed shows that instead of vanishing. It is built
  // here rather than in the render body because the price stream below subscribes by position in it.
  const items = useMemo<ChainItem[]>(() => {
    if (!chain || chain.underlying !== underlying) return [];
    if (!allExpiries) {
      return listedRows(chain.rows).map(row => ({ kind: "row" as const, key: `${chain.expiry}|${row.strike}`, expiry: chain.expiry, row }));
    }
    return chain.expiries.flatMap<ChainItem>((day, index) => {
      const read = sections[index];
      const heading: ChainItem = { kind: "section", key: `section-${day}`, expiry: day, lotSize: read?.data?.lotSize ?? null, readAt: read?.dataUpdatedAt ?? 0 };
      if (!read?.data) {
        return read?.isError
          ? [heading, { kind: "failed" as const, key: `failed-${day}`, expiry: day, message: read.error.message }]
          : [heading, { kind: "pending" as const, key: `pending-${day}`, expiry: day }];
      }
      return [heading, ...listedRows(read.data.rows).map(row => ({ kind: "row" as const, key: `${day}|${row.strike}`, expiry: day, row }))];
    });
  }, [chain, underlying, sections, allExpiries]);

  // The ladder's own numbers arrive one broker read at a time, so between reads the screen would otherwise
  // freeze. The strikes the trader is looking at go on the app's existing price stream, keyed by the
  // identity each row already carries, and their premiums paint from the ticks that come back.
  const itemsRef = useRef<ChainItem[]>(items);
  itemsRef.current = items;
  const [band, setBand] = useState<Band | null>(null);
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: readonly { index?: number | null }[] }) => {
    const visible = viewableItems
      .map(token => token.index)
      .filter((index): index is number => typeof index === "number" && itemsRef.current[index]?.kind === "row");
    // A band that already covers the screen answers with the same object, so reading the ladder costs no
    // re-subscription; only scrolling a padded band out moves it.
    setBand(current => watchBand(visible, itemsRef.current.length, current, BAND_PAD));
  }).current;
  const viewabilityConfig = useRef({ minimumViewTime: 250, viewAreaCoveragePercentThreshold: 20 }).current;

  const ids = useMemo(() => {
    if (!band) return [];
    const rows = items.slice(band.from, band.to + 1).flatMap(item => (item.kind === "row" ? [item.row] : []));
    // The spot the ladder is priced against is the first number on the screen, and it is one more id.
    const spot = chain ? streamId(chain.underlying) : null;
    return spot ? [...strikeIds(rows), spot] : strikeIds(rows);
  }, [band, items, chain]);

  // Off-hours the stream carries nothing for these contracts and the ladder is the closing prices the
  // trader expects, so the screen asks for ticks only while the exchange is trading.
  const feed = useQuoteFeed(ids, !!chain?.marketOpen && ids.length > 0);
  const [ticks, setTicks] = useState<Map<string, QuoteTick>>(() => new Map());
  useEffect(() => setTicks(current => tickByInstrument(feed.quotes, current)), [feed]);
  // A dropped socket stops carrying prices; keeping its last tick on screen would leave an old number
  // looking live while the chain read goes on refreshing underneath it.
  const live = feed.connected ? ticks : NO_TICKS;

  // A desk opens at at-the-money, not on the cheapest far out-of-the-money strike at the top of the grid,
  // and it opens there once: re-centering on each poll would yank the list back while the trader reads a
  // strike further down. A freshly mounted list has not measured the rows below its first batch yet, so
  // the ask is held and spent the moment the list reports its size — see `centerOn` on the FlatList.
  const listRef = useRef<FlatList<ChainItem>>(null);
  const layoutRef = useRef<{ items: ChainItem[]; offsets: number[] } | null>(null);
  const centeredFor = useRef("");
  const pendingCenter = useRef(-1);
  useEffect(() => {
    if (!chain || chain.underlying !== underlying || allExpiries) {
      pendingCenter.current = -1;
      return;
    }
    const asked = `${chain.underlying}|${chain.expiry}`;
    if (centeredFor.current === asked) return;
    const tradeable = listedRows(chain.rows);
    const index = tradeable.findIndex(row => row.isAtTheMoney);
    pendingCenter.current = index >= 0 && index < tradeable.length ? index : -1;
  }, [chain, underlying, allExpiries]);

  /** Spends the held ask, if there is one. The first list measure is what makes the scroll land. */
  const centerOn = useCallback(() => {
    const index = pendingCenter.current;
    if (index < 0 || !chain || chain.underlying !== underlying) return;
    pendingCenter.current = -1;
    centeredFor.current = `${chain.underlying}|${chain.expiry}`;
    try {
      listRef.current?.scrollToIndex({ index, viewPosition: 0.3, animated: false });
    } catch {
      // A list that has still not measured this far refuses the scroll. Losing the centring is a better
      // outcome than crashing the screen, which is exactly what an out-of-range ask used to do.
    }
  }, [chain, underlying]);

  const { data: catalogue, isLoading: catalogueLoading, error: catalogueError } = useChainUnderlyings({
    queryKey: queryKeys.optionChain.underlyings(),
    enabled: pickerOpen,
  });

  const matches = useMemo(() => {
    const rows = catalogue?.underlyings ?? [];
    const needle = search.trim().toUpperCase();
    return needle ? rows.filter(row => row.name.includes(needle)) : rows;
  }, [catalogue, search]);

  const colors = useMemo(() => resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#64748b", border: "#334155", headerBg: "#1e293b", live: "#22c55e", warn: "#f59e0b", brand: "#38bdf8" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", headerBg: "#f1f5f9", live: "#16a34a", warn: "#b45309", brand: "#0284c7" }, [resolvedTheme]);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    header: { padding: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
    selectorContainer: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
    selector: {
      flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between",
      paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: colors.card,
      borderWidth: 1, borderColor: colors.border, minWidth: 130,
    },
    selectorBody: { flex: 1, paddingRight: 6 },
    selectorLabel: { fontSize: 11, color: colors.muted, textTransform: "uppercase", marginBottom: 2 },
    selectorValue: { fontSize: 15, fontWeight: "600", color: colors.text },
    picker: { marginTop: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.card, overflow: "hidden" },
    search: {
      paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: colors.text,
      borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.bg,
    },
    pickerStatus: { paddingHorizontal: 12, paddingVertical: 10, fontSize: 12, color: colors.muted },
    pickerRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
    pickerRowOn: { backgroundColor: colors.headerBg },
    pickerName: { fontSize: 15, fontWeight: "600", color: colors.text },
    pickerMeta: { fontSize: 11, color: colors.muted, marginTop: 2 },
    pickerTag: { fontSize: 10, fontWeight: "700", color: colors.brand, textTransform: "uppercase" },
    spotRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 12 },
    spotLabel: { fontSize: 12, color: colors.muted },
    spotValue: { fontSize: 20, fontWeight: "700", color: colors.text },
    statusDot: { width: 9, height: 9, borderRadius: 5 },
    dotLive: { backgroundColor: "#22c55e" },
    dotClosed: { backgroundColor: "#94a3b8" },
    note: { fontSize: 11, color: colors.muted, marginTop: 6, lineHeight: 15 },
    noteWarn: { color: colors.warn },
    section: {
      flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12,
      height: SECTION_HEIGHT, backgroundColor: colors.headerBg, borderTopWidth: 1, borderTopColor: colors.border,
    },
    sectionText: { fontSize: 13, fontWeight: "700", color: colors.text },
    sectionSub: { fontSize: 10, fontWeight: "600", color: colors.muted, textTransform: "uppercase" },
    sectionPending: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 12, height: STATUS_HEIGHT },
    tableHeader: { flexDirection: "row", backgroundColor: colors.headerBg, paddingVertical: 8 },
    tableRow: { flexDirection: "row", height: ROW_HEIGHT, borderBottomWidth: 1, borderBottomColor: colors.border },
    tableRowAtm: { borderTopWidth: 2, borderTopColor: colors.brand },
    cell: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 },
    cellText: { fontSize: 11, fontWeight: "500", color: colors.text },
    strikeCell: { flex: 0.8, backgroundColor: colors.headerBg },
    strikeText: { fontSize: 13, fontWeight: "700", color: colors.brand },
    atmTag: { position: "absolute", bottom: 3, left: 0, right: 0, fontSize: 9, fontWeight: "700", color: colors.brand, textAlign: "center", textTransform: "uppercase" },
    callCell: { backgroundColor: "rgba(34,197,94,0.05)" },
    putCell: { backgroundColor: "rgba(239,68,68,0.05)" },
    priceText: { fontSize: 13, fontWeight: "600", color: colors.text },
    noPrice: { fontSize: 11, color: colors.muted },
    metaText: { fontSize: 10, color: colors.muted, marginTop: 1 },
    oiChangePos: { color: "#22c55e" },
    oiChangeNeg: { color: "#ef4444" },
    actionButton: { marginTop: 4, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 6, backgroundColor: colors.brand },
    actionButtonText: { fontSize: 10, fontWeight: "700", color: "white" },
    empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40, gap: 10 },
    emptyText: { fontSize: 15, color: colors.muted, textAlign: "center", lineHeight: 22 },
    emptySub: { fontSize: 12, color: colors.muted, textAlign: "center" },
    loading: { flex: 1, alignItems: "center", justifyContent: "center" },
    loadingText: { fontSize: 13, color: colors.muted, marginTop: 12 },
    retry: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8, borderWidth: 1, borderColor: colors.brand },
    retryText: { fontSize: 13, fontWeight: "600", color: colors.brand },
  }), [colors]);

  const choose = useCallback((name: string) => {
    setPickerOpen(false);
    setSearch("");
    // Switching the underlying clears the expiry; that symbol's own month-end contract is then read
    // off the ladder that comes back with its first chain, because lot sizes and expiries differ.
    if (name !== underlying) {
      derivedFor.current = "";
      setOptionChainUnderlying(name);
    }
  }, [underlying, setOptionChainUnderlying]);

  const openTicket = useCallback((onExpiry: string, row: OptionRow, right: "CE" | "PE") => {
    const side = right === "CE" ? row.call : row.put;
    // The strike's own date is carried from the row, not read off the screen's current expiry: in the
    // all-expiries view one screen holds several dates, and a ticket built from the wrong one names a
    // contract that does not exist. The ladder's two-way price travels with the press because prod's
    // single-symbol read answers for shares, so an NFO contract has no other source for ask and bid.
    ticket.fromOptionChain(underlying, Number(row.strike), right, onExpiry, "BUY",
      amount(side?.ltp) ?? undefined, { bid: amount(side?.bid), ask: amount(side?.ask) },
      // The row also carries the identity its own broker master places, which for ICICI is not the label it
      // quotes under. A ticket built from the quoted label alone names a contract prod cannot send.
      side ? { symbol: side.order?.tradingsymbol || side.symbol, exchange: side.order?.exchange } : null);
  }, [underlying, ticket]);

  // Named off the store when no chain has arrived yet: the picker is the way out of a failed read, so it
  // cannot be built on the read having worked.
  const picked = underlying;
  const listed = catalogue?.underlyings.length ?? 0;

  const underlyingPicker = pickerOpen ? (
    <View style={styles.picker}>
      <TextInput
        style={styles.search}
        placeholder="Search an index or F&O stock"
        placeholderTextColor={colors.muted}
        value={search}
        onChangeText={setSearch}
        autoCapitalize="characters"
        autoCorrect={false}
      />
      {catalogueLoading ? (
        <View style={styles.pickerStatus}>
          <ActivityIndicator size="small" color={colors.brand} />
          <Text style={styles.pickerStatus}>Reading the list of underlyings with listed options</Text>
        </View>
      ) : catalogueError ? (
        <Text style={[styles.pickerStatus, styles.noteWarn]}>{catalogueError.message}</Text>
      ) : (
        <FlatList
          style={{ maxHeight: 300 }}
          data={matches}
          keyExtractor={(row: UnderlyingInfo) => row.name}
          initialNumToRender={15}
          maxToRenderPerBatch={10}
          windowSize={5}
          removeClippedSubviews
          getItemLayout={(_, index) => ({ length: 55, offset: 55 * index, index })}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            <Text style={styles.pickerStatus}>
              {`${listed} underlyings listed · ${matches.length} shown · indices first`}
            </Text>
          }
          ListEmptyComponent={
            <Text style={styles.pickerStatus}>{`No listed underlying matches “${search.trim().toUpperCase()}”.`}</Text>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.pickerRow, item.name === picked && styles.pickerRowOn]}
              onPress={() => choose(item.name)}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.pickerName}>{item.name}</Text>
                <Text style={styles.pickerMeta}>{`1 lot = ${formatNumber(item.lotSize, 0)} units`}</Text>
              </View>
              {item.index ? <Text style={styles.pickerTag}>Index</Text> : null}
              {item.name === picked ? (
                <Ionicons name="checkmark" size={18} color={colors.brand} />
              ) : null}
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  ) : null;

  // A failed first read must reach the screen: a spinner with no reason is how an expired session
  // or an unlisted underlying looks, and the trader cannot tell them apart. The picker is offered here
  // too, because an underlying the exchange stopped listing has no other way out — "Try again" re-asks
  // for the same one, and the saved choice comes back on the next launch to do it again.
  if ((!chain || chain.underlying !== underlying) && error) {
    const asked = expiry ? `${underlying}, expiry ${expiry}` : underlying;
    return (
      <ScrollView style={styles.container} contentContainerStyle={[styles.empty, { flexGrow: 1 }]}>
        <Text style={styles.emptyText}>{error.message}</Text>
        <Text style={styles.emptySub}>Asked the server for {asked}.</Text>
        <TouchableOpacity style={styles.retry} onPress={() => refetch()}>
          <Text style={styles.retryText}>Try again</Text>
        </TouchableOpacity>
        {expiry ? (
          <TouchableOpacity style={styles.retry} onPress={() => setOptionChainExpiry("")}>
            <Text style={styles.retryText}>Show the nearest expiry</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity style={styles.retry} onPress={() => setPickerOpen(open => !open)}>
          <Text style={styles.retryText}>{pickerOpen ? "Hide the underlying list" : "Choose another underlying"}</Text>
        </TouchableOpacity>
        <View style={{ width: "100%", paddingHorizontal: 4 }}>{underlyingPicker}</View>
      </ScrollView>
    );
  }

  if ((!chain || chain.underlying !== underlying) && (isLoading || isFetching)) {
    return (
      <View style={[styles.container, styles.loading]}>
        <ActivityIndicator size="large" color={colors.brand} />
        <Text style={styles.loadingText}>Reading the {underlying} option chain</Text>
      </View>
    );
  }

  if (!chain || chain.underlying !== underlying) {
    return null;
  }

  const spot = amount(chain.spot?.price);
  // The spot is the number the ladder was priced from, so it moves on the same stream the strikes do.
  const spotTick = live.get(streamId(chain.underlying) ?? "");
  const currentSpot = spotTick && tickBeats(spotTick, chain.spot?.at) ? spotTick : null;
  const shownSpot = currentSpot ? currentSpot.price : spot;
  const spotWord = currentSpot ? tickWord(currentSpot) : null;

  // Where each line sits, built once per read. Rebuilt only when the list itself is replaced, because the
  // scroller asks for these numbers for every row it decides to mount.
  if (!layoutRef.current || layoutRef.current.items !== items) {
    const offsets = new Array<number>(items.length);
    let acc = 0;
    for (let index = 0; index < items.length; index++) {
      offsets[index] = acc;
      acc += itemHeight(items[index]);
    }
    layoutRef.current = { items, offsets };
  }
  const offsets = layoutRef.current.offsets;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.selectorContainer}>
          <TouchableOpacity
            style={styles.selector}
            onPress={() => { setPickerOpen(open => !open); setExpiryOpen(false); }}
          >
            <View style={styles.selectorBody}>
              <Text style={styles.selectorLabel}>Underlying</Text>
              <Text style={styles.selectorValue}>{chain.underlying}</Text>
            </View>
            <Ionicons name={pickerOpen ? "chevron-up" : "search-outline"} size={18} color={colors.muted} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.selector}
            onPress={() => { setExpiryOpen(open => !open); setPickerOpen(false); }}
          >
            <View style={styles.selectorBody}>
              <Text style={styles.selectorLabel}>Expiry</Text>
              <Text style={styles.selectorValue}>{allExpiries ? "All dates" : chain.expiry}</Text>
            </View>
            {isFetching ? (
              <ActivityIndicator size="small" color={colors.brand} />
            ) : (
              <Ionicons name={expiryOpen ? "chevron-up" : "calendar-outline"} size={18} color={colors.muted} />
            )}
          </TouchableOpacity>
        </View>

        {expiryOpen ? (
          <View style={styles.picker}>
            <FlatList
              style={{ maxHeight: 300 }}
              data={chain.expiries}
              keyExtractor={day => day}
              initialNumToRender={12}
              ListHeaderComponent={
                <TouchableOpacity
                  style={[styles.pickerRow, allExpiries && styles.pickerRowOn]}
                  onPress={() => { setAllExpiries(on => !on); setExpiryOpen(false); }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pickerName}>All dates</Text>
                    <Text style={styles.pickerMeta}>Every listed expiry on one screen</Text>
                  </View>
                  {allExpiries ? <Ionicons name="checkmark" size={18} color={colors.brand} /> : null}
                </TouchableOpacity>
              }
              renderItem={({ item: day }) => (
                <TouchableOpacity
                  style={[styles.pickerRow, day === chain.expiry && !allExpiries && styles.pickerRowOn]}
                  onPress={() => { setOptionChainExpiry(day); setAllExpiries(false); setExpiryOpen(false); }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pickerName}>{day}</Text>
                    {day === monthly ? <Text style={styles.pickerMeta}>This month</Text> : null}
                  </View>
                  {day === chain.expiry && !allExpiries ? (
                    <Ionicons name="checkmark" size={18} color={colors.brand} />
                  ) : null}
                </TouchableOpacity>
              )}
            />
          </View>
        ) : null}

        {underlyingPicker}

        <View style={styles.spotRow}>
          <Text style={styles.spotLabel}>Spot</Text>
          {shownSpot === null ? (
            <Text style={styles.noPrice}>{QUALITY_WORD[chain.spot?.quality] ?? "no spot price"}</Text>
          ) : (
            <Text style={styles.spotValue}>{formatNumber(shownSpot)}</Text>
          )}
          {shownSpot !== null && spotWord ? <Text style={styles.spotLabel}>{spotWord}</Text> : null}
          <View style={[styles.statusDot, chain.marketOpen ? styles.dotLive : styles.dotClosed]} />
        </View>

        {error ? <Text style={[styles.note, styles.noteWarn]}>{`Refresh failed: ${error.message}`}</Text> : null}
      </View>

      {items.length === 0 ? (
        <View style={[styles.container, styles.empty]}>
          <Text style={styles.emptyText}>
            {`No option contracts are listed for ${chain.underlying} on ${chain.expiry}.`}
          </Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={items}
          keyExtractor={item => item.key}
          initialNumToRender={10}
          maxToRenderPerBatch={6}
          updateCellsBatchingPeriod={50}
          windowSize={5}
          removeClippedSubviews
          onScrollBeginDrag={pauseQuoteDispatch}
          onScrollEndDrag={resumeQuoteDispatch}
          onMomentumScrollEnd={resumeQuoteDispatch}
          onContentSizeChange={centerOn}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          getItemLayout={(_, index) => ({ length: itemHeight(items[index]), offset: offsets[index], index })}
          renderItem={({ item }) => {
            if (item.kind === "section") {
              return (
                <View style={styles.section}>
                  <Text style={styles.sectionText}>{item.expiry}</Text>
                  <Text style={styles.sectionSub}>
                    {`${item.expiry === monthly ? "Monthly" : "Weekly"}` +
                      (item.lotSize === null ? "" : ` · 1 lot = ${formatNumber(item.lotSize, 0)}`) +
                      (item.readAt ? ` · ${readAge(item.readAt)}` : "")}
                  </Text>
                </View>
              );
            }
            if (item.kind === "pending") {
              return (
                <View style={styles.sectionPending}>
                  <ActivityIndicator size="small" color={colors.brand} />
                  <Text style={styles.sectionSub}>{`Reading the ${item.expiry} chain`}</Text>
                </View>
              );
            }
            if (item.kind === "failed") {
              return (
                <View style={styles.sectionPending}>
                  <Text style={[styles.note, styles.noteWarn]} numberOfLines={2}>{`${item.expiry}: ${item.message}`}</Text>
                </View>
              );
            }
            return (
              <OptionRowItem
                row={item.row}
                expiry={item.expiry}
                styles={styles}
                liveCall={live.get(item.row.call?.instrumentId ?? "")}
                livePut={live.get(item.row.put?.instrumentId ?? "")}
                onTrade={openTicket}
              />
            );
          }}
          contentContainerStyle={{ paddingBottom: 100 }}
          ListHeaderComponent={
            <View style={styles.tableHeader}>
              <View style={[styles.cell, styles.callCell]}><Text style={styles.cellText}>CALL</Text></View>
              <View style={[styles.cell, styles.strikeCell]}><Text style={styles.cellText}>STRIKE</Text></View>
              <View style={[styles.cell, styles.putCell]}><Text style={styles.cellText}>PUT</Text></View>
            </View>
          }
        />
      )}

      {ticket.visible ? <BuySheet ticket={ticket} /> : null}
    </View>
  );
}
