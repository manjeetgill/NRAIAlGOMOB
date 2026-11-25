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
  PanResponder,
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
import { chartFailureReason, chartPickerSections, ladderUnderlying, queryKeys, rupees, valueAt } from "@nraialgo/shared/api";
import type { Basket, OptionChainData, OptionDraftLeg, PlaceOrderLine } from "@nraialgo/shared/api";
import { useTheme } from "@/components/ThemeProvider";
import BasketDesk from "@/components/BasketDesk";
import { useApi } from "@/hooks/useApi";

/** One staged leg, as the trader left it. The contract prod resolves it into is not this screen's business. */
interface Leg {
  id: string;
  side: "BUY" | "SELL";
  right: "CE" | "PE";
  strike: string;
  lots: number;
  /**
   * The date this leg's contract lives on, and the only date its price, lot size and draft line are read
   * off. On a held leg this is the broker's fact and nothing on this screen may move it - a close aimed at
   * another date orders a contract nobody holds - while an added leg picks its own, so one press can widen
   * a calendar basket.
   */
  expiry: string;
  /**
   * Set on a row that came from a live basket: what the broker actually holds, in lots, and what it was
   * bought for. A held row is not a choice - its strike, right and side are facts about the book - so it
   * carries no steppers, and its x marks a close rather than deleting the row.
   */
  held?: { lots: number; lotSize: number; entry: string } | null;
}

/** One contract line this press sends: a close of something held, or something new. */
interface PlanLine {
  kind: "close" | "add";
  side: "BUY" | "SELL";
  right: "CE" | "PE";
  strike: string;
  expiry: string;
  lots: number;
  lotSize: number;
  price: number | null;
}

/**
 * An Adjust pressed on the Basket tab, held until the chain for that symbol has answered. Staging cannot
 * happen in the press itself: the strikes are only meaningful against the ladder of the date the basket
 * was bought on, and that read has not started yet when the symbol changes.
 */
interface Staging {
  underlying: string;
  /** The date the ladder is put on to work this basket - the earliest one it was bought on. */
  ladder: string;
  name: string;
  legs: Array<Omit<Leg, "id">>;
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
function legQuote(
  chain: OptionChainData,
  strike: string,
  right: "CE" | "PE",
  side: "BUY" | "SELL",
): { price: number; from: "bid" | "ask" | "ltp" } | null {
  const row = chain.rows.find(item => item.strike === strike);
  const quote = right === "CE" ? row?.call : row?.put;
  if (!quote) return null;
  const order: Array<["bid" | "ask" | "ltp", string | null]> = side === "BUY"
    ? [["ask", quote.ask], ["ltp", quote.ltp], ["bid", quote.bid]]
    : [["bid", quote.bid], ["ltp", quote.ltp], ["ask", quote.ask]];
  for (const [from, value] of order) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return { price: parsed, from };
  }
  return null;
}

/** Both sides of the book for one leg, so the screen can show what the placed price sits between. */
function bookOf(chain: OptionChainData | undefined, strike: string, right: "CE" | "PE") {
  const row = chain?.rows.find(item => item.strike === strike);
  const quote = row ? (right === "CE" ? row.call : row.put) : undefined;
  return { bid: amount(quote?.bid), ask: amount(quote?.ask), listed: !!row };
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
  const { useOptionChain, useOptionChains, useChainUnderlyings, useOrderDestinations, useOptionDrafts, usePlaceOrder, useOrderSnapshot } = useApi();
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
  // The sheet that asks for the name. Execute opens it; only its Send talks to prod.
  // TEMP DEVICE HARNESS - REVERT: opens on mount so the sheet can be measured without a broker session.
  const [sendSheet, setSendSheet] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sentId, setSentId] = useState("");
  const [tab, setTab] = useState<"builder" | "basket">("builder");
  const [staging, setStaging] = useState<Staging | null>(null);
  // Held legs marked for closing, as leg id -> how many of its lots this press closes. Kept against the
  // rows that still exist, so a leg that leaves the sheet takes its close mark with it instead of straining
  // after a phantom contract.
  const [marked, setMarked] = useState<Record<string, number>>({});
  const [expiryFor, setExpiryFor] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [touchPx, setTouchPx] = useState<number | null>(null);

  const { data: destinations } = useOrderDestinations(true);
  const account = destinations?.accounts?.[0];
  const { mutateAsync: createDrafts } = useOptionDrafts();
  const { mutateAsync: placeOrder } = usePlaceOrder();
  const { data: outcome } = useOrderSnapshot(sentId, sentId !== "");

  const wanted = chain ? chain.expiry : "";

  /** The held legs the trader has marked to close, narrowed to rows still on the sheet. */
  const closing = useMemo(() => Object.keys(marked).filter(id => legs.some(leg => leg.id === id && leg.held)), [marked, legs]);
  const adjusting = legs.some(leg => leg.held);

  /** How many lots of a marked held leg this press closes; the rest stays exactly as the broker holds it. */
  const closeLotsOf = (leg: Leg) => (closing.includes(leg.id) ? Math.min(leg.held?.lots ?? 1, Math.max(1, marked[leg.id] ?? 1)) : 0);

  // A leg on a date the ladder is not showing is priced off that date's own chain, so widening a calendar
  // basket never pays this expiry's premium for a contract on the next one. These reads do not re-poll:
  // the ladder on screen keeps its own three-second read and one broker lane places the trader's orders.
  const offDates = useMemo(
    () => [...new Set(legs.map(leg => leg.expiry))].filter(day => !!day && day !== wanted).sort(),
    [legs, wanted],
  );
  const extra = useOptionChains(underlying, offDates, offDates.length > 0);
  const chainOf = useMemo(() => {
    const byDate = new Map<string, OptionChainData>();
    if (chain) byDate.set(chain.expiry, chain);
    offDates.forEach((day, index) => {
      const read = extra[index];
      if (read?.data) byDate.set(day, read.data);
    });
    return byDate;
  }, [chain, offDates, extra]);

  // One reference per distinct basket, derived from what would actually be sent: the symbol, the expiry the
  // drafts are built for, then every leg. A retry of the same basket therefore keeps the reference prod
  // needs in order to answer it idempotently, while any real change gets a fresh one. The hand-rotated
  // reference this replaces got both halves wrong: the lot stepper clamps at one lot, so that tap burned a
  // reference on a basket that had not changed and let an identical one reach the broker twice, and tapping
  // another expiry changed every contract under the reference still held.
  //
  // A close mark is part of what would be sent, so it is part of the key: marking a wing and then undoing
  // it returns to the same instruction, while adding a close to a basket that was already staged must not
  // reuse the reference of the press that did not carry it.
  const basketKey = JSON.stringify([
    underlying,
    legs.map(leg => leg.held
      ? ["hold", leg.expiry, leg.strike, leg.right, leg.side, closeLotsOf(leg)]
      : [leg.expiry, leg.side, leg.right, String(leg.strike), leg.lots]),
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
    // The name goes with the legs: a basket typed for NIFTY must not file a RELIANCE basket under it.
    setBasket("");
    setOptionChainUnderlying(name);
  };

  /**
   * Stage a live basket's own contracts here so it can be narrowed or widened. Nothing is sent by this: the
   * trader presses Execute. The rows come from the desk's exact contracts, not from the symbol strings,
   * because a broker token and the contract the ladder lists are not always the same name - and a close must
   * be aimed at the contract the broker actually holds, so the held strike is kept as it arrived.
   */
  const adjustFromBasket = (row: Basket) => {
    setTab("builder");
    const title = row.name?.trim() || row.underlying;
    const contracts = row.payoffLegs;
    if (!contracts.length) {
      setStaging(null);
      setNote(`${title}: the desk does not hold this basket’s exact contracts, so there is nothing to stage. Its legs at the broker are unchanged.`);
      return;
    }
    // Finding #2: Reject mixed-underlying baskets. All legs must share one underlying so the builder
    // does not stage NIFTY + BANKNIFTY legs under one symbol and submit orders for the wrong underlying.
    const underlyings = [...new Set(contracts.map(leg => leg.underlying).filter(Boolean))];
    if (underlyings.length > 1) {
      setStaging(null);
      setNote(`${title}: this basket holds legs on ${underlyings.join(", ")}. The builder works on one underlying at a time — split it into separate baskets.`);
      return;
    }
    const dates = [...new Set(contracts.map(leg => leg.expiry))].sort();
    // The ladder and the drafts are both addressed by the canonical name, while the basket row carries the
    // broker's own code - staging under BSESEN asked prod for a chain it does not serve, so the legs never
    // arrived.
    const symbol = ladderUnderlying(row);
    // A leg the book shows fewer lots of than the payoff still carries has been partly exited, and closing
    // the difference would open a fresh position under the name of a close.
    const open = contracts.map(leg => {
      const held = row.legs.find(item => item.instrumentId === leg.instrumentId);
      return { leg, lots: held ? Math.min(leg.lots, held.lots) : leg.lots };
    });
    const flat = open.filter(item => item.lots > 0);
    if (!flat.length) {
      setStaging(null);
      setNote(`${title}: the broker shows no lots open on any of its ${contracts.length} legs, so there is nothing left to close or widen.`);
      return;
    }
    // Finding #3: Derive the ladder date from legs that remain open (not closed), not always dates[0].
    // If the November leg is flat and December is open, dates[0] would pick November and reject the adjustment.
    const openDates = [...new Set(flat.map(item => item.leg.expiry))].sort();
    const ladderDate = openDates[0] || dates[0];
    setStaging({
      underlying: symbol,
      ladder: ladderDate,
      name: title,
      legs: flat.map(({ leg, lots }) => ({
        side: leg.action === "buy" ? "BUY" : "SELL",
        right: leg.right,
        strike: leg.strike,
        lots,
        expiry: leg.expiry,
        held: { lots, lotSize: leg.lotSize, entry: leg.entryPrice },
      })),
    });
    if (symbol.toUpperCase() !== underlying.toUpperCase()) setOptionChainUnderlying(symbol);
  };

  // The basket's legs land only once the ladder they will be priced against has answered, on the date the
  // basket was actually bought on. Before that the strikes of another date would be staged as if they were
  // the held contracts, and an unlisted date means the held contracts no longer exist to adjust.
  useEffect(() => {
    if (!staging || !chain || chain.underlying.toUpperCase() !== staging.underlying.toUpperCase()) return;
    if (!staging.ladder || !chain.expiries.includes(staging.ladder)) {
      setStaging(null);
      setNote(`${staging.ladder || "That expiry"} is no longer a listed ${staging.underlying} date, so its legs cannot be staged here. Nothing was sent.`);
      return;
    }
    if (chain.expiry !== staging.ladder) {
      setDate(staging.ladder);
      return;
    }
    const ladder = chain.rows.filter(row => row.call || row.put).map(row => row.strike);
    if (!ladder.length) {
      setStaging(null);
      setNote(`${staging.underlying} answered ${staging.ladder} with no strikes, so nothing could be staged.`);
      return;
    }
    const listed = new Set(ladder);
    // Only a leg on this ladder can be checked against it: a leg the broker holds on another date is
    // priced off that date's own read, and an unpriced one stops the send rather than guessing.
    const offLadder = staging.legs.filter(leg => leg.expiry === staging.ladder && !listed.has(leg.strike));
    const dates = [...new Set(staging.legs.map(leg => leg.expiry))];
    setStaging(null);
    setMarked({});
    edit(() => staging.legs.map((leg, index) => ({ ...leg, id: `hold-${index}-${leg.expiry}-${leg.strike}-${leg.right}` })));
    setBasket(staging.name);
    setNote(
      `${staging.name} staged with ${staging.legs.length} held legs${dates.length > 1 ? ` across ${dates.length} dates` : ` from ${dates[0]}`}. Press x on a leg to close it, then step the lots down to close only part of it; a leg without a mark is left exactly as the broker holds it.` +
      (offLadder.length
        ? ` ${offLadder.length} held strike${offLadder.length === 1 ? "" : "s"} (${offLadder.map(leg => `${leg.strike}${leg.right}`).join(", ")}) are not on this ladder, so they have no broker price and sending them is refused.`
        : ""),
    );
  }, [staging, chain]);

  const strikes = useMemo(
    () => (chain?.rows ?? []).filter(row => row.call || row.put).map(row => row.strike),
    [chain]
  );
  /** The ladder a leg of one date may be stepped over, which is not necessarily the date on screen. */
  const ladderOf = (day: string) => (chainOf.get(day)?.rows ?? []).filter(row => row.call || row.put).map(row => row.strike);
  /** Empty until the chain names one; both uses fall back to the middle of the listed ladder. */
  const atTheMoney = useMemo(() => (chain?.rows ?? []).find(row => row.isAtTheMoney)?.strike ?? "", [chain]);
  const lotSize = chain?.lotSize ?? 0;

  /** What one leg would leave at, read off its own date's book. */
  const quoteOf = (leg: Leg, side: "BUY" | "SELL") => {
    const read = chainOf.get(leg.expiry);
    return read ? legQuote(read, leg.strike, leg.right, side) : null;
  };
  const sizeOf = (leg: Leg) => leg.held?.lotSize || chainOf.get(leg.expiry)?.lotSize || lotSize;

  const stage = (template: Template) => {
    if (!strikes.length) return;
    const atm = strikes.indexOf(atTheMoney);
    const anchor = atm < 0 ? Math.floor(strikes.length / 2) : atm;
    edit(current => template.legs.map((leg, index) => ({
      id: `${template.id}-${index}`,
      side: leg.side,
      right: leg.right,
      lots: leg.lots,
      expiry: wanted,
      // Clamped rather than dropped: a three-step wing on a short stock ladder is still the furthest
      // listed strike the trader meant, and silently losing a leg would send a naked one.
      strike: strikes[Math.min(strikes.length - 1, Math.max(0, anchor + leg.step))],
    })));
  };

  /**
   * When the trader taps another date chip while unexecuted legs are staged, re-target those legs
   * to the new expiry. Re-maps strikes to the nearest listed strikes on the new ladder (or re-anchors
   * the active template if one is matched) so the legs stay valid, re-price immediately, and recalculate
   * the single-expiry payoff. Held legs from the broker are never re-targeted: their expiry is the broker's fact.
   */
  const switchExpiry = (targetDay: string) => {
    if (targetDay === chain?.expiry && targetDay === date) return;
    setDate(targetDay);
    setSentId("");
    setNote(null);

    // If adjusting held broker legs or there are no unheld legs, do not rewrite legs.
    if (adjusting || legs.length === 0) return;

    // Check if current legs match a known template
    const templateMatch = TEMPLATES.find(template =>
      template.legs.length === legs.length &&
      template.legs.every((leg, index) => legs[index]?.side === leg.side && legs[index]?.right === leg.right && legs[index]?.lots === leg.lots)
    );

    const targetChain = chainOf.get(targetDay);
    const targetLadder = (targetChain?.rows ?? []).filter(row => row.call || row.put).map(row => row.strike);
    const targetAtm = (targetChain?.rows ?? []).find(row => row.isAtTheMoney)?.strike ?? "";

    if (templateMatch && targetLadder.length > 0) {
      const atmIdx = targetLadder.indexOf(targetAtm);
      const anchor = atmIdx < 0 ? Math.floor(targetLadder.length / 2) : atmIdx;
      edit(current => templateMatch.legs.map((leg, index) => ({
        id: `${templateMatch.id}-${index}`,
        side: leg.side,
        right: leg.right,
        lots: leg.lots,
        expiry: targetDay,
        strike: targetLadder[Math.min(targetLadder.length - 1, Math.max(0, anchor + leg.step))],
      })));
    } else {
      // Re-target unheld legs to the new expiry. If target ladder is ready, snap to nearest listed strike;
      // otherwise update the expiry string and let chain resolution price it.
      edit(current => current.map(item => {
        if (item.held) return item;
        let newStrike = item.strike;
        if (targetLadder.length > 0 && !targetLadder.includes(item.strike)) {
          const num = Number(item.strike);
          if (Number.isFinite(num)) {
            newStrike = targetLadder.reduce((best, s) =>
              Math.abs(Number(s) - num) < Math.abs(Number(best) - num) ? s : best, targetLadder[0]
            );
          } else {
            newStrike = targetLadder[0];
          }
        }
        return { ...item, expiry: targetDay, strike: newStrike };
      }));
    }
  };

  const addLeg = () => {
    if (!strikes.length) return;
    edit(current => [...current, {
      id: `leg-${current.length}-${Date.now()}`,
      side: "BUY",
      right: "CE",
      lots: 1,
      expiry: wanted,
      strike: atTheMoney && strikes.includes(atTheMoney) ? atTheMoney : strikes[Math.floor(strikes.length / 2)],
    }]);
  };

  const step = (leg: Leg, field: "strike" | "lots", direction: 1 | -1) =>
    edit(current => current.map(item => {
      if (item.id !== leg.id) return item;
      if (field === "lots") return { ...item, lots: Math.min(99, Math.max(1, item.lots + direction)) };
      const ladder = ladderOf(item.expiry);
      if (!ladder.length) return item;
      const index = ladder.indexOf(item.strike);
      const next = Math.min(ladder.length - 1, Math.max(0, (index < 0 ? 0 : index) + direction));
      return { ...item, strike: ladder[next] };
    }));

  const flip = (leg: Leg, field: "side" | "right") =>
    edit(current => current.map(item => item.id === leg.id
      ? { ...item, [field]: field === "side" ? (item.side === "BUY" ? "SELL" : "BUY") : (item.right === "CE" ? "PE" : "CE") }
      : item));

  const remove = (leg: Leg) => edit(current => current.filter(item => item.id !== leg.id));

  /** Mark a held leg to close all of it, or take the mark back off. Nothing is sent by this press of the x. */
  const markClose = (leg: Leg) => {
    setSentId("");
    setNote(null);
    setMarked(current => {
      const next = { ...current };
      if (next[leg.id]) delete next[leg.id];
      else next[leg.id] = leg.held?.lots ?? 1;
      return next;
    });
  };

  /** Narrow a marked close to some of the leg's lots; the broker keeps the rest untouched. */
  const setCloseLots = (leg: Leg, direction: 1 | -1) => {
    setSentId("");
    setNote(null);
    const max = leg.held?.lots ?? 1;
    setMarked(current => ({ ...current, [leg.id]: Math.min(max, Math.max(1, (current[leg.id] ?? max) + direction)) }));
  };

  /**
   * Every contract line Execute would send. A held leg that was not marked appears nowhere: the broker
   * keeps it and no order is raised for it. A marked one is bought back or sold on the opposite side at the
   * strike and on the date the book holds it, for only the lots the trader left on the close.
   */
  const plan: PlanLine[] = legs.flatMap((leg): PlanLine[] => {
    const closingNow = !!leg.held && closing.includes(leg.id);
    if (leg.held && !closingNow) return [];
    const side = closingNow ? (leg.side === "BUY" ? "SELL" : "BUY") : leg.side;
    return [{
      kind: leg.held ? "close" : "add",
      side,
      right: leg.right,
      strike: leg.strike,
      expiry: leg.expiry,
      lots: closingNow ? closeLotsOf(leg) : leg.lots,
      lotSize: sizeOf(leg),
      price: quoteOf(leg, side)?.price ?? null,
    }];
  });
  const closes = plan.filter(line => line.kind === "close").length;
  const adds = plan.filter(line => line.kind === "add").length;
  /** Lots this press takes off the book, which is not the number of legs when a close is partial. */
  const closeLots = plan.reduce((sum, line) => sum + (line.kind === "close" ? line.lots : 0), 0);
  // The button says whether a marked leg leaves whole or only partly trimmed, so a stepped-down close can
  // never be read as the whole leg going out.
  const wholeCloses = legs.filter(leg => !!leg.held && closing.includes(leg.id) && closeLotsOf(leg) === leg.held.lots).length;
  const closeText = !closes ? "" : wholeCloses === closes ? `Close ${closes}` : `Close ${closeLots} lots`;

  // The money this press moves: the closes it sends and the legs it adds, each at the price the book
  // would actually leave at. Held legs nobody marked are not part of it - they were paid for already.
  const net = plan.reduce((sum, line) =>
    line.price === null ? sum : sum + (line.side === "BUY" ? 1 : -1) * line.price * line.lots * line.lotSize, 0);

  /**
   * The curve is drawn for the book this press leaves behind: a held leg nobody marked stays whole at the
   * premium it was already bought for, a partly marked one keeps only the lots that were not closed, an
   * added leg enters at its own date's price, and a fully closed leg has left the book.
   */
  const priced = legs.flatMap((leg) => {
    const left = (leg.held?.lots ?? leg.lots) - closeLotsOf(leg);
    if (left <= 0) return [];
    const premium = leg.held ? amount(leg.held.entry) : quoteOf(leg, leg.side)?.price ?? null;
    return [{ leg, qty: left * sizeOf(leg), premium }];
  });

  // The payoff is drawn from the same premiums the leg rows show, so the curve and the net figure can
  // never disagree. No legs is a true flat line at zero; an unpriced leg is an unknown, and the curve
  // stops rather than drawing the payoff of a basket the trader did not stage.
  const unpricedLeg = priced.find(item => item.premium === null)?.leg ?? null;
  const spotNow = chain ? amount(chain.spot.price) : null;
  // A leg with no lot size has no quantity, and a zero-quantity wing draws a payoff the trader does not
  // have - the curve stops and says which leg instead.
  const sizeless = priced.find(item => item.qty <= 0)?.leg ?? null;
  // A calendar basket kinks at every strike of every date it holds, so the curve spans the union of the
  // ladders its legs are priced on rather than only the one currently on screen.
  const curveLadder = useMemo(() => {
    const grid = new Set<number>();
    for (const day of new Set(legs.map(leg => leg.expiry))) {
      for (const row of chainOf.get(day)?.rows ?? []) {
        if (row.call || row.put) {
          const value = Number(row.strike);
          if (Number.isFinite(value)) grid.add(value);
        }
      }
    }
    return [...grid].sort((a, b) => a - b);
  }, [legs, chainOf]);
  // Finding #1: Detect calendar baskets (multiple distinct expiries). buildPayoff treats all legs as
  // expiring at the same time, which incorrectly cancels calendar spread legs with different expiries.
  // Only call buildPayoff for single-expiry baskets.
  const distinctExpiries = new Set(legs.map(leg => leg.expiry));
  const isCalendarBasket = distinctExpiries.size > 1;

  // Payoff calculation memoization
  const payoff = useMemo(() => {
    if (!chain || unpricedLeg || sizeless || curveLadder.length < 3 || isCalendarBasket) return null;
    return buildPayoff(
      priced.map(item => ({
        strike: Number(item.leg.strike),
        right: item.leg.right,
        sign: item.leg.side === "BUY" ? 1 : -1,
        premium: item.premium as number,
        qty: item.qty,
      })),
      curveLadder,
      spotNow,
    );
  }, [chain, unpricedLeg, sizeless, curveLadder, isCalendarBasket, priced, spotNow]);

  // Chart and panResponder must be computed before any early returns to satisfy React's rules of hooks.
  const chart = useMemo(() => {
    if (!payoff) return null;
    const w = Math.round(screenWidth - 42);
    const h = 132;
    const padX = 5;
    const padTop = 10;
    const padBottom = 12;
    const fullLo = Math.min(...payoff.xs);
    const fullHi = Math.max(...payoff.xs);
    const center = (fullLo + fullHi) / 2;
    const halfRange = (fullHi - fullLo) / 2 / zoom;
    const lo = center - halfRange;
    const hi = center + halfRange;
    const yMin = Math.min(...payoff.ys, 0);
    const yMax = Math.max(...payoff.ys, 0);
    const yLo = yMax - yMin < 0.005 ? yMin - 1 : yMin;
    const yHi = yMax - yMin < 0.005 ? yMax + 1 : yMax;
    const px = (x: number) => padX + (((x - lo) / (hi - lo || 1)) * (w - padX * 2));
    const py = (y: number) => padTop + ((1 - (y - yLo) / (yHi - yLo || 1)) * (h - padTop - padBottom));
    const visibleIdx = payoff.xs.map((x, i) => i).filter(i => payoff.xs[i] >= lo && payoff.xs[i] <= hi);
    const d = visibleIdx.map((i, j) => `${j === 0 ? "M" : "L"}${px(payoff.xs[i]).toFixed(1)},${py(payoff.ys[i]).toFixed(1)}`).join("");
    return {
      w,
      h,
      px,
      py,
      zero: py(0),
      lo,
      hi,
      fullLo,
      fullHi,
      d,
    };
  }, [payoff, screenWidth, zoom]);

  const touchSpot = chart && touchPx !== null
    ? chart.lo + ((touchPx - 5) / (chart.w - 10)) * (chart.hi - chart.lo)
    : null;
  const touchValue = touchSpot !== null && payoff ? valueAt(payoff.xs, payoff.ys, touchSpot) : null;

  const moveRaf = useRef<number | null>(null);
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (evt) => setTouchPx(evt.nativeEvent.locationX),
    onPanResponderMove: (evt) => {
      const x = evt.nativeEvent.locationX;
      if (moveRaf.current !== null) cancelAnimationFrame(moveRaf.current);
      moveRaf.current = requestAnimationFrame(() => {
        setTouchPx(x);
      });
    },
    onPanResponderRelease: () => {
      if (moveRaf.current !== null) cancelAnimationFrame(moveRaf.current);
      setTouchPx(null);
    },
    onPanResponderTerminate: () => {
      if (moveRaf.current !== null) cancelAnimationFrame(moveRaf.current);
      setTouchPx(null);
    },
  }), [chart]);

  /** Why this basket cannot go out yet, in the words the screen shows, or null when it can. */
  const refusal = (): string | null => {
    if (!chain || !wanted) return "The chain has not answered yet. Nothing was sent.";
    if (!legs.length) return "Add a leg first.";
    if (!plan.length) {
      return `${closes} leg${closes === 1 ? "" : "s"} marked to close and ${adds} added - nothing to send. The broker still holds every leg of this basket.`;
    }
    if (plan.length > 8) return "Prod takes eight legs in one instruction. Remove some.";
    if (!account) return "No connected broker account for this sign-in. Nothing was sent.";
    const unpriced = plan.find(line => line.price === null);
    if (unpriced) return `${unpriced.strike} ${unpriced.right} ${unpriced.expiry} has no price from the broker. Nothing was sent.`;
    return null;
  };

  /**
   * The name the sheet opens with. An adjusted basket keeps its own so the press writes back onto the card
   * the trader is looking at, while a new one is named by the shape it is staged in - prod files every later
   * order carrying the same name onto that same basket, so the name is part of the instruction, not a label.
   */
  const suggestedName = (): string => {
    if (basket.trim()) return basket.trim();
    const shape = TEMPLATES.find(template => template.legs.length === legs.length
      && template.legs.every((leg, index) => {
        const current = legs[index];
        return !!current && current.side === leg.side && current.right === leg.right && current.lots === leg.lots;
      }));
    const dates = [...new Set(legs.map(leg => leg.expiry))].sort();
    const stem = shape
      ? shape.name
      : legs.map(leg => `${leg.side === "SELL" ? "S" : "B"}${leg.strike}${leg.right}`).join(" ");
    return `${stem} ${underlying} ${dates.join("/")}`.slice(0, 80);
  };

  const send = async () => {
    const reason = refusal();
    if (reason) { setSendSheet(false); setNote(reason); return; }
    // The name is required, not optional: an unnamed press is an intent no desk card can be filed under.
    const name = basket.trim();
    if (!name) { setSendSheet(false); setNote("Name the basket before sending. Nothing was sent."); return; }

    // Each line names its own date: prod resolves a leg against the ladder of the expiry it is sent with,
    // so a basket that spans two dates closes and adds on the right contracts rather than all on one.
    const draftLegs: OptionDraftLeg[] = plan.map(line => ({
      expiry: line.expiry,
      strike: line.strike,
      right: line.right,
      side: line.side,
      lots: line.lots,
      lotSize: line.lotSize,
      price: (line.price as number).toFixed(2),
    }));

    // Taken before the first await: the reference and the legs must be the same basket's, because a leg
    // tapped while the drafts were being named would otherwise send the old contracts under a reference
    // the edited basket is holding.
    const reference = referenceFor(basketKey);
    setSendSheet(false);
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
        basketName: name,
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

  /**
   * Execute. An adjustment of a basket the desk already names goes straight out under that name: asking
   * again would only invent a second name for one basket, and prod files same-named orders on one card.
   * A new basket is named first, and a name the trader cleared forces the prompt back, because an unnamed
   * intent is one no desk card can hold.
   */
  const ask = () => {
    const reason = refusal();
    if (reason) { setNote(reason); return; }
    if (adjusting && basket.trim()) { send(); return; }
    setBasket(suggestedName());
    setNote(null);
    setSendSheet(true);
  };

  const colors = useMemo(() => resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#64748b", border: "#334155", brand: "#38bdf8", buy: "#22c55e", sell: "#ef4444", warn: "#f59e0b" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", brand: "#0284c7", buy: "#16a34a", sell: "#dc2626", warn: "#b45309" }, [resolvedTheme]);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    body: { padding: 12, gap: 12 },
    tabs: { flexDirection: "row", gap: 6 },
    tab: { flex: 1, paddingVertical: 9, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, alignItems: "center" },
    tabOn: { borderColor: colors.brand, backgroundColor: `${colors.brand}22` },
    tabText: { fontSize: 13, fontWeight: "700", color: colors.muted },
    tabTextOn: { color: colors.text },
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
    held: { fontSize: 15, fontWeight: "700", color: colors.text, flex: 1 },
    struck: { textDecorationLine: "line-through", color: colors.muted },
    expiry: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 7, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
    expiryText: { fontSize: 11, fontWeight: "700", color: colors.muted, letterSpacing: 0.3 },
    bid: { fontSize: 12, fontWeight: "700", color: colors.buy },
    ask: { fontSize: 12, fontWeight: "700", color: colors.sell },
    placed: { fontSize: 12, fontWeight: "700", color: colors.text },
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
    zoomBtn: { width: 28, height: 28, borderRadius: 6, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", backgroundColor: colors.card },
    tooltip: { position: "absolute", backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, gap: 2, elevation: 3, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 2 },
    tooltipSpot: { fontSize: 11, fontWeight: "700", color: colors.text },
    tooltipValue: { fontSize: 10.5, fontWeight: "600" },
    execute: { height: 52, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.brand },
    executeText: { fontSize: 16, fontWeight: "700", color: "#ffffff" },
    cancel: { height: 44, borderRadius: 10, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
    cancelText: { fontSize: 14, fontWeight: "700", color: colors.muted },
    note: { fontSize: 12, color: colors.warn, lineHeight: 17 },
    outcome: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.card, padding: 10, gap: 6 },
    outcomeLeg: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
    outcomeText: { fontSize: 12, color: colors.text, flex: 1 },
    outcomeState: { fontSize: 12, fontWeight: "700", color: colors.muted },
    center: { padding: 32, alignItems: "center", gap: 10 },
    centerText: { fontSize: 13, color: colors.muted, textAlign: "center" },
  }), [colors]);

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
      {chain ? (
        <Text style={styles.meta}>
          {`${spot === null ? "" : `Spot ${formatNumber(spot, 2)}`}  ·  lot ${lotSize}  ·  ${strikes.length} strikes`}
        </Text>
      ) : null}
    </View>
  );

  const closePicker = () => {
    setSymbolOpen(false);
    setSearch("");
  };

  /** Re-aim one added leg at another listed date. Held legs never come here: their date is the broker's. */
  const pickExpiry = (day: string) => {
    const id = expiryFor;
    setExpiryFor(null);
    if (!id) return;
    edit(current => current.map(item => item.id === id ? { ...item, expiry: day } : item));
  };

  // The two halves of one desk: stage and send on Builder, read what is held on Basket. The builder keeps
  // its own state across the switch, so a basket adjusted from the desk arrives with its legs still staged.
  const tabs = (
    <View style={styles.tabs}>
      <TouchableOpacity style={[styles.tab, tab === "builder" && styles.tabOn]} onPress={() => setTab("builder")} accessibilityRole="tab" accessibilityState={{ selected: tab === "builder" }}>
        <Text style={[styles.tabText, tab === "builder" && styles.tabTextOn]}>Builder</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.tab, tab === "basket" && styles.tabOn]} onPress={() => setTab("basket")} accessibilityRole="tab" accessibilityState={{ selected: tab === "basket" }}>
        <Text style={[styles.tabText, tab === "basket" && styles.tabTextOn]}>Basket</Text>
      </TouchableOpacity>
    </View>
  );

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

  // TEMP DEVICE HARNESS - REVERT. The sheet is mounted in the no-chain branch and opened on mount, because
  // Expo Go on this box has no broker session and the shipped body never reaches Execute without one.
  const nameSheet = (
    <Modal visible={sendSheet} animationType="slide" onRequestClose={() => setSendSheet(false)}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
        <View style={styles.sheet}>
          <View style={styles.sheetHead}>
            <Text style={styles.title}>Name this basket</Text>
            <TouchableOpacity
              onPress={() => setSendSheet(false)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Cancel without sending"
            >
              <Ionicons name="close" size={22} color={colors.muted} />
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.field}
            value={basket}
            onChangeText={setBasket}
            placeholder={`${underlying} ${wanted}`}
            placeholderTextColor={colors.muted}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={80}
            accessibilityLabel="Basket name"
          />
          <Text style={styles.small}>
            {`${[closeText, adds ? `Add ${adds}` : ""].filter(Boolean).join("  ·  ")}  ·  ${net >= 0 ? "Net credit" : "Net debit"} ₹${formatNumber(Math.abs(net), 2)}`}
          </Text>
          <Text style={styles.small}>Orders under this name join one card on the Basket desk.</Text>
          <TouchableOpacity style={styles.execute} onPress={send} disabled={sending} accessibilityRole="button" accessibilityLabel="Send this basket to the broker">
            <Text style={styles.executeText}>{sending ? "Sending" : "Send"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.cancel} onPress={() => setSendSheet(false)} accessibilityRole="button" accessibilityLabel="Cancel and stay on the builder">
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );

  // The desk needs no chain read of its own: one /v1/baskets response carries the legs, the marks, the
  // booked P&L and the contracts, so the Basket tab works even while this symbol's ladder is loading.
  if (tab === "basket") {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.body}>
        {tabs}
        <BasketDesk onAdjust={adjustFromBasket} />
        {picker}
      </ScrollView>
    );
  }

  if (!chain) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.body}>
        {tabs}
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
        {nameSheet}
      </ScrollView>
    );
  }

  const activeTemplate = TEMPLATES.find(template =>
    template.legs.length === legs.length &&
    template.legs.every((leg, index) => legs[index]?.side === leg.side && legs[index]?.right === leg.right && legs[index]?.lots === leg.lots)
  )?.id;

  // One leg's date is chosen from the same listed ladder the strip above offers, so a calendar basket is
  // staged on this screen instead of being sent back to the web desk.
  const expirySheet = (
    <Modal visible={!!expiryFor} animationType="slide" onRequestClose={() => setExpiryFor(null)}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
        <View style={styles.sheet}>
          <View style={styles.sheetHead}>
            <Text style={styles.title}>Expiry of this leg</Text>
            <TouchableOpacity
              onPress={() => setExpiryFor(null)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Close the expiry list"
            >
              <Ionicons name="close" size={22} color={colors.muted} />
            </TouchableOpacity>
          </View>
          <FlatList
            data={chain.expiries}
            keyExtractor={day => day}
            style={{ maxHeight: 380 }}
            renderItem={({ item: day }) => (
              <TouchableOpacity style={styles.row} onPress={() => pickExpiry(day)} accessibilityRole="button" accessibilityLabel={`Use ${day} for this leg`}>
                <Text style={styles.rowName}>{day}</Text>
                {day === legs.find(leg => leg.id === expiryFor)?.expiry ? <Ionicons name="checkmark" size={18} color={colors.brand} /> : null}
              </TouchableOpacity>
            )}
          />
        </View>
      </View>
    </Modal>
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.body}>
      {tabs}
      {header}

      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        data={chain.expiries}
        keyExtractor={day => day}
        renderItem={({ item: day }) => (
          <TouchableOpacity style={[styles.dateChip, day === chain.expiry && styles.dateChipOn]} onPress={() => switchExpiry(day)}>
            <Text style={styles.dateText}>{day}</Text>
          </TouchableOpacity>
        )}
        contentContainerStyle={styles.dates}
        style={{ marginHorizontal: -12 }}
      />

      {/* A template replaces the whole sheet, so it has no place on a basket the broker is already holding. */}
      {adjusting ? null : (
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
      )}

      {legs.map(leg => {
        // A held leg is quoted at the price it would leave at, which is the opposite side of the book.
        const closingNow = !!leg.held && closing.includes(leg.id);
        const side = closingNow ? (leg.side === "BUY" ? "SELL" : "BUY") : leg.side;
        const quote = quoteOf(leg, side);
        const entry = leg.held ? amount(leg.held.entry) : null;
        const heldLots = leg.held?.lots ?? leg.lots;
        const going = closeLotsOf(leg);
        const left = heldLots - going;
        const size = sizeOf(leg);
        const read = chainOf.get(leg.expiry);
        const twoSided = bookOf(read, leg.strike, leg.right);
        const price = (value: number | null) => (value === null ? "none" : formatNumber(value, 2));
        return (
          <View key={leg.id} style={[styles.leg, leg.held && { borderColor: closingNow ? colors.warn : colors.brand }]}>
            <View style={styles.legRow}>
              {leg.held ? (
                // The contract is the broker's, not a choice: no flip, no strike stepper, only the close mark.
                <Text style={[styles.held, closingNow && styles.struck]}>{`${leg.side} ${leg.strike} ${leg.right}`}</Text>
              ) : (
                <>
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
                </>
              )}
              <TouchableOpacity
                style={styles.stepButton}
                onPress={() => (leg.held ? markClose(leg) : remove(leg))}
                accessibilityRole="button"
                accessibilityLabel={leg.held
                  ? (closingNow ? `Keep ${leg.strike} ${leg.right} open` : `Close ${leg.strike} ${leg.right}`)
                  : `Remove ${leg.strike} ${leg.right}`}
              >
                <Ionicons
                  name={leg.held ? (closingNow ? "arrow-undo" : "close") : "close"}
                  size={16}
                  color={closingNow ? colors.warn : colors.muted}
                />
              </TouchableOpacity>
            </View>

            <View style={styles.legRow}>
              {leg.held ? (
                // A held leg's date is the broker's fact, so it is named and never offered as a choice.
                <Text style={styles.expiryText}>{leg.expiry}</Text>
              ) : (
                <TouchableOpacity
                  style={styles.expiry}
                  onPress={() => setExpiryFor(leg.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Change the expiry of this leg, currently ${leg.expiry}`}
                >
                  <Text style={styles.expiryText}>{leg.expiry}</Text>
                  <Ionicons name="chevron-down" size={12} color={colors.muted} />
                </TouchableOpacity>
              )}
              {leg.held ? (
                closingNow ? (
                  <>
                    <View style={styles.stepper}>
                      <TouchableOpacity style={styles.stepButton} onPress={() => setCloseLots(leg, -1)} accessibilityLabel={`Close one lot fewer of ${leg.strike} ${leg.right}`}>
                        <Ionicons name="remove" size={16} color={colors.text} />
                      </TouchableOpacity>
                      <Text style={[styles.price, { minWidth: 92, textAlign: "center" }]}>{`close ${going} of ${heldLots}`}</Text>
                      <TouchableOpacity style={styles.stepButton} onPress={() => setCloseLots(leg, 1)} accessibilityLabel={`Close one more lot of ${leg.strike} ${leg.right}`}>
                        <Ionicons name="add" size={16} color={colors.text} />
                      </TouchableOpacity>
                    </View>
                    <Text style={styles.small}>{left > 0 ? `${left} lot${left > 1 ? "s" : ""} left open` : "whole leg closes"}</Text>
                  </>
                ) : (
                  <Text style={styles.small}>{`${heldLots} lot${heldLots > 1 ? "s" : ""}  ·  ${heldLots * size} qty`}</Text>
                )
              ) : (
                <>
                  <View style={styles.stepper}>
                    <TouchableOpacity style={styles.stepButton} onPress={() => step(leg, "lots", -1)}>
                      <Ionicons name="remove" size={16} color={colors.text} />
                    </TouchableOpacity>
                    <Text style={[styles.price, { minWidth: 60, textAlign: "center" }]}>{`${leg.lots} lot${leg.lots > 1 ? "s" : ""}`}</Text>
                    <TouchableOpacity style={styles.stepButton} onPress={() => step(leg, "lots", 1)}>
                      <Ionicons name="add" size={16} color={colors.text} />
                    </TouchableOpacity>
                  </View>
                  <Text style={styles.small}>{`${leg.lots * size} qty`}</Text>
                </>
              )}
            </View>

            <View style={styles.legRow}>
              {twoSided.listed ? (
                <Text style={styles.small}>
                  {"Bid "}
                  <Text style={styles.bid}>{price(twoSided.bid)}</Text>
                  {"   Ask "}
                  <Text style={styles.ask}>{price(twoSided.ask)}</Text>
                </Text>
              ) : null}
              <Text style={[styles.placed, { flex: 1, textAlign: "right" }, closingNow && { color: colors.warn }]}>
                {leg.held && !closingNow
                  ? entry === null ? "" : formatNumber(entry, 2)
                  : quote === null
                    ? ""
                    : `${closingNow ? "Close" : side === "BUY" ? "Buy" : "Sell"} at ${formatNumber(quote.price, 2)}`}
              </Text>
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

      <TextInput
        style={styles.field}
        value={basket}
        onChangeText={setBasket}
        placeholder={`Basket name - ${underlying} ${wanted}`}
        placeholderTextColor={colors.muted}
        autoCapitalize="characters"
        maxLength={80}
        accessibilityLabel="Basket name"
      />

      {plan.length ? (
        <View style={styles.net}>
          <Text style={[styles.netValue, { color: net >= 0 ? colors.sell : colors.buy }]}>{`₹${formatNumber(Math.abs(net), 2)}`}</Text>
        </View>
      ) : null}

      {payoff && chart ? (
        <View style={styles.payoff}>
          <View style={styles.payoffHead}>
            <Text style={styles.small}>Payoff</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {payoff.atSpot === null ? null : (
                <Text style={[styles.price, { color: payoff.atSpot >= 0 ? colors.buy : colors.sell }]}>
                  {`${payoff.atSpot >= 0 ? "+" : "-"}₹${formatNumber(Math.abs(payoff.atSpot), 0)}`}
                </Text>
              )}
              <View style={{ flexDirection: "row", gap: 4 }}>
                <TouchableOpacity
                  style={styles.zoomBtn}
                  onPress={() => setZoom(z => Math.min(z * 1.5, 10))}
                  accessibilityRole="button"
                  accessibilityLabel="Zoom in on the payoff chart"
                >
                  <Ionicons name="add" size={16} color={colors.brand} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.zoomBtn, zoom <= 1 && { opacity: 0.3 }]}
                  onPress={() => setZoom(z => Math.max(z / 1.5, 1))}
                  disabled={zoom <= 1}
                  accessibilityRole="button"
                  accessibilityLabel="Zoom out on the payoff chart"
                >
                  <Ionicons name="remove" size={16} color={colors.brand} />
                </TouchableOpacity>
              </View>
            </View>
          </View>
          <View {...panResponder.panHandlers} style={{ position: "relative" }}>
            <Svg width={chart.w} height={chart.h}>
              <Line x1={0} y1={chart.zero} x2={chart.w} y2={chart.zero} stroke={colors.border} strokeWidth={1} strokeDasharray="4 3" />
              <Path d={chart.d} stroke={colors.brand} strokeWidth={2} fill="none" />
              {payoff.breakEvens.filter(strike => strike >= chart.lo && strike <= chart.hi).map(strike => (
                <Circle key={`break-${strike}`} cx={chart.px(strike)} cy={chart.zero} r={3} fill={colors.warn} />
              ))}
              {spot !== null && spot >= chart.lo && spot <= chart.hi && payoff.atSpot !== null ? (
                <>
                  <Line x1={chart.px(spot)} y1={10} x2={chart.px(spot)} y2={chart.h - 12} stroke={colors.muted} strokeWidth={1} opacity={0.6} />
                  <Circle cx={chart.px(spot)} cy={chart.py(payoff.atSpot)} r={3.5} fill={colors.text} />
                </>
              ) : null}
              {touchSpot !== null && touchPx !== null && touchPx >= 5 && touchPx <= chart.w - 5 ? (
                <>
                  <Line x1={chart.px(touchSpot)} y1={0} x2={chart.px(touchSpot)} y2={chart.h} stroke={colors.text} strokeWidth={0.5} opacity={0.4} />
                  {touchValue !== null ? (
                    <Circle cx={chart.px(touchSpot)} cy={chart.py(touchValue)} r={3} fill={colors.brand} />
                  ) : null}
                </>
              ) : null}
            </Svg>
            {touchSpot !== null && touchPx !== null ? (
              <View style={[
                styles.tooltip,
                {
                  left: Math.min(Math.max(touchPx - 50, 0), chart.w - 100),
                  top: 4,
                },
              ]}>
                <Text style={styles.tooltipSpot}>{formatNumber(touchSpot, 0)}</Text>
                {touchValue !== null ? (
                  <Text style={[styles.tooltipValue, { color: touchValue >= 0 ? colors.buy : colors.sell }]}>
                    {`${touchValue >= 0 ? "+" : ""}${rupees(touchValue, true) ?? "—"}`}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
          <View style={styles.payoffAxis}>
            <Text style={styles.payoffAxisText}>{formatNumber(chart.lo, 0)}</Text>
            <Text style={styles.payoffAxisText}>{spot === null ? "no spot" : `spot ${formatNumber(spot, 0)}`}</Text>
            <Text style={styles.payoffAxisText}>{formatNumber(chart.hi, 0)}</Text>
          </View>
          {payoff.breakEvens.length ? (
            <Text style={styles.payoffFoot}>
              {`Break even ${payoff.breakEvens.slice(0, 4).map(strike => formatNumber(strike, 0)).join("  ·  ")}`}
            </Text>
          ) : null}
        </View>
      ) : legs.length ? (
        <View style={styles.payoff}>
          <View style={styles.payoffHead}>
            <Text style={styles.small}>Payoff</Text>
          </View>
        </View>
      ) : null}

      <TouchableOpacity style={[styles.execute, (sending || !plan.length) && { opacity: 0.5 }]} onPress={ask} disabled={sending}>
        <Text style={styles.executeText}>
          {sending
            ? "Sending"
            : !legs.length
              ? "Add a leg"
              : !plan.length
                ? "Mark a leg to close or add one"
                : [closeText, adds ? `Add ${adds}` : ""].filter(Boolean).join("  ·  ")}
        </Text>
      </TouchableOpacity>

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
        </View>
      ) : null}

      {picker}
      {expirySheet}
      {nameSheet}
    </ScrollView>
  );
}
