/**
 * Spread Builder — stage an option basket on the live ladder and send all of it with one press.
 *
 * The legs are built from the same chain read the Options tab paints, so every strike offered is a
 * strike the exchange lists and every price shown is the price prod reported for that contract. One
 * press then asks prod to resolve the basket (`/v1/orders/option-drafts`, which creates nothing) and
 * hands the resolved lines to `/v1/orders` under one reference, so the whole basket is one instruction
 * and a retry of it is the same instruction rather than a second basket at the broker.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Circle, Line, Path } from "react-native-svg";
import { Ionicons } from "@expo/vector-icons";
import { newClientId } from "@nraialgo/shared/hooks";
import { useTradingStore } from "@nraialgo/shared/stores";
import { formatNumber } from "@nraialgo/shared/utils";
import { chartFailureReason, chartPickerSections, queryKeys } from "@nraialgo/shared/api";
import type { OptionChainData, OptionDraftLeg, PlaceOrderLine } from "@nraialgo/shared/api";
import { useTheme } from "@/components/ThemeProvider";
import { useApi } from "@/hooks/useApi";

/** One staged leg, as the trader left it. The contract prod resolves it into is not this screen's business. */
interface Leg {
  id: string;
  side: "BUY" | "SELL";
  right: "CE" | "PE";
  strike: string;
  lots: number;
}

/**
 * A template is written in steps away from the at-the-money strike rather than in rupees, because the
 * grid a stock trades on has nothing in common with NIFTY's, and a step always lands on a listed
 * contract. The strike list is ascending, so a positive step is always the higher strike.
 */
interface Template {
  id: string;
  name: string;
  legs: Array<{ step: number; right: "CE" | "PE"; side: "BUY" | "SELL"; lots: number }>;
}

const TEMPLATES: Template[] = [
  { id: "bull_call", name: "Bull call spread", legs: [{ step: 0, right: "CE", side: "BUY", lots: 1 }, { step: 2, right: "CE", side: "SELL", lots: 1 }] },
  { id: "bear_put", name: "Bear put spread", legs: [{ step: 0, right: "PE", side: "BUY", lots: 1 }, { step: -2, right: "PE", side: "SELL", lots: 1 }] },
  { id: "bull_put", name: "Bull put spread", legs: [{ step: -2, right: "PE", side: "SELL", lots: 1 }, { step: -4, right: "PE", side: "BUY", lots: 1 }] },
  { id: "bear_call", name: "Bear call spread", legs: [{ step: 2, right: "CE", side: "SELL", lots: 1 }, { step: 4, right: "CE", side: "BUY", lots: 1 }] },
  { id: "straddle", name: "Long straddle", legs: [{ step: 0, right: "CE", side: "BUY", lots: 1 }, { step: 0, right: "PE", side: "BUY", lots: 1 }] },
  { id: "short_straddle", name: "Short straddle", legs: [{ step: 0, right: "CE", side: "SELL", lots: 1 }, { step: 0, right: "PE", side: "SELL", lots: 1 }] },
  { id: "strangle", name: "Long strangle", legs: [{ step: 2, right: "CE", side: "BUY", lots: 1 }, { step: -2, right: "PE", side: "BUY", lots: 1 }] },
  { id: "iron_condor", name: "Iron condor", legs: [{ step: 2, right: "CE", side: "SELL", lots: 1 }, { step: 4, right: "CE", side: "BUY", lots: 1 }, { step: -2, right: "PE", side: "SELL", lots: 1 }, { step: -4, right: "PE", side: "BUY", lots: 1 }] },
  { id: "jade_lizard", name: "Jade lizard", legs: [{ step: -2, right: "PE", side: "SELL", lots: 1 }, { step: 2, right: "CE", side: "SELL", lots: 1 }, { step: 4, right: "CE", side: "BUY", lots: 1 }] },
  { id: "bull_ratio", name: "Bull ratio", legs: [{ step: 0, right: "CE", side: "BUY", lots: 1 }, { step: 2, right: "CE", side: "SELL", lots: 2 }] },
];

/** Prod sends prices as decimal strings so nothing rounds on the way here; the screen needs numbers. */
function amount(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The quote a leg would leave at: what that side of the book actually has to give, else the last trade. */
function legPrice(chain: OptionChainData, strike: string, right: "CE" | "PE", side: "BUY" | "SELL"): number | null {
  const row = chain.rows.find(item => item.strike === strike);
  const quote = right === "CE" ? row?.call : row?.put;
  if (!quote) return null;
  const candidates = side === "BUY" ? [quote.ask, quote.ltp, quote.bid] : [quote.bid, quote.ltp, quote.ask];
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/** One line of the basket, reduced to what the payoff actually needs. */
interface PayoffLine {
  strike: number;
  right: "CE" | "PE";
  sign: 1 | -1;
  premium: number;
  qty: number;
}

/**
 * What the basket is worth at expiry for one spot, in rupees. A bought leg pays its premium first and
 * takes intrinsic value back; a sold leg keeps its premium and owes the intrinsic value.
 */
function payoffAt(lines: PayoffLine[], spot: number): number {
  return lines.reduce((sum, line) => {
    const intrinsic = line.right === "CE" ? Math.max(spot - line.strike, 0) : Math.max(line.strike - spot, 0);
    return sum + line.sign * (intrinsic - line.premium) * line.qty;
  }, 0);
}

/**
 * The curve needs no grid invented: between two listed strikes the payoff is a straight line, so
 * sampling every listed strike draws it exactly and gives the break-evens as a by-product. Only the
 * neighbourhood of the basket is sampled - a 100-point spread plotted across a 3,000-point ladder
 * would put every kink in the same few pixels.
 */
function buildPayoff(lines: PayoffLine[], ladder: number[], spot: number | null) {
  const step = ladder[1] - ladder[0];
  const anchors = lines.map(line => line.strike);
  if (spot !== null) anchors.push(spot);
  // An empty basket still gets a window, so the chart never resizes itself when the first leg appears.
  if (!anchors.length) anchors.push(ladder[Math.floor(ladder.length / 2)]);
  const low = Math.min(...anchors);
  const high = Math.max(...anchors);
  const pad = Math.max(4 * step, Math.ceil(((high - low) * 0.5) / step) * step);
  const nearby = ladder.filter(strike => strike >= low - pad && strike <= high + pad);
  const xs = nearby.length >= 3 ? nearby : ladder;
  const ys = xs.map(x => payoffAt(lines, x));

  // Premiums are decimal strings multiplied out by a lot size, so a capped wing comes back as a plateau
  // that differs in its last bits and a strict equality called it a rising loss. Half a paisa sits far
  // below the smallest real slope over one listed step (a step times a lot) and far above the noise.
  const FLAT = 0.005;
  const flat = (a: number, b: number) => Math.abs(a - b) < FLAT;

  const breakEvens: number[] = [];
  for (let i = 1; i < xs.length; i += 1) {
    // A run of samples sitting on zero is one break-even, not one per sample.
    if (flat(ys[i], 0)) { if (!flat(ys[i - 1], 0)) breakEvens.push(xs[i]); }
    else if (ys[i - 1] * ys[i] < 0 && !flat(ys[i - 1], 0)) {
      breakEvens.push(xs[i - 1] + ((xs[i] - xs[i - 1]) * -ys[i - 1]) / (ys[i] - ys[i - 1]));
    }
  }

  // A tail that is still climbing at the edge of the ladder is not a maximum, and saying so is the
  // difference between a spread and a naked leg the trader thought was capped.
  const riseLeft = ys[1] > ys[0];
  const riseRight = ys[ys.length - 1] > ys[ys.length - 2];
  const flatLeft = flat(ys[1], ys[0]);
  const flatRight = flat(ys[ys.length - 1], ys[ys.length - 2]);
  const tail = [
    flatLeft ? `${ys[0] >= 0 ? "Best" : "Worst"} ${formatNumber(Math.abs(ys[0]), 0)} below ${formatNumber(xs[1], 0)}`
      : `Grows ${riseLeft ? "loss" : "gain"} below ${formatNumber(xs[1], 0)}`,
    flatRight ? `${ys[ys.length - 1] >= 0 ? "Best" : "Worst"} ${formatNumber(Math.abs(ys[ys.length - 1]), 0)} above ${formatNumber(xs[xs.length - 2], 0)}`
      : `Grows ${riseRight ? "gain" : "loss"} above ${formatNumber(xs[xs.length - 2], 0)}`,
  ].join("  ·  ");

  return { xs, ys, breakEvens, tail, atSpot: spot === null ? null : payoffAt(lines, spot) };
}

export default function SpreadBuilderScreen() {
  const { useOptionChain, useChainUnderlyings, useOrderDestinations, useOptionDrafts, usePlaceOrder, useOrderSnapshot } = useApi();
  const { resolvedTheme } = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  const {
    optionChain: { underlying, expiry },
    setOptionChainUnderlying,
  } = useTradingStore();

  // The builder works on the contract the trader names here, and on whichever listed date they press:
  // prices are only ever read out of the chain for the date being staged, so a date change is its own
  // read rather than a re-labelled one.
  const [date, setDate] = useState("");
  const { data: chain, error: chainError } = useOptionChain(underlying, date || expiry);
  useEffect(() => {
    setDate("");
  }, [underlying]);

  // The catalogue is the same derivatives master the Options tab picks from, and it is only read when
  // the sheet is actually opened - a builder that never switches symbols pays no second prod read.
  const [symbolOpen, setSymbolOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { data: catalogue, isLoading: catalogueLoading, error: catalogueError } = useChainUnderlyings({
    queryKey: queryKeys.optionChain.underlyings(),
    enabled: symbolOpen,
  });
  const sections = useMemo(() => chartPickerSections(catalogue?.underlyings ?? [], search), [catalogue, search]);

  const [legs, setLegs] = useState<Leg[]>([]);
  const [basket, setBasket] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sentId, setSentId] = useState("");

  const { data: destinations } = useOrderDestinations(true);
  const account = destinations?.accounts?.[0];
  const { mutateAsync: createDrafts } = useOptionDrafts();
  const { mutateAsync: placeOrder } = usePlaceOrder();
  const { data: outcome } = useOrderSnapshot(sentId, sentId !== "");

  const wanted = chain ? chain.expiry : "";

  // One reference per distinct basket, derived from what would actually be sent: the symbol, the expiry the
  // drafts are built for, then every leg. A retry of the same basket therefore keeps the reference prod
  // needs in order to answer it idempotently, while any real change gets a fresh one. The hand-rotated
  // reference this replaces got both halves wrong: the lot stepper clamps at one lot, so that tap burned a
  // reference on a basket that had not changed and let an identical one reach the broker twice, and tapping
  // another expiry changed every contract under the reference still held.
  const basketKey = JSON.stringify([
    underlying,
    wanted,
    legs.map(leg => [leg.side, leg.right, String(leg.strike), leg.lots]),
  ]);
  const references = useRef(new Map<string, string>());
  const referenceFor = (key: string) => {
    const held = references.current.get(key);
    if (held) return held;
    const created = newClientId();
    references.current.set(key, created);
    return created;
  };
  // What the screen is showing right now, so a receipt only ever claims the basket still on it.
  const shownKey = useRef(basketKey);
  useEffect(() => { shownKey.current = basketKey; }, [basketKey]);

  const edit = (next: (current: Leg[]) => Leg[]) => {
    setSentId("");
    setNote(null);
    setLegs(next);
  };

  // A leg staged on NIFTY's ladder is not a leg on RELIANCE's, so switching the symbol drops the basket
  // rather than leaving strikes the new chain does not list and pricing the trader cannot see.
  const choose = (name: string) => {
    setSymbolOpen(false);
    setSearch("");
    if (name === underlying) return;
    edit(() => []);
    setOptionChainUnderlying(name);
  };

  const strikes = useMemo(
    () => (chain?.rows ?? []).filter(row => row.call || row.put).map(row => row.strike),
    [chain]
  );
  /** Empty until the chain names one; both uses fall back to the middle of the listed ladder. */
  const atTheMoney = useMemo(() => (chain?.rows ?? []).find(row => row.isAtTheMoney)?.strike ?? "", [chain]);
  const lotSize = chain?.lotSize ?? 0;

  const stage = (template: Template) => {
    if (!strikes.length) return;
    const atm = strikes.indexOf(atTheMoney);
    const anchor = atm < 0 ? Math.floor(strikes.length / 2) : atm;
    edit(current => template.legs.map((leg, index) => ({
      id: `${template.id}-${index}`,
      side: leg.side,
      right: leg.right,
      lots: leg.lots,
      // Clamped rather than dropped: a three-step wing on a short stock ladder is still the furthest
      // listed strike the trader meant, and silently losing a leg would send a naked one.
      strike: strikes[Math.min(strikes.length - 1, Math.max(0, anchor + leg.step))],
    })));
  };

  const addLeg = () => {
    if (!strikes.length) return;
    edit(current => [...current, {
      id: `leg-${current.length}-${Date.now()}`,
      side: "BUY",
      right: "CE",
      lots: 1,
      strike: atTheMoney && strikes.includes(atTheMoney) ? atTheMoney : strikes[Math.floor(strikes.length / 2)],
    }]);
  };

  const step = (leg: Leg, field: "strike" | "lots", direction: 1 | -1) =>
    edit(current => current.map(item => {
      if (item.id !== leg.id) return item;
      if (field === "lots") return { ...item, lots: Math.min(99, Math.max(1, item.lots + direction)) };
      const index = strikes.indexOf(item.strike);
      const next = Math.min(strikes.length - 1, Math.max(0, (index < 0 ? 0 : index) + direction));
      return { ...item, strike: strikes[next] };
    }));

  const flip = (leg: Leg, field: "side" | "right") =>
    edit(current => current.map(item => item.id === leg.id
      ? { ...item, [field]: field === "side" ? (item.side === "BUY" ? "SELL" : "BUY") : (item.right === "CE" ? "PE" : "CE") }
      : item));

  const remove = (leg: Leg) => edit(current => current.filter(item => item.id !== leg.id));

  const priced = legs.map(leg => ({ leg, price: chain ? legPrice(chain, leg.strike, leg.right, leg.side) : null }));
  const net = priced.reduce((sum, item) =>
    item.price === null ? sum : sum + (item.leg.side === "BUY" ? 1 : -1) * item.price * item.leg.lots * lotSize, 0);

  // The payoff is drawn from the same premiums the leg rows show, so the curve and the net figure can
  // never disagree. No legs is a true flat line at zero; an unpriced leg is an unknown, and the curve
  // stops rather than drawing the payoff of a basket the trader did not stage.
  const unpricedLeg = priced.find(item => item.price === null)?.leg ?? null;
  const spotNow = chain ? amount(chain.spot.price) : null;
  const payoff = !chain || unpricedLeg || lotSize <= 0 || strikes.length < 3 ? null : buildPayoff(
    priced.map(item => ({
      strike: Number(item.leg.strike),
      right: item.leg.right,
      sign: item.leg.side === "BUY" ? 1 : -1,
      premium: item.price as number,
      qty: item.leg.lots * lotSize,
    })),
    strikes.map(Number).filter(Number.isFinite).sort((a, b) => a - b),
    spotNow,
  );

  const send = async () => {
    if (!chain || !wanted) { setNote("The chain has not answered yet. Nothing was sent."); return; }
    if (!legs.length) { setNote("Add a leg first."); return; }
    if (legs.length > 8) { setNote("Prod takes eight legs in one instruction. Remove some."); return; }
    if (!account) { setNote("No connected broker account for this sign-in. Nothing was sent."); return; }
    const unpriced = legs.find(leg => legPrice(chain, leg.strike, leg.right, leg.side) === null);
    if (unpriced) {
      setNote(`${unpriced.strike} ${unpriced.right} has no price from the broker. Nothing was sent.`);
      return;
    }

    const draftLegs: OptionDraftLeg[] = legs.map(leg => ({
      expiry: wanted,
      strike: leg.strike,
      right: leg.right,
      side: leg.side,
      lots: leg.lots,
      lotSize,
      price: (legPrice(chain, leg.strike, leg.right, leg.side) as number).toFixed(2),
    }));

    // Taken before the first await: the reference and the legs must be the same basket's, because a leg
    // tapped while the drafts were being named would otherwise send the old contracts under a reference
    // the edited basket is holding.
    const reference = referenceFor(basketKey);
    setSending(true);
    setNote(null);
    try {
      // Two calls, one press: prod names the contracts first and refuses the basket here if any leg is
      // not a contract it can trade, so nothing reaches the broker unless the whole set resolves.
      const drafts = await createDrafts({ provider: account.provider, underlying, legs: draftLegs });
      const orders: PlaceOrderLine[] = drafts.orders;
      const receipt = await placeOrder({
        clientId: reference,
        provider: drafts.provider,
        accountId: drafts.accountId,
        ...(basket.trim() ? { basketName: basket.trim() } : {}),
        orders,
      });
      if (shownKey.current === basketKey) {
        setSentId(receipt.clientId);
      } else {
        // The trader amended this basket while it was going out, so the receipt on screen would be a
        // receipt for contracts the screen no longer shows.
        setNote("The basket on screen changed while that one was being sent. Check Orders for what went out.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A refusal is an answer and means the basket never left. A lost answer is not: the same
      // reference may still commit, so the trader is told to look rather than to press again.
      const refused = typeof (error as { status?: number } | null)?.status === "number";
      setNote(refused ? `${message} Nothing was sent.` : `${message} This basket may still reach the broker. Do not send it again - check Orders.`);
    } finally {
      setSending(false);
    }
  };

  const colors = resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#64748b", border: "#334155", brand: "#38bdf8", buy: "#22c55e", sell: "#ef4444", warn: "#f59e0b" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", brand: "#0284c7", buy: "#16a34a", sell: "#dc2626", warn: "#b45309" };

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    body: { padding: 12, gap: 12 },
    title: { fontSize: 17, fontWeight: "700", color: colors.text },
    meta: { fontSize: 12, color: colors.muted, marginTop: 2 },
    symbol: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
    symbolBody: { flex: 1 },
    sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, maxHeight: "80%" },
    sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
    search: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: colors.text, backgroundColor: colors.bg, marginBottom: 8 },
    sectionTitle: { fontSize: 11, fontWeight: "700", letterSpacing: 0.7, color: colors.muted, textTransform: "uppercase", paddingTop: 10, paddingBottom: 4 },
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: colors.border },
    rowName: { fontSize: 16, fontWeight: "600", color: colors.text },
    rowMeta: { fontSize: 12, color: colors.muted },
    tag: { fontSize: 10, fontWeight: "700", color: colors.brand, textTransform: "uppercase" },
    dates: { gap: 6 },
    dateChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
    dateChipOn: { borderColor: colors.brand, backgroundColor: `${colors.brand}22` },
    dateText: { fontSize: 12, color: colors.text },
    templates: { gap: 8 },
    template: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
    templateOn: { borderColor: colors.brand, backgroundColor: `${colors.brand}22` },
    templateText: { fontSize: 12, fontWeight: "600", color: colors.text },
    leg: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.card, padding: 8, gap: 8 },
    legRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    pill: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: colors.border },
    pillText: { fontSize: 12, fontWeight: "700" },
    stepper: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1, justifyContent: "center" },
    stepButton: { width: 30, height: 30, borderRadius: 6, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
    strike: { fontSize: 15, fontWeight: "700", color: colors.brand, minWidth: 70, textAlign: "center" },
    small: { fontSize: 12, color: colors.muted },
    price: { fontSize: 13, fontWeight: "600", color: colors.text },
    add: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.border, borderStyle: "dashed" },
    addText: { fontSize: 13, fontWeight: "600", color: colors.brand },
    field: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.card, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text },
    net: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
    netValue: { fontSize: 20, fontWeight: "700" },
    payoff: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.card, padding: 8, gap: 4 },
    payoffHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
    payoffAxis: { flexDirection: "row", justifyContent: "space-between" },
    payoffAxisText: { fontSize: 11, color: colors.muted },
    payoffFoot: { fontSize: 11, color: colors.muted, lineHeight: 16 },
    execute: { height: 52, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.brand },
    executeText: { fontSize: 16, fontWeight: "700", color: "#ffffff" },
    note: { fontSize: 12, color: colors.warn, lineHeight: 17 },
    outcome: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.card, padding: 10, gap: 6 },
    outcomeLeg: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
    outcomeText: { fontSize: 12, color: colors.text, flex: 1 },
    outcomeState: { fontSize: 12, fontWeight: "700", color: colors.muted },
    center: { padding: 32, alignItems: "center", gap: 10 },
    centerText: { fontSize: 13, color: colors.muted, textAlign: "center" },
  });

  const spot = chain ? amount(chain.spot.price) : null;

  // The symbol is chosen here rather than inherited from whatever the Options tab last painted, but it
  // stays one shared value: the chain read, the drafts and the Options tab must name the same contract.
  const header = (
    <View>
      <TouchableOpacity
        style={styles.symbol}
        onPress={() => setSymbolOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Change symbol, currently ${underlying}`}
      >
        <View style={styles.symbolBody}>
          <Text style={styles.small}>Symbol</Text>
          <Text style={styles.title}>{underlying}</Text>
        </View>
        <Ionicons name="chevron-down" size={18} color={colors.muted} />
      </TouchableOpacity>
      <Text style={styles.meta}>
        {!chain
          ? chainError
            ? `Chain read failed: ${chainError.message}`
            : `Reading the ${underlying} chain`
          : `${spot === null ? "No spot from the broker" : `Spot ${formatNumber(spot, 2)}`}  ·  lot ${lotSize}  ·  ${strikes.length} strikes`}
      </Text>
    </View>
  );

  const closePicker = () => {
    setSymbolOpen(false);
    setSearch("");
  };

  const picker = (
    <Modal visible={symbolOpen} animationType="slide" onRequestClose={closePicker}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
        <View style={styles.sheet}>
          <View style={styles.sheetHead}>
            <Text style={styles.title}>Build a spread on</Text>
            <TouchableOpacity
              onPress={closePicker}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Close the symbol list"
            >
              <Ionicons name="close" size={22} color={colors.muted} />
            </TouchableOpacity>
          </View>
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
            <Text style={styles.meta}>Reading the list of underlyings with listed options</Text>
          ) : catalogueError ? (
            <Text style={styles.note}>
              {chartFailureReason(catalogueError, "The list of underlyings could not be read.")}
            </Text>
          ) : !sections.length ? (
            <Text style={styles.meta}>{`No listed underlying matches “${search.trim().toUpperCase()}”.`}</Text>
          ) : null}
          <SectionList
            style={{ maxHeight: 420 }}
            sections={sections}
            keyExtractor={(row) => row.name}
            initialNumToRender={20}
            keyboardShouldPersistTaps="handled"
            stickySectionHeadersEnabled={false}
            renderSectionHeader={({ section }) => <Text style={styles.sectionTitle}>{section.title}</Text>}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.row} onPress={() => choose(item.name)} accessibilityRole="button" accessibilityLabel={`Build on ${item.name}`}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowName}>{item.name}</Text>
                  <Text style={styles.rowMeta}>{`1 lot = ${formatNumber(item.lotSize, 0)} units`}</Text>
                </View>
                {item.index ? <Text style={styles.tag}>Index</Text> : null}
                {item.name === underlying ? <Ionicons name="checkmark" size={18} color={colors.brand} /> : null}
              </TouchableOpacity>
            )}
          />
        </View>
      </View>
    </Modal>
  );

  if (!chain) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.body}>
        {header}
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
          <Text style={styles.centerText}>
            {chainError
              ? `Chain read failed: ${chainError.message}. Pick another symbol to build on.`
              : `Reading ${underlying}`}
          </Text>
        </View>
        {picker}
      </ScrollView>
    );
  }

  const activeTemplate = TEMPLATES.find(template =>
    template.legs.length === legs.length &&
    template.legs.every((leg, index) => legs[index]?.side === leg.side && legs[index]?.right === leg.right && legs[index]?.lots === leg.lots)
  )?.id;

  // Rupees on the vertical, spot on the horizontal, both stretched to whatever this basket actually
  // reaches - a two-leg spread and an iron condor share no useful axis.
  const chart = payoff ? (() => {
    const w = Math.round(screenWidth - 42);
    const h = 132;
    const padX = 5;
    const padTop = 10;
    const padBottom = 12;
    const lo = Math.min(...payoff.xs);
    const hi = Math.max(...payoff.xs);
    // A basket with no legs has no rupee range at all; giving it one keeps the flat line in the middle
    // of the frame instead of glued to the floor.
    const yMin = Math.min(...payoff.ys, 0);
    const yMax = Math.max(...payoff.ys, 0);
    const yLo = yMax - yMin < 0.005 ? yMin - 1 : yMin;
    const yHi = yMax - yMin < 0.005 ? yMax + 1 : yMax;
    const px = (x: number) => padX + (((x - lo) / (hi - lo || 1)) * (w - padX * 2));
    const py = (y: number) => padTop + ((1 - (y - yLo) / (yHi - yLo || 1)) * (h - padTop - padBottom));
    return {
      w,
      h,
      px,
      py,
      zero: py(0),
      d: payoff.xs.map((x, i) => `${i === 0 ? "M" : "L"}${px(x).toFixed(1)},${py(payoff.ys[i]).toFixed(1)}`).join(""),
    };
  })() : null;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.body}>
      {header}

      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        data={chain.expiries}
        keyExtractor={day => day}
        renderItem={({ item: day }) => (
          <TouchableOpacity style={[styles.dateChip, day === chain.expiry && styles.dateChipOn]} onPress={() => { setDate(day); setSentId(""); }}>
            <Text style={styles.dateText}>{day}</Text>
          </TouchableOpacity>
        )}
        contentContainerStyle={styles.dates}
        style={{ marginHorizontal: -12 }}
      />

      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        data={TEMPLATES}
        keyExtractor={template => template.id}
        renderItem={({ item: template }) => (
          <TouchableOpacity style={[styles.template, activeTemplate === template.id && styles.templateOn]} onPress={() => stage(template)}>
            <Text style={styles.templateText}>{`${template.name} ${template.legs.length}`}</Text>
          </TouchableOpacity>
        )}
        contentContainerStyle={styles.templates}
        style={{ marginHorizontal: -12 }}
      />

      {legs.map(leg => {
        const price = legPrice(chain, leg.strike, leg.right, leg.side);
        return (
          <View key={leg.id} style={styles.leg}>
            <View style={styles.legRow}>
              <TouchableOpacity style={[styles.pill, { borderColor: colors[leg.side === "BUY" ? "buy" : "sell"] }]} onPress={() => flip(leg, "side")}>
                <Text style={[styles.pillText, { color: colors[leg.side === "BUY" ? "buy" : "sell"] }]}>{leg.side}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.pill, { borderColor: colors[leg.right === "CE" ? "buy" : "sell"] }]} onPress={() => flip(leg, "right")}>
                <Text style={[styles.pillText, { color: colors[leg.right === "CE" ? "buy" : "sell"] }]}>{leg.right}</Text>
              </TouchableOpacity>
              <View style={styles.stepper}>
                <TouchableOpacity style={styles.stepButton} onPress={() => step(leg, "strike", -1)}>
                  <Ionicons name="chevron-back" size={16} color={colors.text} />
                </TouchableOpacity>
                <Text style={styles.strike}>{leg.strike}</Text>
                <TouchableOpacity style={styles.stepButton} onPress={() => step(leg, "strike", 1)}>
                  <Ionicons name="chevron-forward" size={16} color={colors.text} />
                </TouchableOpacity>
              </View>
              <TouchableOpacity style={styles.stepButton} onPress={() => remove(leg)}>
                <Ionicons name="close" size={16} color={colors.muted} />
              </TouchableOpacity>
            </View>
            <View style={styles.legRow}>
              <View style={styles.stepper}>
                <TouchableOpacity style={styles.stepButton} onPress={() => step(leg, "lots", -1)}>
                  <Ionicons name="remove" size={16} color={colors.text} />
                </TouchableOpacity>
                <Text style={[styles.price, { minWidth: 60, textAlign: "center" }]}>{`${leg.lots} lot${leg.lots > 1 ? "s" : ""}`}</Text>
                <TouchableOpacity style={styles.stepButton} onPress={() => step(leg, "lots", 1)}>
                  <Ionicons name="add" size={16} color={colors.text} />
                </TouchableOpacity>
              </View>
              <Text style={styles.small}>{`${leg.lots * lotSize} qty`}</Text>
              <Text style={styles.price}>{price === null ? "no price" : `at ${formatNumber(price, 2)}`}</Text>
            </View>
          </View>
        );
      })}

      {legs.length < 8 ? (
        <TouchableOpacity style={styles.add} onPress={addLeg}>
          <Ionicons name="add" size={16} color={colors.brand} />
          <Text style={styles.addText}>Add leg</Text>
        </TouchableOpacity>
      ) : null}

      {legs.length > 1 ? (
        <TextInput
          style={styles.field}
          value={basket}
          onChangeText={setBasket}
          placeholder={`Basket name - ${underlying} ${wanted}`}
          placeholderTextColor={colors.muted}
          autoCapitalize="characters"
          maxLength={80}
        />
      ) : null}

      {legs.length ? (
        <View style={styles.net}>
          <Text style={styles.small}>{`Net ${net >= 0 ? "debit" : "credit"}`}</Text>
          <Text style={[styles.netValue, { color: net >= 0 ? colors.sell : colors.buy }]}>{`₹${formatNumber(Math.abs(net), 2)}`}</Text>
        </View>
      ) : null}

      {payoff && chart ? (
        <View style={styles.payoff}>
          <View style={styles.payoffHead}>
            <Text style={styles.small}>Payoff at expiry</Text>
            {payoff.atSpot === null ? null : (
              <Text style={[styles.price, { color: payoff.atSpot >= 0 ? colors.buy : colors.sell }]}>
                {`${payoff.atSpot >= 0 ? "+" : "-"}₹${formatNumber(Math.abs(payoff.atSpot), 0)}`}
              </Text>
            )}
          </View>
          <Svg width={chart.w} height={chart.h}>
            <Line x1={0} y1={chart.zero} x2={chart.w} y2={chart.zero} stroke={colors.border} strokeWidth={1} strokeDasharray="4 3" />
            <Path d={chart.d} stroke={colors.brand} strokeWidth={2} fill="none" />
            {payoff.breakEvens.map(strike => (
              <Circle key={`break-${strike}`} cx={chart.px(strike)} cy={chart.zero} r={3} fill={colors.warn} />
            ))}
            {spot !== null && spot >= payoff.xs[0] && spot <= payoff.xs[payoff.xs.length - 1] && payoff.atSpot !== null ? (
              <Circle cx={chart.px(spot)} cy={chart.py(payoff.atSpot)} r={3.5} fill={colors.text} />
            ) : null}
          </Svg>
          <View style={styles.payoffAxis}>
            <Text style={styles.payoffAxisText}>{formatNumber(payoff.xs[0], 0)}</Text>
            <Text style={styles.payoffAxisText}>{spot === null ? "no spot" : `spot ${formatNumber(spot, 0)}`}</Text>
            <Text style={styles.payoffAxisText}>{formatNumber(payoff.xs[payoff.xs.length - 1], 0)}</Text>
          </View>
          <Text style={styles.payoffFoot}>
            {legs.length === 0
              ? "Flat at zero - the payoff of no legs is nothing."
              : `${payoff.breakEvens.length
                  ? `Break even ${payoff.breakEvens.slice(0, 4).map(strike => formatNumber(strike, 0)).join("  ·  ")}`
                  : "No break-even inside the listed strikes"}  ·  ${payoff.tail}`}
          </Text>
        </View>
      ) : legs.length ? (
        <View style={styles.payoff}>
          <View style={styles.payoffHead}>
            <Text style={styles.small}>Payoff at expiry</Text>
          </View>
          <Text style={styles.payoffFoot}>
            {unpricedLeg
              ? `${unpricedLeg.strike} ${unpricedLeg.right} has no price from the broker, so the curve is not drawn.`
              : "The payoff needs a lot size and a priced leg at every strike."}
          </Text>
        </View>
      ) : null}

      <TouchableOpacity style={[styles.execute, (sending || !legs.length) && { opacity: 0.5 }]} onPress={send} disabled={sending}>
        <Text style={styles.executeText}>
          {sending ? "Sending" : legs.length ? `Execute ${legs.length} leg${legs.length === 1 ? "" : "s"}` : "Add a leg"}
        </Text>
      </TouchableOpacity>

      {note ? <Text style={styles.note}>{note}</Text> : null}

      {sentId && outcome ? (
        <View style={styles.outcome}>
          <Text style={styles.price}>{`${outcome.basketName ?? outcome.clientId.slice(0, 8)}  ·  ${outcome.status}`}</Text>
          {outcome.message ? <Text style={styles.note}>{outcome.message}</Text> : null}
          {outcome.orders.map(leg => (
            <View key={leg.index} style={styles.outcomeLeg}>
              <Text style={styles.outcomeText} numberOfLines={1}>
                {`${leg.side} ${leg.quantity} ${leg.tradingsymbol} @ ${leg.price}`}
              </Text>
              <Text style={[styles.outcomeState, { color: leg.state === "rejected" ? colors.sell : leg.state === "filled" ? colors.buy : colors.muted }]}>
                {leg.state === "filled" || leg.state === "partially_filled"
                  ? `${leg.state} ${leg.filledQuantity ?? 0}/${leg.quantity}`
                  : leg.state}
              </Text>
            </View>
          ))}
          <Text style={styles.small}>{"The broker has the instruction; the outcome shows in Orders."}</Text>
        </View>
      ) : null}

      {picker}
    </ScrollView>
  );
}
