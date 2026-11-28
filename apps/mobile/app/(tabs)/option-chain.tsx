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
 * A strike neither of them has priced falls back to the premium this phone last saw for that same instrument
 * id, with the minute it saw it beside the number - see api/quote-memory.ts.
 */

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
import { useScreenFocused } from "@/hooks/useScreenFocused";
import {
  legEntries,
  liveSide,
  nearestMonthlyExpiry,
  QUALITY_WORD,
  queryKeys,
  rememberedSide,
  strikeIds,
  streamId,
  tickBeats,
  tickEntries,
  tickWord,
  todayIST,
  useInstrumentTick,
  useQuoteSubscription,
  pauseQuoteDispatch,
  resumeQuoteDispatch,
  watchBand,
  type Band,
  type OptionChainData,
  type OptionQuote,
  type OptionRow,
  type QuoteEntry,
  type RememberedQuote,
  type UnderlyingInfo,
} from "@nraialgo/shared/api";
import { useOrderTicket } from "@nraialgo/shared/hooks";
import { useTradingStore } from "@nraialgo/shared/stores";
import { formatNumber } from "@nraialgo/shared/utils";
import { useTheme } from "@/components/ThemeProvider";
import { BuySheet } from "@/components/BuySheet";
import { useApi } from "@/hooks/useApi";
import { useQuoteMemory } from "@/hooks/useQuoteMemory";
import { readChainSelection, rememberChainSelection } from "@/utils/chainSelection";
import { prefetchChainExpiries } from "@/utils/prefetch";

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
 * How long ago the prices on a saved frame were observed.
 *
 * A cold switch now answers with the last frame the server kept and finishes the broker read behind the
 * response, so the ladder is on the screen a second after opening it instead of seven. That makes the one
 * number this desk shows come from an earlier moment while the session dot beside it legitimately says live,
 * so the frame carries its own age in words, the same way each date in "All dates" already does.
 */
function frameAge(chain: OptionChainData): string {
  const at = Date.parse(chain.spot?.at ?? chain.asOf ?? "");
  return Number.isFinite(at) ? readAge(at) : "read earlier";
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

/**
 * Strikes held on the price stream beyond the ones actually on screen. Small enough that one band is a
 * couple of dozen contracts, large enough that reading up and down the ladder does not re-subscribe.
 */
const BAND_PAD = 6;

interface OptionLegCellProps {
  quote: OptionQuote | null;
  expiry: string;
  row: OptionRow;
  right: "CE" | "PE";
  saved?: RememberedQuote | null;
  styles: Record<string, any>;
  onTrade: (onExpiry: string, row: OptionRow, right: "CE" | "PE") => void;
  onRemember: (entries: readonly QuoteEntry[]) => void;
}

const OptionLegCell = React.memo(function OptionLegCell({
  quote,
  expiry,
  row,
  right,
  saved,
  styles,
  onTrade,
  onRemember,
}: OptionLegCellProps) {
  const liveTick = useInstrumentTick(quote?.instrumentId);
  useEffect(() => {
    if (liveTick) onRemember(tickEntries([liveTick]));
  }, [liveTick, onRemember]);
  const priceObj = quote ? (liveSide(quote, liveTick) ?? rememberedSide(saved)) : null;
  const oiChange = quote?.oiChangePct;
  const handlePress = useCallback(() => onTrade(expiry, row, right), [onTrade, expiry, row, right]);

  if (!quote) {
    return (
      <>
        <Text style={styles.noPrice}>Not listed</Text>
        <TouchableOpacity style={styles.actionButton} onPress={handlePress}>
          <Text style={styles.actionButtonText}>Trade</Text>
        </TouchableOpacity>
      </>
    );
  }

  return (
    <>
      {priceObj === null ? (
        <Text style={styles.noPrice}>No price</Text>
      ) : (
        <Text style={styles.priceText}>{formatNumber(priceObj.price)}</Text>
      )}
      <Text style={styles.metaText} numberOfLines={1}>
        {priceObj?.word ? `${priceObj.word}  ·  ` : ""}
        {quote.iv === null ? "No IV" : `IV ${formatNumber(quote.iv, 1)}%`}
        {quote.oi === null ? "" : `  ·  OI ${formatNumber(quote.oi, 0)}`}
        {oiChange !== null && oiChange !== 0 ? (
          <Text style={oiChange > 0 ? styles.oiChangePos : styles.oiChangeNeg}>
            {`  ·  ${oiChange > 0 ? "+" : ""}${formatNumber(oiChange, 1)}%`}
          </Text>
        ) : null}
      </Text>
      <TouchableOpacity style={styles.actionButton} onPress={handlePress}>
        <Text style={styles.actionButtonText}>Trade</Text>
      </TouchableOpacity>
    </>
  );
});

const SpotDisplay = React.memo(function SpotDisplay({
  chain,
  styles,
  onRemember,
}: {
  chain: OptionChainData;
  styles: Record<string, any>;
  onRemember: (entries: readonly QuoteEntry[]) => void;
}) {
  const spotId = useMemo(() => streamId(chain.underlying), [chain.underlying]);
  const spotTick = useInstrumentTick(spotId);
  useEffect(() => {
    if (spotTick) onRemember(tickEntries([spotTick]));
  }, [spotTick, onRemember]);
  const spot = amount(chain.spot?.price);
  const currentSpot = spotTick && tickBeats(spotTick, chain.spot?.at) ? spotTick : null;
  const shownSpot = currentSpot ? currentSpot.price : spot;
  const spotWord = currentSpot ? tickWord(currentSpot) : null;

  return (
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
  );
});

interface OptionRowItemProps {
  row: OptionRow;
  expiry: string;
  styles: Record<string, any>;
  /** What this phone last saw for each leg, asked for at render so a row that redraws for any reason picks
   *  up the newest saved number without the whole ladder redrawing for it. */
  savedCall?: RememberedQuote | null;
  savedPut?: RememberedQuote | null;
  onTrade: (onExpiry: string, row: OptionRow, right: "CE" | "PE") => void;
  onRemember: (entries: readonly QuoteEntry[]) => void;
}

const OptionRowItem = React.memo(
  function OptionRowItem({
    row,
    expiry,
    styles,
    savedCall,
    savedPut,
    onTrade,
    onRemember,
  }: OptionRowItemProps) {
    return (
      <View style={[styles.tableRow, row.isAtTheMoney && styles.tableRowAtm]}>
        <View style={[styles.cell, styles.callCell]}>
          <OptionLegCell
            quote={row.call}
            expiry={expiry}
            row={row}
            right="CE"
            saved={savedCall}
            styles={styles}
            onTrade={onTrade}
            onRemember={onRemember}
          />
        </View>

        <View style={[styles.cell, styles.strikeCell]}>
          <Text style={styles.strikeText}>{formatNumber(Number(row.strike), 0)}</Text>
          {row.isAtTheMoney ? <Text style={styles.atmTag}>ATM</Text> : null}
        </View>

        <View style={[styles.cell, styles.putCell]}>
          <OptionLegCell
            quote={row.put}
            expiry={expiry}
            row={row}
            right="PE"
            saved={savedPut}
            styles={styles}
            onTrade={onTrade}
            onRemember={onRemember}
          />
        </View>
      </View>
    );
  },
  (prev, next) =>
    prev.row === next.row &&
    prev.expiry === next.expiry &&
    prev.styles === next.styles &&
    prev.onTrade === next.onTrade &&
    prev.onRemember === next.onRemember &&
    prev.savedCall === next.savedCall &&
    prev.savedPut === next.savedPut
);

/**
 * `seed` lets the stock screen mount the chain as its own body: the route hands nothing and reads its params,
 * a caller that already knows the symbol passes it and the chain opens on that underlying directly.
 */
export default function OptionChainScreen({ seed }: { seed?: string }) {
  const { useOptionChain, useOptionChains, useChainUnderlyings } = useApi();
  const { resolvedTheme } = useTheme();
  const underlying = useTradingStore((s) => s.optionChain.underlying);
  const expiry = useTradingStore((s) => s.optionChain.expiry);
  const setOptionChainUnderlying = useTradingStore((s) => s.setOptionChainUnderlying);
  const setOptionChainExpiry = useTradingStore((s) => s.setOptionChainExpiry);
  const setOptionChainFilters = useTradingStore((s) => s.setOptionChainFilters);

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
    readChainSelection()
      // A desk that cannot read its own memory opens the way it did before the memory existed.
      .then((saved) => {
        if (alive && saved) setOptionChainFilters(saved);
      })
      .finally(() => {
        if (alive) setResumed(true);
      });
    return () => {
      alive = false;
    };
  }, [setOptionChainFilters]);

  // An empty expiry is a question, not a missing value: the server returns its nearest listed expiry.
  // A hidden tab stops polling (see useScreenFocused); it refreshes once when shown again.
  const focused = useScreenFocused();
  // The strikes this screen ticks from the socket, set below once the visible band is known; the whole
  // chain re-read slows down only while every one of them is ticking (see quoteStreamCarries).
  // gcTime 30 min: a hidden tab has no observer, and the default 5 minutes would make the return show a
  // loader instead of the last ladder. Not Infinity, because every underlying and expiry opened is its
  // own large entry.
  const streamedStrikes = useRef<readonly string[] | null>(null);
  const { data: chain, error, refetch, isFetching, isLoading } = useOptionChain(
    underlying,
    expiry,
    { enabled: resumed && !!underlying, subscribed: focused, gcTime: 30 * 60 * 1000 },
    () => streamedStrikes.current,
  );

  /**
   * A press on a stock's "Option Chain" tab carries its symbol, and the deep link has always promised the
   * same. It is applied once the saved selection has been read back, because that read lands a few
   * milliseconds later and would otherwise quietly replace the underlying the trader just chose.
   */
  const routeSeed = String(useLocalSearchParams<{ symbol?: string }>().symbol ?? "").trim().toUpperCase();
  const seeded = String(seed ?? "").trim().toUpperCase() || routeSeed;
  const seedApplied = useRef(false);
  useEffect(() => {
    if (!resumed || !seeded || seedApplied.current) return;
    seedApplied.current = true;
    setOptionChainUnderlying(seeded);
  }, [resumed, seeded, setOptionChainUnderlying]);

  // Every listed date of this underlying, loaded incrementally (2 expiries at a time)
  // to avoid firing a burst of parallel window:400 requests when toggling All Dates.
  const [expiryLimit, setExpiryLimit] = useState(2);
  useEffect(() => {
    setExpiryLimit(2);
  }, [underlying, allExpiries]);
  const visibleExpiries = useMemo(
    () => (allExpiries ? (chain?.expiries ?? []).slice(0, expiryLimit) : []),
    [allExpiries, chain?.expiries, expiryLimit],
  );
  const sections = useOptionChains(underlying, visibleExpiries, allExpiries);

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

  // What makes the next launch a single read, and what the tab-bar prefetch warms for the same reason.
  useEffect(() => {
    if (!chain || chain.underlying !== underlying) return;
    rememberChainSelection({ underlying: chain.underlying, expiry: chain.expiry });
  }, [chain?.underlying, chain?.expiry, underlying]);

  // One list either way: the strikes of the chosen date, or every listed date with its own heading and its
  // own read, so a date that is still arriving or that failed shows that instead of vanishing. It is built
  // here rather than in the render body because the price stream below subscribes by position in it.
  const items = useMemo<ChainItem[]>(() => {
    if (!chain || chain.underlying !== underlying) return [];
    if (!allExpiries) {
      return listedRows(chain.rows).map(row => ({ kind: "row" as const, key: `${chain.expiry}|${row.strike}`, expiry: chain.expiry, row }));
    }
    return visibleExpiries.flatMap<ChainItem>((day, index) => {
      const read = sections[index];
      const heading: ChainItem = { kind: "section", key: `section-${day}`, expiry: day, lotSize: read?.data?.lotSize ?? null, readAt: read?.dataUpdatedAt ?? 0 };
      if (!read?.data) {
        return read?.isError
          ? [heading, { kind: "failed" as const, key: `failed-${day}`, expiry: day, message: read.error.message }]
          : [heading, { kind: "pending" as const, key: `pending-${day}`, expiry: day }];
      }
      return [heading, ...listedRows(read.data.rows).map(row => ({ kind: "row" as const, key: `${day}|${row.strike}`, expiry: day, row }))];
    });
  }, [chain, underlying, sections, allExpiries, visibleExpiries]);

  // The ladder's own numbers arrive one broker read at a time, so between reads the screen would otherwise
  // freeze. The strikes the trader is looking at go on the app's existing price stream, keyed by the
  // identity each row already carries, and their premiums paint from the ticks that come back.
  const itemsRef = useRef<ChainItem[]>(items);
  itemsRef.current = items;
  const [band, setBand] = useState<Band | null>(null);

  useEffect(() => {
    setBand(null);
  }, [underlying, expiry, allExpiries]);

  // Initialize a band around ATM strikes immediately when items load so strikes subscribe to WebSocket ticks
  // without waiting for onViewableItemsChanged to fire.
  useEffect(() => {
    if (items.length > 0 && !band) {
      const atmIdx = items.findIndex(item => item.kind === "row" && item.row.isAtTheMoney);
      const center = atmIdx >= 0 ? atmIdx : Math.floor(items.length / 2);
      const from = Math.max(0, center - BAND_PAD);
      const to = Math.min(items.length - 1, center + BAND_PAD);
      setBand({ from, to });
    }
  }, [items, band]);

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

  // Subscribe without re-rendering OptionChainScreen on every tick; OptionLegCell & SpotDisplay subscribe individually.
  useQuoteSubscription(ids, !!chain?.marketOpen && ids.length > 0);
  useEffect(() => {
    streamedStrikes.current = ids;
  }, [ids]);

  // What the stream and the ladder reads have priced goes into the phone's own quote memory, so a strike the
  // exchange has gone quiet on — or a ladder prod answers without premiums — still shows the number this
  // trader last saw, with its minute, instead of an empty cell.
  const quotes = useQuoteMemory();
  useEffect(() => {
    const legs = items.flatMap(item => (item.kind === "row" ? [item.row.call, item.row.put] : []));
    quotes.remember(legEntries(legs));
  }, [quotes, items]);

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
    spotValue: { fontSize: 20, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"] },
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
    strikeText: { fontSize: 13, fontWeight: "700", color: colors.brand, fontVariant: ["tabular-nums"] },
    atmTag: { position: "absolute", bottom: 3, left: 0, right: 0, fontSize: 9, fontWeight: "700", color: colors.brand, textAlign: "center", textTransform: "uppercase" },
    callCell: { backgroundColor: "rgba(34,197,94,0.05)" },
    putCell: { backgroundColor: "rgba(239,68,68,0.05)" },
    priceText: { fontSize: 13, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] },
    noPrice: { fontSize: 11, color: colors.muted },
    metaText: { fontSize: 10, color: colors.muted, marginTop: 1, fontVariant: ["tabular-nums"] },
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
      side ? { symbol: side.order?.tradingsymbol || side.symbol, exchange: side.order?.exchange, instrumentId: side.instrumentId } : null);
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
            onPress={() => {
              // A cold ladder read is seconds, and the date behind the picker is the only thing the trader is
              // about to tap, so the reads start while the list is being read rather than after the press.
              prefetchChainExpiries(underlying, chain.expiries, chain.expiry);
              setExpiryOpen(open => !open);
              setPickerOpen(false);
            }}
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

        <SpotDisplay chain={chain} styles={styles} onRemember={quotes.remember} />

        {/* The server answers a cold read with the last frame it kept so the ladder appears at once, and while
            that frame is on the screen the session dot beside it says live — so the frame says its own age,
            and whether a fresh read is still coming underneath it. After the close the server also serves a
            saved frame, but there nothing is failing and the closed dot already says so, so the note stays off. */}
        {chain.displaySnapshot && chain.marketOpen ? (
          <Text style={[styles.note, styles.noteWarn]} numberOfLines={2}>
            {`Prices ${frameAge(chain)} · ${chain.refreshing ? "live chain still loading" : "the live read is not answering"}`}
          </Text>
        ) : null}

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
          initialNumToRender={12}
          maxToRenderPerBatch={8}
          updateCellsBatchingPeriod={30}
          windowSize={7}
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
                savedCall={quotes.seen(item.row.call?.instrumentId)}
                savedPut={quotes.seen(item.row.put?.instrumentId)}
                onTrade={openTicket}
                onRemember={quotes.remember}
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
