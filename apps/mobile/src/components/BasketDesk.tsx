/**
 * The Basket desk: what the broker is holding right now, and what it is worth.
 *
 * One prod read (`/v1/baskets`) carries every basket with its legs, marks, booked P&L, close charges and
 * the exact contracts, so the list costs nothing beyond the desk the web live tab already polls. Opening a
 * basket adds the ladder reads needed to price it, and then one call to the server's own model - the only
 * honest source of the T+0 curve, the probability of profit and the greeks, because those need the
 * volatility the exchange prices imply, not a guess made on the phone.
 *
 * Nothing here sends an order. A live exit is a broker order, so the desk's job is to make the return and
 * the risk legible enough to decide on, and to hand the legs to the Builder when the trader decides to act.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  basketPnl,
  buildAnalysis,
  closedUnits,
  expiryKey,
  ladderUnderlying,
  legValue,
  openLiveBaskets,
  payoffExpiries,
  rupees,
  withBookMarks,
  withStreamMarks,
  basketStreamIds,
  useQuoteFeed,
  type Basket,
} from "@nraialgo/shared/api";
import { formatISTTime, formatNumber } from "@nraialgo/shared/utils";
import { useApi } from "@/hooks/useApi";
import { useTheme } from "@/components/ThemeProvider";
import PayoffChart, { type PayoffChartLeg } from "@/components/PayoffChart";

interface Props {
  /** Hand a basket's legs to the Builder tab, where an adjustment is actually placed. */
  onAdjust: (basket: Basket) => void;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/**
 * A broker expiry in the words a trader reads.
 *
 * Prod sends an expiry in whichever shape its source used — ISO for an order, "26-Nov-2026" for a row
 * carried straight from the broker's position book — so both are normalised before they are printed. An
 * unreadable date is shown as the broker wrote it rather than dropped, because a blank reads as "no
 * expiry" to someone deciding whether to close.
 */
const dayWord = (value?: string | null): string => {
  const key = expiryKey(value);
  if (!key) return String(value ?? "").trim();
  const [year, month, day] = key.split("-");
  return `${day} ${MONTHS[Number(month) - 1] ?? month} ${year!.slice(2)}`;
};

const contract = (underlying: string, strike: string, right: string, expiry?: string): string =>
  `${underlying} ${strike} ${right}${expiry ? ` · ${dayWord(expiry)}` : ""}`;

/** What kind of broker money a card is, in the words the trader uses. */
const kindWord = (basket: Basket): string =>
  basket.kind === "order" ? "order ticket" : basket.kind === "manual" ? "broker positions" : "algo run";

/** A flat figure is neither a gain nor a loss, so it must not borrow the profit colour. */
const moneyColor = (value: number, styles: ReturnType<typeof sheet>): string =>
  value > 0 ? styles.cPos : value < 0 ? styles.cNeg : styles.cMuted;

export default function BasketDesk({ onAdjust }: Props) {
  const { useBaskets, useOpenPositions } = useApi();
  // The legs this desk ticks from the socket, set below; the /v1/baskets read slows down only while
  // every open live leg is one the socket carries and is ticking (see quoteStreamCarries).
  const streamedLegs = useRef<readonly string[] | null>(null);
  const { data, isLoading, isError, error, refetch, isFetching, dataUpdatedAt } = useBaskets(undefined, undefined, () => streamedLegs.current);
  // The same book the Positions tab shows, on the same query key so the two screens share one read.
  // /v1/baskets leaves an order or manual basket's legs unpriced and the web desk repairs that in the
  // browser, so the phone joins the book for the whole list. It polls prod's cached account snapshot, not
  // the broker, which is also what keeps these figures moving during the session.
  const positions = useOpenPositions();
  const [openId, setOpenId] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();

  const desk = useMemo(() => withBookMarks(openLiveBaskets(data?.baskets ?? []), positions.data ?? []), [data, positions.data]);
  // Open legs tick from the live price socket between /v1/baskets reads (stream first, REST as the
  // safety net); a leg without a canonical id keeps the read's mark.
  const streamIds = useMemo(() => basketStreamIds(desk.baskets), [desk.baskets]);
  const feed = useQuoteFeed(streamIds, streamIds.length > 0);
  // A position-made leg named by a broker symbol has no canonical id and only the REST read prices it.
  useEffect(() => {
    streamedLegs.current = desk.baskets.every((basket) => basket.provider === "paper"
      || basket.legs.every((leg) => leg.quantity <= 0 || leg.instrumentId.startsWith("instrument:v1:")))
      ? streamIds
      : null;
  }, [desk.baskets, streamIds]);
  const baskets = useMemo(
    () => (feed.connected ? withStreamMarks(desk.baskets, feed.quotes) : desk.baskets),
    [desk.baskets, feed.connected, feed.quotes],
  );
  const open = baskets.find(basket => basket.id === openId) ?? null;

  const styles = useMemo(() => sheet(resolvedTheme), [resolvedTheme]);

  if (isError) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyBody}>
          {`The basket desk could not be read: ${error.message}. Nothing was changed.`}
        </Text>
        <TouchableOpacity style={styles.chip} onPress={() => void refetch()} accessibilityRole="button" accessibilityLabel="Read the basket desk again">
          <Text style={styles.chipText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (isLoading) {
    return (
      <View style={styles.empty}>
        <ActivityIndicator color={styles.cBrand} />
        <Text style={styles.emptyBody}>Reading which baskets the broker is holding</Text>
      </View>
    );
  }

  if (open) {
    return (
      <OpenBasket
        basket={open}
        basis={data?.basis ?? "the desk did not say where these rows came from"}
        onBack={() => setOpenId(null)}
        onAdjust={onAdjust}
        styles={styles}
      />
    );
  }

  return (
    <View style={{ gap: 10 }}>
      <View style={styles.deskHead}>
        <Text style={styles.deskTitle}>{`All open baskets${dataUpdatedAt ? ` · read ${formatISTTime(dataUpdatedAt)}` : ""}`}</Text>
        <TouchableOpacity style={styles.chip} onPress={() => void refetch()} accessibilityRole="button" accessibilityLabel="Read the basket desk again now">
          <Text style={styles.chipText}>{isFetching ? "Reading" : "Refresh"}</Text>
        </TouchableOpacity>
      </View>
      <Aggregate baskets={baskets} marked={desk.marked} bookFailed={positions.isError ? positions.error.message : null} styles={styles} />
      {!baskets.length ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No live baskets</Text>
          <Text style={styles.emptyBody}>
            A basket appears here once an order ticket carries a basket name, or a live algo run is holding
            legs. Paper baskets are not listed on the phone.
          </Text>
        </View>
      ) : null}
      {baskets.map(basket => (
        <BasketCard key={basket.id} basket={basket} styles={styles} onOpen={() => setOpenId(basket.id)} />
      ))}
      {data?.unattributed.length ? (
        <Text style={styles.basis}>{`${data.unattributed.length} broker position${data.unattributed.length === 1 ? "" : "s"} outside a basket.`}</Text>
      ) : null}
      {data?.basis ? <Text style={styles.basis}>{data.basis}</Text> : null}
      {isFetching ? <Text style={styles.basis}>Updating</Text> : null}
    </View>
  );
}

/** The whole book's return, so the decision to close something can start from the top number. */
function Aggregate({ baskets, marked, bookFailed, styles }: {
  baskets: Basket[];
  /** Legs this screen priced from the broker's own open-position book, rather than leaving blank. */
  marked: number;
  bookFailed: string | null;
  styles: ReturnType<typeof sheet>;
}) {
  const totals = baskets.reduce(
    (sum, basket) => {
      const value = basketPnl(basket.legs, basket.realized);
      return {
        booked: sum.booked + value.booked,
        open: sum.open + (value.open ?? 0),
        unmarked: sum.unmarked + value.unpriced,
        working: sum.working + (basket.working ? 1 : 0),
      };
    },
    { booked: 0, open: 0, unmarked: 0, working: 0 },
  );
  const legs = baskets.reduce((sum, basket) => sum + basket.legs.length, 0);
  return (
    <View style={styles.aggregate}>
      <View style={styles.aggregateRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.figureLabel}>Total P&amp;L</Text>
          <Text style={[styles.figureBig, { color: moneyColor(totals.open + totals.booked, styles) }]}>
            {rupees(totals.open + totals.booked, true) ?? "no price"}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.figureLabel}>Booked from exits</Text>
          <Text style={[styles.figure, { color: moneyColor(totals.booked, styles) }]}>{rupees(totals.booked, true) ?? "no price"}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.figureLabel}>Open legs</Text>
          <Text style={styles.figure}>{rupees(totals.open, true) ?? "no price"}</Text>
        </View>
      </View>
      <Text style={styles.aggregateFoot}>
        {[
          `${baskets.length} live · ${legs} legs`,
          totals.working ? `${totals.working} entry still working` : null,
          marked ? `${marked} priced from the broker's positions` : null,
          totals.unmarked ? `${totals.unmarked} without a price, not counted` : null,
          bookFailed ? "the broker's positions did not answer" : null,
        ].filter(Boolean).join("  ·  ")}
      </Text>
    </View>
  );
}

function BasketCard({ basket, styles, onOpen }: { basket: Basket; styles: ReturnType<typeof sheet>; onOpen: () => void }) {
  const value = basketPnl(basket.legs, basket.realized);
  const openLegs = basket.legs.filter(leg => leg.quantity > 0).length;
  return (
    <TouchableOpacity style={styles.card} onPress={onOpen} accessibilityRole="button" accessibilityLabel={`Open basket ${basket.name}`}>
      <View style={styles.cardHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle} numberOfLines={1}>{basket.name?.trim() || basket.underlying}</Text>
          <Text style={styles.cardMeta}>
            {[
              basket.underlying,
              dayWord(basket.expiry) || null,
              `${openLegs} of ${basket.legs.length} legs open`,
              kindWord(basket),
            ].filter(Boolean).join(" · ")}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={styles.cMuted} />
      </View>
      <View style={styles.cardFigures}>
        <View>
          <Text style={styles.figureLabel}>Total P&amp;L</Text>
          <Text style={[styles.figure, { color: moneyColor(value.total ?? 0, styles) }]}>{rupees(value.total, true) ?? "no price"}</Text>
        </View>
        <View>
          <Text style={styles.figureLabel}>Booked</Text>
          <Text style={[styles.figure, { color: moneyColor(value.booked, styles) }]}>{value.booked ? rupees(value.booked, true) : "nothing yet"}</Text>
        </View>
        <View>
          <Text style={styles.figureLabel}>Open</Text>
          <Text style={[styles.figure, { color: moneyColor(value.open ?? 0, styles) }]}>{rupees(value.open, true) ?? "no price"}</Text>
        </View>
      </View>
      {(basket.working || value.unpriced || basket.warnings.length) ? (
        <Text style={styles.cardNote}>
          {[
            basket.working ? `${basket.working.label}: ${basket.working.filled} of ${basket.working.total} legs done` : null,
            value.unpriced ? `${value.unpriced} without a price` : null,
            basket.warnings[0] ?? null,
          ].filter(Boolean).join("  ·  ")}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
}

function OpenBasket({ basket, basis, onBack, onAdjust, styles }: {
  basket: Basket;
  /** Prod's own sentence about which sources answered this desk read. */
  basis: string;
  onBack: () => void;
  onAdjust: (basket: Basket) => void;
  styles: ReturnType<typeof sheet>;
}) {
  const { useOptionChains, usePlanningMargin, useRecordExitPrice, useRemoveLeg, useDeleteBasket } = useApi();
  const expiries = useMemo(() => payoffExpiries(basket), [basket]);
  const chains = useOptionChains(ladderUnderlying(basket), expiries, true);
  // The payoff chart runs the model read itself; this screen keeps only the margin estimate, whose
  // wording is too careful to leave to a generic figure.
  const built = useMemo(() => buildAnalysis(basket, chains.map(read => read.data)), [basket, chains]);
  const margin = usePlanningMargin(built.margin);
  const recordExit = useRecordExitPrice();
  const removeLeg = useRemoveLeg();
  const dropBasket = useDeleteBasket();
  const [priceFor, setPriceFor] = useState<{ symbol: string; price: string; units: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const value = basketPnl(basket.legs, basket.realized);
  const spotNow = useMemo(() => {
    const read = chains.find(item => item.data)?.data;
    const fromLadder = Number(read?.spot?.price);
    return Number.isFinite(fromLadder) && fromLadder > 0 ? fromLadder : Number(basket.spot) || null;
  }, [chains, basket.spot]);

  /**
   * The legs the payoff is drawn for: exactly the units the broker still holds. A leg whose whole quantity
   * has been exited contributes nothing, and a partly exited one contributes only what is left, so the
   * curve is the basket the trader is in rather than the basket it was opened with.
   */
  const chartLegs = useMemo<PayoffChartLeg[]>(() => {
    const remaining = new Map<string, number>();
    for (const leg of basket.legs) {
      remaining.set(leg.instrumentId, Math.max(0, (leg.lots ?? 0) - closedUnits(leg)));
    }
    return basket.payoffLegs.flatMap(leg => {
      const lots = remaining.has(leg.instrumentId) ? remaining.get(leg.instrumentId)! : leg.lots;
      if (lots <= 0) return [];
      const entry = Number(leg.entryPrice);
      return [{
        strike: leg.strike,
        right: leg.right,
        side: (leg.action === "buy" ? "BUY" : "SELL") as "BUY" | "SELL",
        lots,
        lotSize: leg.lotSize,
        expiry: leg.expiry,
        entryPrice: Number.isFinite(entry) && entry > 0 ? entry : null,
      }];
    });
  }, [basket]);

  const priceable = basket.kind === "order" || basket.kind === "manual";
  const charges = basket.charges;
  // A wider basket than /v1/planning-margin takes is stated as such; the number for the first eight legs
  // would read as the whole basket's margin and be wrong.
  const marginLine = !built.margin
    ? "not estimated for this many legs"
    : margin.isError
      ? `the margin read failed: ${margin.error.message}`
      : !margin.data
        ? "reading"
        : margin.data.available
          ? `${rupees(margin.data.amount ?? null) ?? "no amount"}${margin.data.stale ? " · older parameters" : ""}${margin.data.brokerVerified ? "" : " · planning figure, not the broker’s"}`
          : margin.data.reason ?? "prod sent no reason";

  const act = async (label: string, run: () => Promise<unknown>) => {
    setNote(null);
    try {
      await run();
      setNote(`${label}. The desk re-reads itself now.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setNote(`${message} Nothing was changed.`);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ gap: 10 }}>
      <TouchableOpacity style={styles.back} onPress={onBack} accessibilityRole="button" accessibilityLabel="Back to the basket list">
        <Ionicons name="chevron-back" size={18} color={styles.cBrand} />
        <Text style={styles.backText}>Baskets</Text>
      </TouchableOpacity>

      <View>
        <Text style={styles.basketTitle}>{basket.name?.trim() || basket.underlying}</Text>
        <Text style={styles.cardMeta}>
          {dayWord(basket.expiry) ? `expiry ${dayWord(basket.expiry)}` : ""}
        </Text>
      </View>

      <View style={styles.aggregate}>
        <View style={styles.aggregateRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.figureLabel}>Total P&amp;L</Text>
            <Text style={[styles.figureBig, { color: moneyColor(value.total ?? 0, styles) }]}>{rupees(value.total, true) ?? "no price"}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.figureLabel}>Booked from exits</Text>
            <Text style={[styles.figure, { color: moneyColor(value.booked, styles) }]}>{rupees(value.booked, true)}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.figureLabel}>Still open</Text>
            <Text style={[styles.figure, { color: moneyColor(value.open ?? 0, styles) }]}>{rupees(value.open, true) ?? "no price"}</Text>
          </View>
        </View>
      </View>

      <PayoffChart
        underlying={ladderUnderlying(basket)}
        expiry={basket.expiry}
        legs={chartLegs}
        spot={spotNow}
        chains={chains.map(read => read.data)}
        title={basket.name?.trim() || basket.underlying}
        booked={value.booked}
        marginNote={marginLine}
      />

      <View style={styles.actions}>
        <TouchableOpacity style={[styles.chip, styles.chipPrimary]} onPress={() => onAdjust(basket)} accessibilityRole="button" accessibilityLabel="Adjust this basket in the Builder">
          <Text style={[styles.chipText, { color: "#ffffff" }]}>Adjust in Builder</Text>
        </TouchableOpacity>
        {priceable ? (
          <TouchableOpacity
            style={[styles.chip, !basket.legs.some(leg => leg.quantity <= 0 && leg.exitPrice == null) && { opacity: 0.5 }]}
            onPress={() => {
              const leg = basket.legs.find(item => item.quantity <= 0 && item.exitPrice == null);
              if (!leg) { setNote("Every closed leg here already has its exit price on record."); return; }
              setPriceFor({ symbol: leg.symbol, price: "", units: "" });
            }}
            accessibilityRole="button"
            accessibilityLabel="Record the exit price of a closed leg"
          >
            <Text style={styles.chipText}>Record exit price</Text>
          </TouchableOpacity>
        ) : null}
        {priceable && basket.legs.length === 1 ? (
          <TouchableOpacity style={styles.chip} onPress={() => Alert.alert("Remove this leg?", `${basket.legs[0].symbol} leaves the basket and shows under Positions. Nothing is sent to the broker.`, [
            { text: "Cancel", style: "cancel" },
            { text: "Remove", style: "destructive", onPress: () => void act("The leg is out of the basket", () => removeLeg.mutateAsync({ basketId: basket.id, symbol: basket.legs[0].symbol, instrumentId: basket.legs[0].instrumentId })) },
          ])} accessibilityRole="button" accessibilityLabel="Remove the leg from this basket">
            <Text style={styles.chipText}>Ungroup leg</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity style={styles.chip} onPress={() => Alert.alert("Delete this basket?", "The positions stay at the broker; the basket simply stops being grouped on every desk.", [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: () => void act("The basket is off the desk", () => dropBasket.mutateAsync(basket.id)) },
        ])} accessibilityRole="button" accessibilityLabel="Delete this basket">
          <Text style={styles.chipText}>Delete basket</Text>
        </TouchableOpacity>
      </View>

      {priceFor ? (
        <RecordExit
          basket={basket}
          symbol={priceFor.symbol}
          draft={priceFor}
          setDraft={setPriceFor}
          busy={recordExit.isPending}
          onSave={() => {
            const price = Number(priceFor.price);
            const units = priceFor.units.trim() === "" ? undefined : Number(priceFor.units);
            if (!(price > 0)) { setNote("A price is needed. Nothing was recorded."); return; }
            void act(`${priceFor.symbol} recorded at ${rupees(price)}`, () => recordExit.mutateAsync({
              basketId: basket.id,
              symbol: priceFor.symbol,
              price,
              ...(units !== undefined ? { quantity: units } : {}),
            })).then(() => setPriceFor(null));
          }}
          styles={styles}
        />
      ) : null}

      <Legs basket={basket} styles={styles} priceable={priceable} onRemove={priceable ? (leg) => Alert.alert("Remove this leg?", `${leg.symbol} leaves the basket and shows under Positions. Nothing is sent to the broker.`, [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => void act("The leg is out of the basket", () => removeLeg.mutateAsync({ basketId: basket.id, symbol: leg.symbol, instrumentId: leg.instrumentId })) },
      ]) : undefined}
        onRecord={priceable ? (leg) => setPriceFor({ symbol: leg.symbol, price: leg.exitPrice != null ? String(leg.exitPrice) : "", units: "" }) : undefined}
      />

    </ScrollView>
  );
}

function Legs({ basket, styles, priceable, onRemove, onRecord }: {
  basket: Basket;
  styles: ReturnType<typeof sheet>;
  priceable: boolean;
  onRemove?: (leg: Basket["legs"][number]) => void;
  onRecord?: (leg: Basket["legs"][number]) => void;
}) {
  return (
    <View style={styles.legs}>
      <View style={styles.legHead}>
        <Text style={[styles.legHeadText, { flex: 2 }]}>Leg</Text>
        <Text style={[styles.legHeadText, { flex: 1, textAlign: "right" }]}>Qty</Text>
        <Text style={[styles.legHeadText, { flex: 1, textAlign: "right" }]}>Entry</Text>
        <Text style={[styles.legHeadText, { flex: 1.2, textAlign: "right" }]}>Current</Text>
        <Text style={[styles.legHeadText, { flex: 1.2, textAlign: "right" }]}>P&amp;L</Text>
      </View>
      {basket.legs.map(leg => {
        const mark = legValue(leg);
        const moved = leg.quantity > 0
          ? (mark.price !== null ? (mark.price - leg.entryPrice) * leg.quantity * (leg.side === "SELL" ? -1 : 1) : null)
          : leg.bookedPnl ?? null;
        const units = closedUnits(leg);
        const payoff = basket.payoffLegs.find(item => item.symbol === leg.symbol);
        return (
          <View key={leg.instrumentId} style={styles.legRow}>
            <View style={{ flex: 2 }}>
              <Text style={[styles.legName, { color: leg.side === "BUY" ? styles.cPos : styles.cNeg }]}>
                {`${leg.side === "BUY" ? "B" : "S"} ${payoff ? contract(leg.symbol, payoff.strike, payoff.right, payoff.expiry) : leg.symbol}`}
              </Text>
              <Text style={styles.legState}>
                {leg.quantity <= 0 ? `exited · ${mark.label}${leg.exitAt ? ` · ${dayWord(leg.exitAt)}` : ""}`
                  : units ? `partly exited · ${leg.quantity} left of ${units + leg.quantity}`
                  : leg.pending ? "order working" : leg.role || "open"}
              </Text>
              {(onRemove || onRecord) && leg.quantity <= 0 ? (
                <View style={{ flexDirection: "row", gap: 10 }}>
                  {onRecord ? <TouchableOpacity onPress={() => onRecord(leg)} accessibilityRole="button" accessibilityLabel={`Record the exit price of ${leg.symbol}`}>
                    <Text style={styles.link}>{leg.exitPrice == null ? "Record exit price" : "Edit price"}</Text>
                  </TouchableOpacity> : null}
                  {onRemove ? <TouchableOpacity onPress={() => onRemove(leg)} accessibilityRole="button" accessibilityLabel={`Remove ${leg.symbol} from the basket`}>
                    <Text style={styles.link}>Remove leg</Text>
                  </TouchableOpacity> : null}
                </View>
              ) : null}
            </View>
            <Text style={[styles.legNum, { flex: 1 }]}>{leg.quantity > 0 ? `${leg.side === "SELL" ? "−" : ""}${leg.quantity}` : "flat"}</Text>
            <Text style={[styles.legNum, { flex: 1 }]}>{formatNumber(leg.entryPrice, 2)}</Text>
            <Text style={[styles.legNum, { flex: 1.2 }]}>{mark.price === null ? "no price" : formatNumber(mark.price, 2)}</Text>
            <View style={{ flex: 1.2, alignItems: "flex-end" }}>
              <Text style={[styles.legNum, { color: moneyColor(moved ?? 0, styles) }]}>{moved === null ? "no price" : rupees(moved, true)}</Text>
              {leg.quantity <= 0 && moved !== null && leg.bookedBasis ? <Text style={styles.legState}>{leg.bookedBasis}</Text> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function RecordExit({ basket, symbol, draft, setDraft, onSave, busy, styles }: {
  basket: Basket;
  symbol: string;
  draft: { symbol: string; price: string; units: string };
  setDraft: (next: { symbol: string; price: string; units: string } | null) => void;
  onSave: () => void;
  busy: boolean;
  styles: ReturnType<typeof sheet>;
}) {
  const leg = basket.legs.find(item => item.symbol === symbol);
  return (
    <View style={styles.legs}>
      <Text style={styles.small}>{`Exit price for ${symbol}${leg ? ` · ${leg.quantity <= 0 ? "the whole leg" : `${leg.quantity} units open`}` : ""}`}</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <TextInput
          style={[styles.field, { flex: 1 }]}
          value={draft.price}
          onChangeText={value => setDraft({ ...draft, price: value })}
          placeholder="Exit ₹"
          placeholderTextColor={styles.cMuted}
          keyboardType="decimal-pad"
          accessibilityLabel={`Exit price for ${symbol}`}
        />
        <TextInput
          style={[styles.field, { width: 92 }]}
          value={draft.units}
          onChangeText={value => setDraft({ ...draft, units: value })}
          placeholder="units"
          placeholderTextColor={styles.cMuted}
          keyboardType="number-pad"
          accessibilityLabel={`Units that price closed for ${symbol}`}
        />
        <TouchableOpacity style={[styles.chip, styles.chipPrimary, busy && { opacity: 0.5 }]} onPress={onSave} disabled={busy} accessibilityRole="button" accessibilityLabel="Save this exit price on the server">
          <Text style={[styles.chipText, { color: "#ffffff" }]}>{busy ? "Saving" : "Save"}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.chip} onPress={() => setDraft(null)} accessibilityRole="button" accessibilityLabel="Cancel recording an exit price">
          <Text style={styles.chipText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/**
 * The desk's palette, in the same two sets the Builder screen uses, so the tab bar and the desk under it
 * are one screen rather than a light page carrying dark cards. The `c`-prefixed entries are plain colour
 * values for the places that need one directly - an icon, an SVG stroke, a placeholder.
 */
function sheet(theme: string) {
  const c = theme === "dark"
    ? {
      cBg: "#0f172a", cCard: "#1e293b", cText: "#f1f5f9", cMuted: "#64748b", cBorder: "#334155",
      cBrand: "#38bdf8", cPos: "#22c55e", cNeg: "#ef4444", cWarn: "#f59e0b",
    }
    : {
      cBg: "#f8fafc", cCard: "#ffffff", cText: "#0f172a", cMuted: "#64748b", cBorder: "#e2e8f0",
      cBrand: "#0284c7", cPos: "#16a34a", cNeg: "#dc2626", cWarn: "#b45309",
    };
  return {
    ...c,
    ...StyleSheet.create({
      empty: { padding: 28, alignItems: "center", gap: 10 },
      deskHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
      deskTitle: { fontSize: 13, fontWeight: "700", color: c.cText },
      emptyTitle: { fontSize: 15, fontWeight: "700", color: c.cText },
      emptyBody: { fontSize: 13, color: c.cMuted, textAlign: "center", lineHeight: 19 },
      aggregate: { borderWidth: 1, borderColor: c.cBorder, borderRadius: 10, backgroundColor: c.cCard, padding: 10, gap: 8 },
      aggregateRow: { flexDirection: "row", gap: 10 },
      aggregateFoot: { fontSize: 11, color: c.cMuted, lineHeight: 16 },
      figureLabel: { fontSize: 10, fontWeight: "700", letterSpacing: 0.6, color: c.cMuted, textTransform: "uppercase" },
      figure: { fontSize: 15, fontWeight: "700", color: c.cText },
      figureBig: { fontSize: 19, fontWeight: "800" },
      card: { borderWidth: 1, borderColor: c.cBorder, borderRadius: 10, backgroundColor: c.cCard, padding: 10, gap: 8 },
      cardHead: { flexDirection: "row", alignItems: "center", gap: 8 },
      cardTitle: { fontSize: 15, fontWeight: "700", color: c.cText },
      cardMeta: { fontSize: 11.5, color: c.cMuted, marginTop: 2, lineHeight: 16 },
      cardFigures: { flexDirection: "row", gap: 16 },
      cardNote: { fontSize: 11.5, color: c.cWarn, lineHeight: 16 },
      back: { flexDirection: "row", alignItems: "center", gap: 2, alignSelf: "flex-start" },
      backText: { fontSize: 13, fontWeight: "700", color: c.cBrand },
      basketTitle: { fontSize: 17, fontWeight: "700", color: c.cText },
      actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
      chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: c.cBorder, backgroundColor: c.cCard },
      chipPrimary: { backgroundColor: c.cBrand, borderColor: c.cBrand },
      chipText: { fontSize: 12.5, fontWeight: "700", color: c.cText },
      legs: { borderWidth: 1, borderColor: c.cBorder, borderRadius: 10, backgroundColor: c.cCard, padding: 10, gap: 8 },
      legHead: { flexDirection: "row", gap: 6, borderBottomWidth: 1, borderBottomColor: c.cBorder, paddingBottom: 6 },
      legHeadText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.6, color: c.cMuted, textTransform: "uppercase" },
      legRow: { flexDirection: "row", gap: 6, alignItems: "flex-start" },
      legName: { fontSize: 12.5, fontWeight: "600" },
      legNum: { fontSize: 12.5, color: c.cText, textAlign: "right" },
      legState: { fontSize: 10.5, color: c.cMuted, lineHeight: 15 },
      link: { fontSize: 11.5, fontWeight: "700", color: c.cBrand },
      field: { borderWidth: 1, borderColor: c.cBorder, borderRadius: 8, backgroundColor: c.cBg, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: c.cText },
      note: { fontSize: 12, color: c.cWarn, lineHeight: 17 },
      basis: { fontSize: 11, color: c.cMuted, lineHeight: 16 },
      small: { fontSize: 12, color: c.cMuted },
    }),
  };
}
