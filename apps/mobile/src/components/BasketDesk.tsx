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
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, useWindowDimensions } from "react-native";
import Svg, { Circle, Line, Path } from "react-native-svg";
import { Ionicons } from "@expo/vector-icons";
import {
  basketPnl,
  buildAnalysis,
  closedUnits,
  curves,
  legValue,
  openLiveBaskets,
  payoffExpiries,
  payoffFigures,
  rupees,
  type Basket,
  type StrategyAnalysis,
} from "@nraialgo/shared/api";
import { formatISTTime, formatNumber } from "@nraialgo/shared/utils";
import { useApi } from "@/hooks/useApi";

interface Props {
  /** Hand a basket's legs to the Builder tab, where an adjustment is actually placed. */
  onAdjust: (basket: Basket) => void;
}

const dayWord = (value?: string | null): string => {
  const [year, month, day] = (value ?? "").split("-");
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  return year && month && day ? `${day} ${months[Number(month) - 1] ?? month} ${year.slice(2)}` : "";
};

const contract = (underlying: string, strike: string, right: string, expiry?: string): string =>
  `${underlying} ${strike} ${right}${expiry ? ` · ${dayWord(expiry)}` : ""}`;

/** Prod's sentence for why T+0 has no line, taken from the same calibration the curve needs. */
function calibration(analysis: StrategyAnalysis | null): string | null {
  return analysis && analysis.greeks.available === false ? analysis.greeks.reason : null;
}

export default function BasketDesk({ onAdjust }: Props) {
  const { useBaskets } = useApi();
  const { data, isLoading, isError, error, refetch, isFetching, dataUpdatedAt } = useBaskets();
  const [openId, setOpenId] = useState<string | null>(null);

  const baskets = useMemo(() => openLiveBaskets(data?.baskets ?? []), [data]);
  const open = baskets.find(basket => basket.id === openId) ?? null;

  const styles = sheet();

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
        <ActivityIndicator color="#38bdf8" />
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
      <Aggregate baskets={baskets} styles={styles} />
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
        <Text style={styles.basis}>{`${data.unattributed.length} broker position${data.unattributed.length === 1 ? "" : "s"} here is not grouped into a basket.`}</Text>
      ) : null}
      {data?.basis ? <Text style={styles.basis}>{data.basis}</Text> : null}
      {isFetching ? <Text style={styles.basis}>Updating</Text> : null}
    </View>
  );
}

/** The whole book's return, so the decision to close something can start from the top number. */
function Aggregate({ baskets, styles }: { baskets: Basket[]; styles: ReturnType<typeof sheet> }) {
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
          <Text style={[styles.figureBig, { color: totals.open + totals.booked >= 0 ? GREEN : RED }]}>
            {rupees(totals.open + totals.booked, true) ?? "no price"}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.figureLabel}>Booked from exits</Text>
          <Text style={[styles.figure, { color: totals.booked >= 0 ? GREEN : RED }]}>{rupees(totals.booked, true) ?? "no price"}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.figureLabel}>Open legs</Text>
          <Text style={styles.figure}>{rupees(totals.open, true) ?? "no price"}</Text>
        </View>
      </View>
      <Text style={styles.aggregateFoot}>
        {[
          `${baskets.length} live basket${baskets.length === 1 ? "" : "s"} · ${legs} legs`,
          totals.working ? `${totals.working} entry still working` : null,
          totals.unmarked ? `${totals.unmarked} leg${totals.unmarked === 1 ? "" : "s"} without a price — not counted above` : null,
        ].filter(Boolean).join("  ·  ")}
      </Text>
    </View>
  );
}

function BasketCard({ basket, styles, onOpen }: { basket: Basket; styles: ReturnType<typeof sheet>; onOpen: () => void }) {
  const value = basketPnl(basket.legs, basket.realized);
  const openLegs = basket.legs.filter(leg => leg.quantity > 0).length;
  const kindWord = basket.kind === "order" ? "order ticket" : basket.kind === "manual" ? "broker positions" : "algo run";
  return (
    <TouchableOpacity style={styles.card} onPress={onOpen} accessibilityRole="button" accessibilityLabel={`Open basket ${basket.name}`}>
      <View style={styles.cardHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle} numberOfLines={1}>{basket.name?.trim() || basket.underlying}</Text>
          <Text style={styles.cardMeta}>
            {`${basket.underlying} · ${dayWord(basket.expiry) || "expiry on record"} · ${openLegs} of ${basket.legs.length} legs open · ${kindWord}`}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={MUTED} />
      </View>
      <View style={styles.cardFigures}>
        <View>
          <Text style={styles.figureLabel}>Total P&amp;L</Text>
          <Text style={[styles.figure, { color: (value.total ?? 0) >= 0 ? GREEN : RED }]}>{rupees(value.total, true) ?? "no price"}</Text>
        </View>
        <View>
          <Text style={styles.figureLabel}>Booked</Text>
          <Text style={[styles.figure, { color: value.booked >= 0 ? GREEN : RED }]}>{value.booked ? rupees(value.booked, true) : "nothing yet"}</Text>
        </View>
        <View>
          <Text style={styles.figureLabel}>Open</Text>
          <Text style={[styles.figure, { color: (value.open ?? 0) >= 0 ? GREEN : RED }]}>{rupees(value.open, true) ?? "no price"}</Text>
        </View>
      </View>
      {(basket.working || value.unpriced || basket.warnings.length) ? (
        <Text style={styles.cardNote}>
          {[
            basket.working ? `${basket.working.label}: ${basket.working.filled} of ${basket.working.total} legs done` : null,
            value.unpriced ? `${value.unpriced} leg${value.unpriced === 1 ? "" : "s"} without a price — not counted in Total` : null,
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
  const chains = useOptionChains(basket.underlying, expiries, true);
  const built = useMemo(() => buildAnalysis(basket, chains.map(read => read.data)), [basket, chains]);
  const analysis = useStrategyAnalysis(built.body);
  const margin = usePlanningMargin(built.margin);
  const recordExit = useRecordExitPrice();
  const removeLeg = useRemoveLeg();
  const dropBasket = useDeleteBasket();
  const [priceFor, setPriceFor] = useState<{ symbol: string; price: string; units: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const value = basketPnl(basket.legs, basket.realized);
  const model = analysis.data ? curves(analysis.data) : null;
  const figures = analysis.data ? payoffFigures(analysis.data) : null;
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
        <Ionicons name="chevron-back" size={18} color={BRAND} />
        <Text style={styles.backText}>Baskets</Text>
      </TouchableOpacity>

      <View>
        <Text style={styles.basketTitle}>{basket.name?.trim() || basket.underlying}</Text>
        <Text style={styles.cardMeta}>
          {`${basket.underlying} · ${dayWord(basket.expiry) || "expiry on record"} · spot ${formatNumber(basket.spot, 2)}` +
            ` · ${basket.tau > 0 ? `${basket.tau.toFixed(1)} days to expiry` : "expiry date not stated"}`}
        </Text>
      </View>

      <View style={styles.aggregate}>
        <View style={styles.aggregateRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.figureLabel}>Total P&amp;L</Text>
            <Text style={[styles.figureBig, { color: (value.total ?? 0) >= 0 ? GREEN : RED }]}>{rupees(value.total, true) ?? "no price"}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.figureLabel}>Booked from exits</Text>
            <Text style={[styles.figure, { color: value.booked >= 0 ? GREEN : RED }]}>{rupees(value.booked, true)}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.figureLabel}>Still open</Text>
            <Text style={[styles.figure, { color: (value.open ?? 0) >= 0 ? GREEN : RED }]}>{rupees(value.open, true) ?? "no price"}</Text>
          </View>
        </View>
        <Text style={styles.aggregateFoot}>
          {[
            basket.openedAt ? `opened ${dayWord(basket.openedAt.slice(0, 10))}` : null,
            basket.closedAt ? `last exit ${dayWord(basket.closedAt)}` : null,
            value.unpriced ? `${value.unpriced} leg${value.unpriced === 1 ? "" : "s"} without a price — not counted` : "every open leg priced",
            charges?.available ? `an exit now costs about ${rupees(charges.total ?? 0)}${charges.basis ? ` · ${charges.basis}` : ""}`
              : charges ? `exits not chargeable yet: ${charges.reason ?? "prod did not say why"}` : null,
          ].filter(Boolean).join("  ·  ")}
        </Text>
      </View>

      <Payoff
        basket={basket}
        built={built}
        analysis={analysis.data ?? null}
        loading={chains.some(read => read.isFetching) || (analysis.isPending && !!built.body)}
        failed={analysis.isError ? analysis.error.message : null}
        model={model}
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

      {note ? <Text style={styles.note}>{note}</Text> : null}
      {basket.warnings.map(warning => <Text key={warning} style={styles.note}>{warning}</Text>)}
      <Text style={styles.basis}>{`This basket is grouped from: ${basket.attribution}. ${basis}`}</Text>
    </ScrollView>
  );
}

/**
 * The curve prod's model draws. Both lines are the server's own samples - the phone invents no grid, and
 * where the T+0 line is missing the card says the server's reason instead of passing the expiry line off
 * as what the basket is worth now.
 */
function Payoff({ basket, built, analysis, loading, failed, model, figures, margin, screenWidth, styles }: {
  basket: Basket;
  built: ReturnType<typeof buildAnalysis>;
  analysis: StrategyAnalysis | null;
  loading: boolean;
  /** The model's own error sentence, when the call to it failed. */
  failed: string | null;
  model: ReturnType<typeof curves>;
  figures: Record<string, string> | null;
  /** The margin line, already resolved to words where the read has nothing to show. */
  margin: string;
  screenWidth: number;
  styles: ReturnType<typeof sheet>;
}) {
  const chart = useMemo(() => {
    if (!model) return null;
    const xs = model.spots;
    const lines = [model.expiry, model.today].filter((line): line is number[] => !!line);
    if (!lines.length) return null;
    const w = Math.round(screenWidth - 42);
    const h = 150;
    const padX = 5;
    const padTop = 10;
    const padBottom = 12;
    const lo = xs[0];
    const hi = xs[xs.length - 1];
    const ys = lines.flat();
    const yMin = Math.min(...ys, 0);
    const yMax = Math.max(...ys, 0);
    const yLo = yMax - yMin < 0.005 ? yMin - 1 : yMin;
    const yHi = yMax - yMin < 0.005 ? yMax + 1 : yMax;
    const px = (x: number) => padX + ((x - lo) / (hi - lo || 1)) * (w - padX * 2);
    const py = (y: number) => padTop + (1 - (y - yLo) / (yHi - yLo || 1)) * (h - padTop - padBottom);
    const path = (values: number[]) => values.map((y, i) => `${i === 0 ? "M" : "L"}${px(xs[i]).toFixed(1)},${py(y).toFixed(1)}`).join("");
    return { w, h, px, py, zero: py(0), lo, hi, expiry: model.expiry ? path(model.expiry) : null, today: model.today ? path(model.today) : null };
  }, [model, screenWidth]);

  const spot = analysis ? Number(analysis.spot) : NaN;
  const onChart = !!chart && Number.isFinite(spot) && spot >= chart.lo && spot <= chart.hi;
  const noT0 = calibration(analysis);
  const expiryNow = model?.atSpot ?? null;
  const todayNow = model?.atSpotToday ?? null;

  return (
    <View style={styles.payoff}>
      <View style={styles.payoffHead}>
        <Text style={styles.small}>Payoff · expiry and T+0 estimate</Text>
        {todayNow !== null ? (
          <Text style={[styles.figure, { color: todayNow >= 0 ? GREEN : RED }]}>{rupees(todayNow, true)}</Text>
        ) : null}
      </View>

      {loading ? (
        <Text style={styles.small}>The server is pricing these legs</Text>
      ) : failed ? (
        <Text style={styles.small}>{`The model call failed: ${failed} Nothing was changed.`}</Text>
      ) : !built.body ? (
        <Text style={styles.small}>{`No model curve yet: ${built.unpriced.join(", ")} ${built.unpriced.length === 1 ? "has" : "have"} no price from the broker’s ladder, so nothing is drawn rather than a curve missing a leg.`}</Text>
      ) : !chart ? (
        <Text style={styles.small}>The model answered without a curve to draw.</Text>
      ) : (
        <>
          <Svg width={chart.w} height={chart.h}>
            <Line x1={0} y1={chart.zero} x2={chart.w} y2={chart.zero} stroke={BORDER} strokeWidth={1} strokeDasharray="4 3" />
            {chart.today ? <Path d={chart.today} stroke={WARN} strokeWidth={1.5} fill="none" opacity={0.9} /> : null}
            {chart.expiry ? <Path d={chart.expiry} stroke={BRAND} strokeWidth={2} fill="none" /> : null}
            {onChart ? (
              <Line x1={chart.px(spot)} y1={10} x2={chart.px(spot)} y2={chart.h - 12} stroke={MUTED} strokeWidth={1} opacity={0.6} />
            ) : null}
            {onChart && expiryNow !== null && chart.expiry ? (
              <Circle cx={chart.px(spot)} cy={chart.py(expiryNow)} r={3.5} fill={BRAND} />
            ) : null}
            {onChart && todayNow !== null && chart.today ? (
              <Circle cx={chart.px(spot)} cy={chart.py(todayNow)} r={3} fill={WARN} />
            ) : null}
          </Svg>
          <View style={styles.payoffAxis}>
            <Text style={styles.axisText}>{formatNumber(chart.lo, 0)}</Text>
            <Text style={styles.axisText}>{`${basket.underlying} spot ${Number.isFinite(spot) ? formatNumber(spot, 2) : "unknown"}`}</Text>
            <Text style={styles.axisText}>{formatNumber(chart.hi, 0)}</Text>
          </View>
          <Text style={styles.legend}>
            <Text style={{ color: BRAND }}>— expiry</Text>
            {chart.today ? <Text>{`  ·  `}<Text style={{ color: WARN }}>— T+0 estimate</Text></Text> : null}
            {model?.today === null ? <Text style={{ color: MUTED }}>{`  ·  T+0 unavailable: ${noT0 ?? "the model could not calibrate these legs"}`}</Text> : null}
          </Text>
        </>
      )}

      {figures ? (
        <View style={styles.figureGrid}>
          <Figure styles={styles} label="Basket P&L · T+0" value={todayNow !== null ? rupees(todayNow, true) ?? "no estimate" : noT0 ?? "no estimate"} />
          <Figure styles={styles} label="Expiry value now" value={expiryNow !== null ? rupees(expiryNow, true) : "not priced"} />
          <Figure styles={styles} label="Max profit" value={figures.maxProfit} />
          <Figure styles={styles} label="Max loss" value={figures.maxLoss} />
          <Figure styles={styles} label="POP (est.)" value={figures.pop} />
          <Figure styles={styles} label={figures.net.startsWith("Net credit") ? "Net credit" : "Net debit"} value={figures.net.replace(/^Net (credit|debit) /, "")} />
          <Figure styles={styles} label="Break-evens" value={figures.breakEvens} wide />
          <Figure styles={styles} label="Est. margin" value={margin} wide />
          <Figure styles={styles} label="Greeks" value={figures.greeks} wide />
          <Figure styles={styles} label="Horizon" value={figures.horizon} wide />
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
              <Text style={[styles.legName, { color: leg.side === "BUY" ? GREEN : RED }]}>
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
              <Text style={[styles.legNum, { color: (moved ?? 0) >= 0 ? GREEN : RED }]}>{moved === null ? "no price" : rupees(moved, true)}</Text>
              {leg.quantity <= 0 && moved !== null && leg.bookedBasis ? <Text style={styles.legState}>{leg.bookedBasis}</Text> : null}
            </View>
          </View>
        );
      })}
      {!priceable ? <Text style={styles.legState}>This basket is closed by its own engine; exits are placed from Algo Lab, not here.</Text> : null}
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
          placeholderTextColor={MUTED}
          keyboardType="decimal-pad"
          accessibilityLabel={`Exit price for ${symbol}`}
        />
        <TextInput
          style={[styles.field, { width: 92 }]}
          value={draft.units}
          onChangeText={value => setDraft({ ...draft, units: value })}
          placeholder="units"
          placeholderTextColor={MUTED}
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
      <Text style={styles.legState}>Only the price. This basket row is what changes — no order goes to the broker.</Text>
    </View>
  );
}

const BRAND = "#38bdf8";
const WARN = "#f59e0b";
const GREEN = "#22c55e";
const RED = "#ef4444";
const MUTED = "#64748b";
const BORDER = "#334155";

/** Kept as one object because the desk is dark-only on this build; the Builder's own palette stays local to it. */
function sheet() {
  return StyleSheet.create({
    empty: { padding: 28, alignItems: "center", gap: 10 },
    deskHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
    deskTitle: { fontSize: 13, fontWeight: "700", color: "#f1f5f9" },
    emptyTitle: { fontSize: 15, fontWeight: "700", color: "#f1f5f9" },
    emptyBody: { fontSize: 13, color: MUTED, textAlign: "center", lineHeight: 19 },
    aggregate: { borderWidth: 1, borderColor: BORDER, borderRadius: 10, backgroundColor: "#1e293b", padding: 10, gap: 8 },
    aggregateRow: { flexDirection: "row", gap: 10 },
    aggregateFoot: { fontSize: 11, color: MUTED, lineHeight: 16 },
    figureLabel: { fontSize: 10, fontWeight: "700", letterSpacing: 0.6, color: MUTED, textTransform: "uppercase" },
    figure: { fontSize: 15, fontWeight: "700", color: "#f1f5f9" },
    figureValue: { fontSize: 12.5, fontWeight: "600", color: "#f1f5f9", lineHeight: 17 },
    figureBig: { fontSize: 19, fontWeight: "800" },
    card: { borderWidth: 1, borderColor: BORDER, borderRadius: 10, backgroundColor: "#1e293b", padding: 10, gap: 8 },
    cardHead: { flexDirection: "row", alignItems: "center", gap: 8 },
    cardTitle: { fontSize: 15, fontWeight: "700", color: "#f1f5f9" },
    cardMeta: { fontSize: 11.5, color: MUTED, marginTop: 2, lineHeight: 16 },
    cardFigures: { flexDirection: "row", gap: 16 },
    cardNote: { fontSize: 11.5, color: WARN, lineHeight: 16 },
    back: { flexDirection: "row", alignItems: "center", gap: 2, alignSelf: "flex-start" },
    backText: { fontSize: 13, fontWeight: "700", color: BRAND },
    basketTitle: { fontSize: 17, fontWeight: "700", color: "#f1f5f9" },
    payoff: { borderWidth: 1, borderColor: BORDER, borderRadius: 10, backgroundColor: "#1e293b", padding: 10, gap: 6 },
    payoffHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
    payoffAxis: { flexDirection: "row", justifyContent: "space-between" },
    axisText: { fontSize: 11, color: MUTED },
    legend: { fontSize: 11, color: "#f1f5f9" },
    figureGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12, paddingTop: 6, borderTopWidth: 1, borderTopColor: BORDER },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: BORDER, backgroundColor: "#1e293b" },
    chipPrimary: { backgroundColor: BRAND, borderColor: BRAND },
    chipText: { fontSize: 12.5, fontWeight: "700", color: "#f1f5f9" },
    legs: { borderWidth: 1, borderColor: BORDER, borderRadius: 10, backgroundColor: "#1e293b", padding: 10, gap: 8 },
    legHead: { flexDirection: "row", gap: 6, borderBottomWidth: 1, borderBottomColor: BORDER, paddingBottom: 6 },
    legHeadText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.6, color: MUTED, textTransform: "uppercase" },
    legRow: { flexDirection: "row", gap: 6, alignItems: "flex-start" },
    legName: { fontSize: 12.5, fontWeight: "600" },
    legNum: { fontSize: 12.5, color: "#f1f5f9", textAlign: "right" },
    legState: { fontSize: 10.5, color: MUTED, lineHeight: 15 },
    link: { fontSize: 11.5, fontWeight: "700", color: BRAND },
    field: { borderWidth: 1, borderColor: BORDER, borderRadius: 8, backgroundColor: "#0f172a", paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: "#f1f5f9" },
    note: { fontSize: 12, color: WARN, lineHeight: 17 },
    basis: { fontSize: 11, color: MUTED, lineHeight: 16 },
    small: { fontSize: 12, color: MUTED },
  });
}
