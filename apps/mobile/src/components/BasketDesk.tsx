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

import React, { useMemo, useState } from "react";
import { ActivityIndicator, Alert, PanResponder, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, useWindowDimensions } from "react-native";
import Svg, { Circle, Line, Path } from "react-native-svg";
import { Ionicons } from "@expo/vector-icons";
import {
  basketPnl,
  buildAnalysis,
  closedUnits,
  curves,
  expiryKey,
  heldPayoff,
  ladderUnderlying,
  legValue,
  openLiveBaskets,
  payoffExpiries,
  payoffFigures,
  rupees,
  valueAt,
  withBookMarks,
  type Basket,
  type StrategyAnalysis,
} from "@nraialgo/shared/api";
import { formatISTTime, formatNumber } from "@nraialgo/shared/utils";
import { useApi } from "@/hooks/useApi";
import { useTheme } from "@/components/ThemeProvider";

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

/** Prod's sentence for why T+0 has no line, taken from the same calibration the curve needs. */
function calibration(analysis: StrategyAnalysis | null): string | null {
  return analysis && analysis.greeks.available === false ? analysis.greeks.reason : null;
}

export default function BasketDesk({ onAdjust }: Props) {
  const { useBaskets, useOpenPositions } = useApi();
  const { data, isLoading, isError, error, refetch, isFetching, dataUpdatedAt } = useBaskets();
  // The same book the Positions tab shows, on the same query key so the two screens share one read.
  // /v1/baskets leaves an order or manual basket's legs unpriced and the web desk repairs that in the
  // browser, so the phone joins the book for the whole list. It polls prod's cached account snapshot, not
  // the broker, which is also what keeps these figures moving during the session.
  const positions = useOpenPositions();
  const [openId, setOpenId] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();

  const desk = useMemo(() => withBookMarks(openLiveBaskets(data?.baskets ?? []), positions.data ?? []), [data, positions.data]);
  const baskets = desk.baskets;
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
  const { useOptionChains, useStrategyAnalysis, usePlanningMargin, useRecordExitPrice, useRemoveLeg, useDeleteBasket } = useApi();
  const { width: screenWidth } = useWindowDimensions();
  const expiries = useMemo(() => payoffExpiries(basket), [basket]);
  const chains = useOptionChains(ladderUnderlying(basket), expiries, true);
  const built = useMemo(() => buildAnalysis(basket, chains.map(read => read.data)), [basket, chains]);
  const analysis = useStrategyAnalysis(built.body);
  const margin = usePlanningMargin(built.margin);
  const recordExit = useRecordExitPrice();
  const removeLeg = useRemoveLeg();
  const dropBasket = useDeleteBasket();
  const [priceFor, setPriceFor] = useState<{ symbol: string; price: string; units: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const value = basketPnl(basket.legs, basket.realized);
  // The model curves the units that are still open. The trader decides on the whole trade, so the exited
  // money is added back before anything is drawn or printed: the dot on the chart is then the Total P&L.
  const model = analysis.data ? curves(analysis.data, value.booked) : null;
  // The same shift applied to the phone's own exact payoff of the held contracts, which needs no ladder and
  // is what the card shows while the model read is still running.
  const held = useMemo(() => heldPayoff(basket, value.booked), [basket, value.booked]);
  const until = expiries.map(expiryKey).filter(Boolean).join(" and ") || null;
  const figures = analysis.data ? payoffFigures(analysis.data, until, value.booked) : null;
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

      <Payoff
        basket={basket}
        built={built}
        analysis={analysis.data ?? null}
        loading={chains.some(read => read.isFetching) || (analysis.isPending && !!built.body)}
        failed={analysis.isError ? analysis.error.message : null}
        model={model}
        held={held}
        figures={figures}
        margin={marginLine}
        screenWidth={screenWidth}
        styles={styles}
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

/**
 * The payoff card. The expiry line is the phone's own exact arithmetic over the contracts the broker
 * holds, so it is drawn the moment the basket opens; the T+0 line is prod's model and lands after the
 * ladder and the model read answer. Where the model has no T+0 the card says the server's reason instead
 * of passing the expiry line off as what the basket is worth now.
 */
function Payoff({ basket, built, analysis, loading, failed, model, held, figures, margin, screenWidth, styles }: {
  basket: Basket;
  built: ReturnType<typeof buildAnalysis>;
  analysis: StrategyAnalysis | null;
  loading: boolean;
  /** The model's own error sentence, when the call to it failed. */
  failed: string | null;
  model: ReturnType<typeof curves>;
  /** The exact payoff of the held contracts, which needs no ladder and no model. */
  held: ReturnType<typeof heldPayoff>;
  figures: Record<string, string> | null;
  /** The margin line, already resolved to words where the read has nothing to show. */
  margin: string;
  screenWidth: number;
  styles: ReturnType<typeof sheet>;
}) {
  const [zoom, setZoom] = useState(1);
  const [touchPx, setTouchPx] = useState<number | null>(null);

  const chart = useMemo(() => {
    const modelSpots = model?.spots ?? [];
    const heldSpots = held?.spots ?? [];
    const xs = modelSpots.length >= heldSpots.length ? modelSpots : heldSpots;
    const resample = (fromSpots: number[] | undefined, fromValues: number[] | null | undefined) => {
      if (!fromValues || !fromSpots || fromSpots.length !== fromValues.length) return null;
      if (fromSpots.length === xs.length && fromSpots.every((s, i) => s === xs[i])) return fromValues;
      return xs.map(x => valueAt(fromSpots, fromValues, x) ?? 0);
    };
    const expiryLine = model?.expiry
      ? resample(modelSpots, model.expiry)
      : resample(heldSpots, held?.values);
    const todayLine = model?.today ? resample(modelSpots, model.today) : null;
    if (xs.length < 3 || (!expiryLine && !todayLine)) return null;
    const lines = [expiryLine, todayLine].filter((line): line is number[] => !!line);
    const w = Math.round(screenWidth - 42);
    const h = 150;
    const padX = 5;
    const padTop = 10;
    const padBottom = 12;
    const fullLo = xs[0];
    const fullHi = xs[xs.length - 1];
    const center = (fullLo + fullHi) / 2;
    const halfRange = (fullHi - fullLo) / 2 / zoom;
    const lo = center - halfRange;
    const hi = center + halfRange;
    const visibleXs = xs.filter(x => x >= lo && x <= hi);
    const visibleExpiry = expiryLine?.filter((_, i) => xs[i] >= lo && xs[i] <= hi) ?? null;
    const visibleToday = todayLine?.filter((_, i) => xs[i] >= lo && xs[i] <= hi) ?? null;
    const ys = lines.flat();
    const yMin = Math.min(...ys, 0);
    const yMax = Math.max(...ys, 0);
    const yLo = yMax - yMin < 0.005 ? yMin - 1 : yMin;
    const yHi = yMax - yMin < 0.005 ? yMax + 1 : yMax;
    const px = (x: number) => padX + ((x - lo) / (hi - lo || 1)) * (w - padX * 2);
    const py = (y: number) => padTop + (1 - (y - yLo) / (yHi - yLo || 1)) * (h - padTop - padBottom);
    const path = (values: number[], spots: number[]) =>
      spots.map((x, i) => `${i === 0 ? "M" : "L"}${px(x).toFixed(1)},${py(values[i]).toFixed(1)}`).join("");
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
      xs,
      expiry: visibleExpiry && visibleXs.length === visibleExpiry.length ? path(visibleExpiry, visibleXs) : (expiryLine ? path(expiryLine!, xs) : null),
      today: visibleToday && visibleXs.length === visibleToday.length ? path(visibleToday, visibleXs) : (todayLine ? path(todayLine!, xs) : null),
      expiryValues: expiryLine,
      todayValues: todayLine,
    };
  }, [model, held, screenWidth, zoom]);

  const spot = Number(analysis?.spot ?? built.body?.spot ?? basket.spot);
  const onChart = !!chart && Number.isFinite(spot) && spot > 0 && spot >= chart.lo && spot <= chart.hi;
  const noT0 = calibration(analysis);
  const expiryNow = model
    ? model.atSpot
    : onChart && held ? valueAt(held.spots, held.values, spot) : null;
  const todayNow = model?.atSpotToday ?? null;

  const touchSpot = chart && touchPx !== null
    ? chart.lo + ((touchPx - 5) / (chart.w - 10)) * (chart.hi - chart.lo)
    : null;
  const touchExpiry = touchSpot !== null && chart?.expiryValues ? valueAt(chart.xs, chart.expiryValues, touchSpot) : null;
  const touchToday = touchSpot !== null && chart?.todayValues ? valueAt(chart.xs, chart.todayValues, touchSpot) : null;

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (evt) => setTouchPx(evt.nativeEvent.locationX),
    onPanResponderMove: (evt) => setTouchPx(evt.nativeEvent.locationX),
    onPanResponderRelease: () => setTouchPx(null),
    onPanResponderTerminate: () => setTouchPx(null),
  }), [chart]);

  return (
    <View style={styles.payoff}>
      <View style={styles.payoffHead}>
        <Text style={styles.small}>{model ? "Payoff · expiry and T+0" : "Payoff · at expiry"}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {loading && !model ? (
            <Text style={[styles.cardMeta, { fontSize: 10 }]}>Loading T+0...</Text>
          ) : null}
          {todayNow !== null ? (
            <Text style={[styles.figure, { color: moneyColor(todayNow, styles) }]}>{rupees(todayNow, true)}</Text>
          ) : null}
          {chart ? (
            <View style={{ flexDirection: "row", gap: 4 }}>
              <TouchableOpacity
                style={styles.zoomBtn}
                onPress={() => setZoom(z => Math.min(z * 1.5, 10))}
                accessibilityRole="button"
                accessibilityLabel="Zoom in on the payoff chart"
              >
                <Ionicons name="add" size={16} color={styles.cBrand} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.zoomBtn, zoom <= 1 && { opacity: 0.3 }]}
                onPress={() => setZoom(z => Math.max(z / 1.5, 1))}
                disabled={zoom <= 1}
                accessibilityRole="button"
                accessibilityLabel="Zoom out on the payoff chart"
              >
                <Ionicons name="remove" size={16} color={styles.cBrand} />
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
      </View>

      {!chart ? (
        loading ? (
          <Text style={styles.small}>Reading these legs</Text>
        ) : failed ? (
          <Text style={styles.small}>{`Model read failed: ${failed}`}</Text>
        ) : (
          <Text style={styles.small}>{`No curve: ${held ? "no contracts to draw" : built.unpriced.join("  ·  ") || "the desk holds no exact contracts"}`}</Text>
        )
      ) : (
        <>
          <View {...panResponder.panHandlers} style={{ position: "relative" }}>
            <Svg width={chart.w} height={chart.h}>
              <Line x1={0} y1={chart.zero} x2={chart.w} y2={chart.zero} stroke={styles.cBorder} strokeWidth={1} strokeDasharray="4 3" />
              {chart.today ? <Path d={chart.today} stroke={styles.cWarn} strokeWidth={1.5} fill="none" opacity={0.9} /> : null}
              {chart.expiry ? <Path d={chart.expiry} stroke={styles.cBrand} strokeWidth={2} fill="none" /> : null}
              {onChart ? (
                <Line x1={chart.px(spot)} y1={10} x2={chart.px(spot)} y2={chart.h - 12} stroke={styles.cMuted} strokeWidth={1} opacity={0.6} />
              ) : null}
              {onChart && expiryNow !== null && chart.expiry ? (
                <Circle cx={chart.px(spot)} cy={chart.py(expiryNow)} r={3.5} fill={styles.cBrand} />
              ) : null}
              {onChart && todayNow !== null && chart.today ? (
                <Circle cx={chart.px(spot)} cy={chart.py(todayNow)} r={3} fill={styles.cWarn} />
              ) : null}
              {touchSpot !== null && touchPx !== null && touchPx >= 5 && touchPx <= chart.w - 5 ? (
                <>
                  <Line x1={chart.px(touchSpot)} y1={0} x2={chart.px(touchSpot)} y2={chart.h} stroke={styles.cText} strokeWidth={0.5} opacity={0.4} />
                  {touchExpiry !== null && chart.expiry ? (
                    <Circle cx={chart.px(touchSpot)} cy={chart.py(touchExpiry)} r={3} fill={styles.cBrand} />
                  ) : null}
                  {touchToday !== null && chart.today ? (
                    <Circle cx={chart.px(touchSpot)} cy={chart.py(touchToday)} r={3} fill={styles.cWarn} />
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
                {touchExpiry !== null ? (
                  <Text style={[styles.tooltipValue, { color: styles.cBrand }]}>
                    {`expiry ${rupees(touchExpiry, true) ?? "—"}`}
                  </Text>
                ) : null}
                {touchToday !== null ? (
                  <Text style={[styles.tooltipValue, { color: styles.cWarn }]}>
                    {`T+0 ${rupees(touchToday, true) ?? "—"}`}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
          <View style={styles.payoffAxis}>
            <Text style={styles.axisText}>{formatNumber(chart.lo, 0)}</Text>
            <Text style={styles.axisText}>{onChart ? `${basket.underlying} spot ${formatNumber(spot, 2)}` : "expiry"}</Text>
            <Text style={styles.axisText}>{formatNumber(chart.hi, 0)}</Text>
          </View>
          <Text style={styles.legend}>
            <Text style={{ color: styles.cBrand }}>— expiry</Text>
            {chart.today ? <Text>{`  ·  `}<Text style={{ color: styles.cWarn }}>— T+0</Text></Text> : null}
          </Text>
        </>
      )}

      {figures ? (
        <View style={styles.figureGrid}>
          <Figure styles={styles} label="Basket P&L · T+0" value={todayNow !== null ? rupees(todayNow, true) ?? "no estimate" : noT0 ?? "no estimate"} />
          <Figure styles={styles} label="Expiry value now" value={expiryNow !== null ? rupees(expiryNow, true) : "not priced"} />
          <Figure styles={styles} label="Max profit" value={figures.maxProfit} />
          <Figure styles={styles} label="Max loss" value={figures.maxLoss} />
          <Figure styles={styles} label="POP" value={figures.pop} />
          <Figure styles={styles} label={figures.net.startsWith("Net credit") ? "Net credit" : "Net debit"} value={figures.net.replace(/^Net (credit|debit) /, "")} />
          <Figure styles={styles} label="Break-evens" value={figures.breakEvens} wide />
          {margin.startsWith("₹") || margin.startsWith("−") || margin.startsWith("-")
            ? <Figure styles={styles} label="Est. margin" value={margin} wide />
            : <Figure styles={styles} label="" value="---" wide />}
        </View>
      ) : held ? (
        <View style={styles.figureGrid}>
          <Figure
            styles={styles}
            label="If it expired today"
            value={expiryNow !== null
              ? rupees(expiryNow, true) ?? "no price"
              : Number.isFinite(spot) && spot > 0 ? "spot outside the strikes drawn" : "no spot read yet"}
          />
          <Figure styles={styles} label={held.netDebit <= 0 ? "Net credit" : "Net debit"} value={rupees(Math.abs(held.netDebit)) ?? "unknown"} />
          <Figure styles={styles} label="Max profit" value={held.max === null ? "Unlimited" : rupees(held.max) ?? "unknown"} />
          <Figure styles={styles} label="Max loss" value={held.min === null ? "Unlimited" : rupees(Math.abs(held.min)) ?? "unknown"} />
          <Figure styles={styles} label="Break-evens" value={held.breakEvens.length ? held.breakEvens.map(value => formatNumber(value, 2)).join("  ·  ") : "none inside the held strikes"} wide />
        </View>
      ) : null}
    </View>
  );
}

function Figure({ styles, label, value, wide }: { styles: ReturnType<typeof sheet>; label: string; value: string; wide?: boolean }) {
  return (
    <View style={{ flex: wide ? 2 : 1, minWidth: wide ? 220 : 105, gap: 1 }}>
      <Text style={styles.figureLabel}>{label}</Text>
      <Text style={styles.figureValue}>{value}</Text>
    </View>
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
      figureValue: { fontSize: 12.5, fontWeight: "600", color: c.cText, lineHeight: 17 },
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
      payoff: { borderWidth: 1, borderColor: c.cBorder, borderRadius: 10, backgroundColor: c.cCard, padding: 10, gap: 6 },
      payoffHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
      payoffAxis: { flexDirection: "row", justifyContent: "space-between" },
      axisText: { fontSize: 11, color: c.cMuted },
      legend: { fontSize: 11, color: c.cText },
      figureGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12, paddingTop: 6, borderTopWidth: 1, borderTopColor: c.cBorder },
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
      zoomBtn: { width: 28, height: 28, borderRadius: 6, borderWidth: 1, borderColor: c.cBorder, alignItems: "center", justifyContent: "center", backgroundColor: c.cCard },
      tooltip: { position: "absolute", backgroundColor: c.cCard, borderWidth: 1, borderColor: c.cBorder, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, gap: 2, elevation: 3, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 2 },
      tooltipSpot: { fontSize: 11, fontWeight: "700", color: c.cText },
      tooltipValue: { fontSize: 10.5, fontWeight: "600" },
    }),
  };
}
