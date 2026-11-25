/**
 * PayoffChart — Complete Professional Options Payoff Chart (Sensibull & Kotak Neo style).
 *
 * Provides:
 * 1. Dual Curves: Exact Expiry line + Theoretical T+0 curve from server Black-Scholes model.
 * 2. Real-time Spot vertical guide with Strategy P&L dots at current spot.
 * 3. Interactive Touch Crosshair with floating tooltip displaying target spot, % move, Expiry P&L & T+0 P&L.
 * 4. Key Strategy Metrics Grid: Max Profit, Max Loss, Risk:Reward Ratio, POP, Breakevens, Net Credit/Debit, Est. Margin.
 * 5. Sensibull-style Greeks Dashboard: Combined Delta, Theta (decay/day), Gamma, Vega, and Position IV.
 * 6. Sensibull-style What-If Scenario Simulator: Spot shock (-5% to +5%) and IV shift (-10% to +10%).
 * 7. Multi-Expiry / Calendar Spread support via strategy analysis model.
 * 8. Zero-latency instant local fallback via exact intrinsic math (heldPayoff) so chart never locks up.
 */

import React, { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Circle, Line, Path, Rect } from "react-native-svg";
import { Ionicons } from "@expo/vector-icons";
import {
  buildAnalysis,
  curves,
  heldPayoff,
  payoffFigures,
  rupees,
  valueAt,
  type Basket,
  type OptionChainData,
  type StrategyAnalysis,
} from "@nraialgo/shared/api";
import { formatNumber } from "@nraialgo/shared/utils";
import { useApi } from "@/hooks/useApi";
import { useTheme } from "@/components/ThemeProvider";

export interface PayoffChartLeg {
  strike: string;
  right: "CE" | "PE";
  side: "BUY" | "SELL";
  lots: number;
  lotSize: number;
  expiry: string;
  entryPrice?: number | null;
}

export interface PayoffChartProps {
  underlying: string;
  expiry?: string;
  legs: readonly PayoffChartLeg[];
  spot: number | null;
  chains: readonly (OptionChainData | undefined)[];
  title?: string;
}

/** Theme palette generator */
function getPalette(theme: string) {
  const isDark = theme === "dark";
  return {
    isDark,
    bg: isDark ? "#0f172a" : "#f8fafc",
    card: isDark ? "#1e293b" : "#ffffff",
    cardAlt: isDark ? "#182234" : "#f1f5f9",
    text: isDark ? "#f1f5f9" : "#0f172a",
    muted: isDark ? "#94a3b8" : "#64748b",
    border: isDark ? "#334155" : "#e2e8f0",
    borderLight: isDark ? "#1e293b" : "#f1f5f9",
    brand: isDark ? "#38bdf8" : "#0284c7",
    brandBg: isDark ? "rgba(56, 189, 248, 0.12)" : "rgba(2, 132, 199, 0.08)",
    pos: isDark ? "#22c55e" : "#16a34a",
    posBg: isDark ? "rgba(34, 197, 94, 0.12)" : "rgba(22, 163, 74, 0.08)",
    neg: isDark ? "#ef4444" : "#dc2626",
    negBg: isDark ? "rgba(239, 68, 68, 0.12)" : "rgba(220, 38, 38, 0.08)",
    warn: isDark ? "#f59e0b" : "#d97706",
    warnBg: isDark ? "rgba(245, 158, 11, 0.12)" : "rgba(217, 119, 6, 0.08)",
  };
}

export default function PayoffChart({
  underlying,
  expiry,
  legs,
  spot,
  chains,
  title,
}: PayoffChartProps) {
  const { useStrategyAnalysis, usePlanningMargin } = useApi();
  const { resolvedTheme } = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  const colors = useMemo(() => getPalette(resolvedTheme), [resolvedTheme]);

  // Zoom & Pan state
  const [zoom, setZoom] = useState(1);
  const [touchPx, setTouchPx] = useState<number | null>(null);

  // Scenario simulator state (Sensibull style)
  const [showScenario, setShowScenario] = useState(false);
  const [spotShockPct, setSpotShockPct] = useState(0);
  const [ivShiftPoints, setIvShiftPoints] = useState(0);

  // Active view tab: "chart" | "greeks"
  const [activeTab, setActiveTab] = useState<"chart" | "greeks">("chart");

  // 1. Build virtual basket structure expected by buildAnalysis & heldPayoff
  const virtualBasket: Basket = useMemo(() => {
    const activeLegs = legs.filter(l => l.lots > 0);
    const exchange = "NSE";
    const payoffLegs = activeLegs.map(leg => ({
      underlying,
      strike: String(leg.strike),
      right: leg.right,
      action: (leg.side === "BUY" ? "buy" : "sell") as "buy" | "sell",
      expiry: leg.expiry,
      lots: leg.lots,
      lotSize: leg.lotSize,
      entryPrice: leg.entryPrice ?? undefined,
      instrumentId: `instrument:v1:${exchange}:FO:${underlying}_${leg.expiry.replace(/-/g, "")}_${leg.strike}_${leg.right}`,
    }));

    return {
      id: "builder-virtual",
      name: title || `${underlying} Strategy`,
      underlying,
      expiry: expiry || (payoffLegs[0]?.expiry ?? ""),
      kind: "order",
      provider: "broker",
      status: "open",
      openedAt: new Date().toISOString(),
      legs: payoffLegs.map(l => ({
        symbol: `${underlying}_${l.expiry.replace(/-/g, "")}_${l.strike}_${l.right}`,
        instrumentId: l.instrumentId,
        side: l.action === "buy" ? ("BUY" as const) : ("SELL" as const),
        quantity: l.lots * l.lotSize,
        lots: l.lots,
        lotSize: l.lotSize,
        entryPrice: l.entryPrice ?? 0,
        markPrice: l.entryPrice ?? null,
      })),
      payoffLegs,
      charges: [],
      warnings: [],
      realized: 0,
      spot: spot ? String(spot) : "0",
    } as unknown as Basket;
  }, [legs, underlying, expiry, spot, title]);

  // 2. Prepare chains: fallback missing ltp to close/ask/bid/entryPrice so after-hours builds succeed
  const preparedChains = useMemo(() => {
    const answered = chains.filter((c): c is OptionChainData => !!c);
    if (!answered.length) return answered;

    return answered.map(c => ({
      ...c,
      rows: c.rows.map(row => {
        const prepareQuote = (quote: typeof row.call, right: "CE" | "PE") => {
          if (!quote) return quote;
          const matchingLeg = legs.find(
            l => Number(l.strike) === Number(row.strike) && l.right === right && l.expiry === c.expiry
          );
          const fallbackPrice =
            matchingLeg?.entryPrice && matchingLeg.entryPrice > 0
              ? String(matchingLeg.entryPrice)
              : undefined;

          const currentLtp = Number(quote.ltp);
          const hasLtp = Number.isFinite(currentLtp) && currentLtp > 0;
          const ltpVal = hasLtp
            ? quote.ltp
            : quote.ask || quote.bid || fallbackPrice || quote.ltp;

          const currentSpot = Number(c.spot.price);
          const spotVal = Number.isFinite(currentSpot) && currentSpot > 0 ? String(currentSpot) : spot ? String(spot) : "0";

          return {
            ...quote,
            ltp: ltpVal,
            ltpAt: quote.ltpAt || quote.quote?.at || new Date().toISOString(),
            quote: {
              ...(quote.quote || { quality: "stale" as const }),
              at: quote.quote?.at || quote.ltpAt || new Date().toISOString(),
            },
            spot: spotVal,
          };
        };

        return {
          ...row,
          call: prepareQuote(row.call, "CE"),
          put: prepareQuote(row.put, "PE"),
        };
      }),
    })) as unknown as readonly OptionChainData[];
  }, [chains, legs, spot]);

  // 3. Build Analysis payload for backend model & planning margin
  const built = useMemo(
    () => buildAnalysis(virtualBasket, preparedChains),
    [virtualBasket, preparedChains]
  );

  // Apply scenario shocks to request body if requested
  const analysisBody = useMemo(() => {
    if (!built.body) return null;
    return {
      ...built.body,
      spotShockPct,
      ivShiftPoints,
    };
  }, [built.body, spotShockPct, ivShiftPoints]);

  // 4. API Queries for Strategy Analysis (Black-Scholes T+0, POP, Greeks) & Margin
  const analysis = useStrategyAnalysis(analysisBody);
  const margin = usePlanningMargin(built.margin);

  // 5. Calculate Curves: Server model with T+0 curve, or instantaneous local fallback
  const model = useMemo(
    () => (analysis.data ? curves(analysis.data, 0) : null),
    [analysis.data]
  );

  const held = useMemo(
    () => heldPayoff(virtualBasket, 0),
    [virtualBasket]
  );

  // Expiry figures
  const until = useMemo(() => {
    const dates = [...new Set(virtualBasket.payoffLegs.map(l => l.expiry).filter(Boolean))];
    return dates.join(" & ") || null;
  }, [virtualBasket]);

  const figures = useMemo(
    () => (analysis.data ? payoffFigures(analysis.data, until, 0) : null),
    [analysis.data, until]
  );

  // 6. SVG Geometry & Coordinate mapping
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

    const lines = [expiryLine, todayLine].filter((l): l is number[] => !!l);
    const w = Math.round(screenWidth - 32);
    const h = 168;
    const padX = 8;
    const padTop = 14;
    const padBottom = 16;

    const fullLo = xs[0];
    const fullHi = xs[xs.length - 1];
    const center = (fullLo + fullHi) / 2;
    const halfRange = (fullHi - fullLo) / 2 / zoom;
    const lo = center - halfRange;
    const hi = center + halfRange;

    const visibleXs = xs.filter(x => x >= lo && x <= hi);
    const visibleExpiry = expiryLine?.filter((_, i) => xs[i] >= lo && xs[i] <= hi) ?? null;
    const visibleToday = todayLine?.filter((_, i) => xs[i] >= lo && xs[i] <= hi) ?? null;

    let yMin = 0;
    let yMax = 0;
    for (const arr of lines) {
      for (const y of arr) {
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }

    // Add padding to y bounds for breathing room
    const ySpan = yMax - yMin;
    const yPad = Math.max(ySpan * 0.1, 50);
    const yLo = ySpan < 0.005 ? yMin - 100 : yMin - yPad;
    const yHi = ySpan < 0.005 ? yMax + 100 : yMax + yPad;

    const px = (x: number) => padX + ((x - lo) / (hi - lo || 1)) * (w - padX * 2);
    const py = (y: number) => padTop + (1 - (y - yLo) / (yHi - yLo || 1)) * (h - padTop - padBottom);

    const makePath = (values: number[], spotsArr: number[]) => {
      const len = spotsArr.length;
      if (len === 0) return "";
      let path = `M${px(spotsArr[0]).toFixed(1)},${py(values[0]).toFixed(1)}`;
      for (let i = 1; i < len; i++) {
        path += `L${px(spotsArr[i]).toFixed(1)},${py(values[i]).toFixed(1)}`;
      }
      return path;
    };

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
      expiryValues: expiryLine,
      todayValues: todayLine,
      expiryPath:
        visibleExpiry && visibleXs.length === visibleExpiry.length
          ? makePath(visibleExpiry, visibleXs)
          : expiryLine
          ? makePath(expiryLine, xs)
          : null,
      todayPath:
        visibleToday && visibleXs.length === visibleToday.length
          ? makePath(visibleToday, visibleXs)
          : todayLine
          ? makePath(todayLine, xs)
          : null,
    };
  }, [model, held, screenWidth, zoom]);

  // Current spot coordinates & values
  const effectiveSpot = Number(analysis.data?.spot ?? spot ?? virtualBasket.spot);
  const spotOnChart =
    !!chart && Number.isFinite(effectiveSpot) && effectiveSpot > 0 && effectiveSpot >= chart.lo && effectiveSpot <= chart.hi;

  const expiryAtSpot = model
    ? model.atSpot
    : spotOnChart && held
    ? valueAt(held.spots, held.values, effectiveSpot)
    : null;
  const todayAtSpot = model?.atSpotToday ?? null;

  // Touch & Crosshair interaction
  const touchSpot =
    chart && touchPx !== null
      ? chart.lo + ((touchPx - 8) / (chart.w - 16)) * (chart.hi - chart.lo)
      : null;
  const touchExpiry =
    touchSpot !== null && chart?.expiryValues ? valueAt(chart.xs, chart.expiryValues, touchSpot) : null;
  const touchToday =
    touchSpot !== null && chart?.todayValues ? valueAt(chart.xs, chart.todayValues, touchSpot) : null;
  const touchPctMove =
    touchSpot !== null && effectiveSpot > 0 ? ((touchSpot - effectiveSpot) / effectiveSpot) * 100 : 0;

  const moveRaf = useRef<number | null>(null);
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: evt => setTouchPx(evt.nativeEvent.locationX),
        onPanResponderMove: evt => {
          const locX = evt.nativeEvent.locationX;
          if (moveRaf.current !== null) cancelAnimationFrame(moveRaf.current);
          moveRaf.current = requestAnimationFrame(() => setTouchPx(locX));
        },
        onPanResponderRelease: () => {
          if (moveRaf.current !== null) cancelAnimationFrame(moveRaf.current);
          setTouchPx(null);
        },
        onPanResponderTerminate: () => {
          if (moveRaf.current !== null) cancelAnimationFrame(moveRaf.current);
          setTouchPx(null);
        },
      }),
    [chart]
  );

  // Breakevens
  const breakEvens = useMemo(() => {
    if (figures?.breakEvens && figures.breakEvens !== "None inside the range the curve was drawn over") {
      return figures.breakEvens;
    }
    if (held?.breakEvens && held.breakEvens.length > 0) {
      return held.breakEvens.map(v => formatNumber(v, 2)).join(" · ");
    }
    return "None in range";
  }, [figures, held]);

  // Risk : Reward ratio calculation
  const riskRewardText = useMemo(() => {
    const maxP = analysis.data?.expiry?.maxProfit ?? held?.max;
    const maxL = analysis.data?.expiry?.maxLoss ?? held?.min;
    const profitUnbounded = analysis.data?.expiry?.maxProfitUnbounded ?? (held && held.max === null);
    const lossUnbounded = analysis.data?.expiry?.maxLossUnbounded ?? (held && held.min === null);

    if (profitUnbounded && lossUnbounded) return "1 : 1 (Open)";
    if (profitUnbounded) return "1 : Unlimited";
    if (lossUnbounded) return "Unlimited Risk";

    const pNum = typeof maxP === "number" ? maxP : Number(maxP);
    const lNum = typeof maxL === "number" ? Math.abs(maxL) : Math.abs(Number(maxL));

    if (Number.isFinite(pNum) && Number.isFinite(lNum) && pNum > 0 && lNum > 0) {
      const ratio = pNum / lNum;
      return `1 : ${ratio.toFixed(2)}`;
    }
    return "—";
  }, [analysis.data, held]);

  // Margin display
  const marginDisplay = useMemo(() => {
    if (!built.margin) return "—";
    if (margin.isError) return "Unavailable";
    if (margin.isLoading) return "Estimating…";
    if (margin.data?.available && margin.data.amount) {
      return rupees(margin.data.amount, false) ?? "—";
    }
    return margin.data?.reason || "—";
  }, [built.margin, margin]);

  // If there are no active legs
  if (!legs.length) {
    return (
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.emptyContainer}>
          <Ionicons name="analytics-outline" size={32} color={colors.muted} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>No Legs Staged</Text>
          <Text style={[styles.emptySubtitle, { color: colors.muted }]}>
            Add contracts or select a spread template above to generate the live payoff graph.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {/* ─── Header & Mode Controls ─────────────────────────────────── */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={[styles.cardTitle, { color: colors.text }]}>
              {title || `${underlying} Payoff Analysis`}
            </Text>
            {analysis.isLoading && (
              <ActivityIndicator size="small" color={colors.brand} style={{ marginLeft: 2 }} />
            )}
          </View>
          <Text style={[styles.cardSubtitle, { color: colors.muted }]}>
            {figures?.horizon || (until ? `Expiry ${until}` : "Strategy Expiry & T+0")}
          </Text>
        </View>

        {/* Tab switch: Chart vs Greeks */}
        <View style={[styles.tabSegment, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
          <TouchableOpacity
            style={[styles.tabBtn, activeTab === "chart" && { backgroundColor: colors.card }]}
            onPress={() => setActiveTab("chart")}
            accessibilityRole="button"
          >
            <Text
              style={[
                styles.tabBtnText,
                { color: activeTab === "chart" ? colors.brand : colors.muted },
              ]}
            >
              Payoff
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tabBtn, activeTab === "greeks" && { backgroundColor: colors.card }]}
            onPress={() => setActiveTab("greeks")}
            accessibilityRole="button"
          >
            <Text
              style={[
                styles.tabBtnText,
                { color: activeTab === "greeks" ? colors.brand : colors.muted },
              ]}
            >
              Greeks
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ─── Sensibull / Kotak Neo Key Metric Tiles ──────────────────── */}
      <View style={styles.metricsRow}>
        {/* Max Profit */}
        <View style={[styles.metricTile, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
          <Text style={[styles.metricLabel, { color: colors.muted }]}>MAX PROFIT</Text>
          <Text
            style={[
              styles.metricValue,
              { color: colors.pos },
            ]}
            numberOfLines={1}
          >
            {figures?.maxProfit || (held?.max === null ? "Unlimited" : rupees(held?.max) ?? "—")}
          </Text>
        </View>

        {/* Max Loss */}
        <View style={[styles.metricTile, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
          <Text style={[styles.metricLabel, { color: colors.muted }]}>MAX LOSS</Text>
          <Text
            style={[
              styles.metricValue,
              { color: colors.neg },
            ]}
            numberOfLines={1}
          >
            {figures?.maxLoss || (held?.min === null ? "Unlimited" : rupees(Math.abs(held?.min ?? 0)) ?? "—")}
          </Text>
        </View>

        {/* Risk : Reward */}
        <View style={[styles.metricTile, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
          <Text style={[styles.metricLabel, { color: colors.muted }]}>RISK : REWARD</Text>
          <Text style={[styles.metricValue, { color: colors.text }]} numberOfLines={1}>
            {riskRewardText}
          </Text>
        </View>

        {/* POP */}
        <View style={[styles.metricTile, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
          <Text style={[styles.metricLabel, { color: colors.muted }]}>POP</Text>
          <Text style={[styles.metricValue, { color: colors.brand }]} numberOfLines={1}>
            {analysis.data?.pop?.available ? `${(analysis.data.pop.value * 100).toFixed(1)}%` : "—"}
          </Text>
        </View>
      </View>

      {/* ─── TAB 1: Payoff Graph View ────────────────────────────────── */}
      {activeTab === "chart" && (
        <>
          {/* Chart Controls Bar */}
          <View style={styles.chartControlBar}>
            {/* Legend */}
            <View style={styles.legendContainer}>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: colors.brand }]} />
                <Text style={[styles.legendText, { color: colors.text }]}>Expiry</Text>
              </View>
              {chart?.todayPath && (
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: colors.warn }]} />
                  <Text style={[styles.legendText, { color: colors.text }]}>T+0 (Today)</Text>
                </View>
              )}
            </View>

            {/* Current P&L / Zoom */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {todayAtSpot !== null && (
                <Text style={[styles.currentPnlBadge, { color: todayAtSpot >= 0 ? colors.pos : colors.neg }]}>
                  {`T+0: ${rupees(todayAtSpot, true)}`}
                </Text>
              )}
              {chart && (
                <View style={styles.zoomControls}>
                  <TouchableOpacity
                    style={[styles.zoomBtn, { borderColor: colors.border, backgroundColor: colors.cardAlt }]}
                    onPress={() => setZoom(z => Math.min(z * 1.5, 10))}
                    accessibilityLabel="Zoom in"
                  >
                    <Ionicons name="add" size={14} color={colors.text} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.zoomBtn,
                      zoom <= 1 && { opacity: 0.3 },
                      { borderColor: colors.border, backgroundColor: colors.cardAlt },
                    ]}
                    onPress={() => setZoom(z => Math.max(z / 1.5, 1))}
                    disabled={zoom <= 1}
                    accessibilityLabel="Zoom out"
                  >
                    <Ionicons name="remove" size={14} color={colors.text} />
                  </TouchableOpacity>
                  {zoom > 1 && (
                    <TouchableOpacity
                      style={[styles.fitBtn, { borderColor: colors.border, backgroundColor: colors.cardAlt }]}
                      onPress={() => setZoom(1)}
                      accessibilityLabel="Reset zoom"
                    >
                      <Text style={[styles.fitBtnText, { color: colors.brand }]}>Fit</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
            </View>
          </View>

          {/* SVG Canvas with Crosshair & PanResponder */}
          {!chart ? (
            <View style={styles.loadingChartBox}>
              <ActivityIndicator color={colors.brand} />
              <Text style={[styles.loadingText, { color: colors.muted }]}>
                Calculating strategy payoff curve…
              </Text>
            </View>
          ) : (
            <View {...panResponder.panHandlers} style={{ position: "relative" }}>
              <Svg width={chart.w} height={chart.h}>
                {/* Zero P&L Reference Axis */}
                <Line
                  x1={0}
                  y1={chart.zero}
                  x2={chart.w}
                  y2={chart.zero}
                  stroke={colors.border}
                  strokeWidth={1.2}
                  strokeDasharray="4 3"
                />

                {/* T+0 Today's Curve (Warm Amber) */}
                {chart.todayPath && (
                  <Path
                    d={chart.todayPath}
                    stroke={colors.warn}
                    strokeWidth={2}
                    fill="none"
                    opacity={0.92}
                  />
                )}

                {/* Expiry Curve (Brand Cyan/Blue) */}
                {chart.expiryPath && (
                  <Path
                    d={chart.expiryPath}
                    stroke={colors.brand}
                    strokeWidth={2.4}
                    fill="none"
                  />
                )}

                {/* Current Spot Vertical Line */}
                {spotOnChart && (
                  <>
                    <Line
                      x1={chart.px(effectiveSpot)}
                      y1={8}
                      x2={chart.px(effectiveSpot)}
                      y2={chart.h - 10}
                      stroke={colors.muted}
                      strokeWidth={1}
                      strokeDasharray="3 3"
                      opacity={0.7}
                    />
                    {expiryAtSpot !== null && chart.expiryPath && (
                      <Circle
                        cx={chart.px(effectiveSpot)}
                        cy={chart.py(expiryAtSpot)}
                        r={4}
                        fill={colors.brand}
                      />
                    )}
                    {todayAtSpot !== null && chart.todayPath && (
                      <Circle
                        cx={chart.px(effectiveSpot)}
                        cy={chart.py(todayAtSpot)}
                        r={3.5}
                        fill={colors.warn}
                      />
                    )}
                  </>
                )}

                {/* Interactive Touch Crosshair Cursor */}
                {touchSpot !== null && touchPx !== null && touchPx >= 8 && touchPx <= chart.w - 8 && (
                  <>
                    <Line
                      x1={chart.px(touchSpot)}
                      y1={0}
                      x2={chart.px(touchSpot)}
                      y2={chart.h}
                      stroke={colors.text}
                      strokeWidth={0.8}
                      opacity={0.5}
                    />
                    {touchExpiry !== null && chart.expiryPath && (
                      <Circle
                        cx={chart.px(touchSpot)}
                        cy={chart.py(touchExpiry)}
                        r={3.5}
                        fill={colors.brand}
                      />
                    )}
                    {touchToday !== null && chart.todayPath && (
                      <Circle
                        cx={chart.px(touchSpot)}
                        cy={chart.py(touchToday)}
                        r={3.5}
                        fill={colors.warn}
                      />
                    )}
                  </>
                )}
              </Svg>

              {/* Floating Crosshair Tooltip (Sensibull style) */}
              {touchSpot !== null && touchPx !== null && (
                <View
                  style={[
                    styles.crosshairTooltip,
                    {
                      backgroundColor: colors.card,
                      borderColor: colors.border,
                      left: Math.min(Math.max(touchPx - 65, 4), chart.w - 135),
                      top: 4,
                    },
                  ]}
                >
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <Text style={[styles.tooltipSpot, { color: colors.text }]}>
                      {formatNumber(touchSpot, 1)}
                    </Text>
                    <Text
                      style={[
                        styles.tooltipMove,
                        { color: touchPctMove >= 0 ? colors.pos : colors.neg },
                      ]}
                    >
                      {`${touchPctMove >= 0 ? "+" : ""}${touchPctMove.toFixed(2)}%`}
                    </Text>
                  </View>
                  {touchExpiry !== null && (
                    <Text style={[styles.tooltipPnl, { color: touchExpiry >= 0 ? colors.pos : colors.neg }]}>
                      {`Expiry: ${rupees(touchExpiry, true)}`}
                    </Text>
                  )}
                  {touchToday !== null && (
                    <Text style={[styles.tooltipPnl, { color: touchToday >= 0 ? colors.pos : colors.neg }]}>
                      {`T+0: ${rupees(touchToday, true)}`}
                    </Text>
                  )}
                </View>
              )}
            </View>
          )}

          {/* Spot & Axis Info */}
          {chart && (
            <View style={styles.axisRow}>
              <Text style={[styles.axisText, { color: colors.muted }]}>
                {formatNumber(chart.lo, 0)}
              </Text>
              <Text style={[styles.axisText, { color: colors.text, fontWeight: "700" }]}>
                {effectiveSpot > 0 ? `${underlying} Spot: ${formatNumber(effectiveSpot, 2)}` : "Underlying"}
              </Text>
              <Text style={[styles.axisText, { color: colors.muted }]}>
                {formatNumber(chart.hi, 0)}
              </Text>
            </View>
          )}

          {/* Secondary Stats Row: Breakevens, Margin, Net Premium */}
          <View style={[styles.detailStatsContainer, { borderTopColor: colors.border }]}>
            <View style={styles.detailStatItem}>
              <Text style={[styles.detailStatLabel, { color: colors.muted }]}>Breakevens</Text>
              <Text style={[styles.detailStatValue, { color: colors.text }]} numberOfLines={1}>
                {breakEvens}
              </Text>
            </View>

            <View style={styles.detailStatItem}>
              <Text style={[styles.detailStatLabel, { color: colors.muted }]}>
                {figures?.net?.startsWith("Net credit") ? "Net Credit" : "Net Debit"}
              </Text>
              <Text
                style={[
                  styles.detailStatValue,
                  { color: figures?.net?.startsWith("Net credit") ? colors.pos : colors.text },
                ]}
                numberOfLines={1}
              >
                {figures?.net ? figures.net.replace(/^Net (credit|debit) /, "") : rupees(held?.netDebit) ?? "—"}
              </Text>
            </View>

            <View style={styles.detailStatItem}>
              <Text style={[styles.detailStatLabel, { color: colors.muted }]}>Est. Margin</Text>
              <Text style={[styles.detailStatValue, { color: colors.text }]} numberOfLines={1}>
                {marginDisplay}
              </Text>
            </View>
          </View>
        </>
      )}

      {/* ─── TAB 2: Professional Greeks & Sensitivity ───────────────── */}
      {activeTab === "greeks" && (
        <View style={styles.greeksContainer}>
          <Text style={[styles.sectionHeading, { color: colors.text }]}>Strategy Greeks (Combined)</Text>
          {analysis.data?.greeks?.available ? (
            <View style={styles.greeksGrid}>
              <View style={[styles.greekCard, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
                <Text style={[styles.greekName, { color: colors.muted }]}>Delta (Δ)</Text>
                <Text
                  style={[
                    styles.greekVal,
                    { color: analysis.data.greeks.delta >= 0 ? colors.pos : colors.neg },
                  ]}
                >
                  {analysis.data.greeks.delta.toFixed(2)}
                </Text>
                <Text style={[styles.greekDesc, { color: colors.muted }]}>Per 1 pt underlying move</Text>
              </View>

              <View style={[styles.greekCard, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
                <Text style={[styles.greekName, { color: colors.muted }]}>Theta (Θ)</Text>
                <Text
                  style={[
                    styles.greekVal,
                    { color: analysis.data.greeks.theta >= 0 ? colors.pos : colors.neg },
                  ]}
                >
                  {`${analysis.data.greeks.theta.toFixed(2)}/day`}
                </Text>
                <Text style={[styles.greekDesc, { color: colors.muted }]}>Daily time decay</Text>
              </View>

              <View style={[styles.greekCard, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
                <Text style={[styles.greekName, { color: colors.muted }]}>Gamma (Γ)</Text>
                <Text style={[styles.greekVal, { color: colors.text }]}>
                  {analysis.data.greeks.gamma.toFixed(4)}
                </Text>
                <Text style={[styles.greekDesc, { color: colors.muted }]}>Delta acceleration</Text>
              </View>

              <View style={[styles.greekCard, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
                <Text style={[styles.greekName, { color: colors.muted }]}>Vega (ν)</Text>
                <Text
                  style={[
                    styles.greekVal,
                    { color: analysis.data.greeks.vega >= 0 ? colors.pos : colors.neg },
                  ]}
                >
                  {analysis.data.greeks.vega.toFixed(2)}
                </Text>
                <Text style={[styles.greekDesc, { color: colors.muted }]}>Per 1% IV change</Text>
              </View>

              <View style={[styles.greekCard, { backgroundColor: colors.cardAlt, borderColor: colors.border, flex: 2 }]}>
                <Text style={[styles.greekName, { color: colors.muted }]}>Average IV</Text>
                <Text style={[styles.greekVal, { color: colors.brand }]}>
                  {`${analysis.data.greeks.ivPct.toFixed(1)}%`}
                </Text>
                <Text style={[styles.greekDesc, { color: colors.muted }]}>Strategy position IV</Text>
              </View>
            </View>
          ) : (
            <View style={styles.unavailableBox}>
              <Text style={[styles.unavailableText, { color: colors.muted }]}>
                {analysis.data?.greeks && analysis.data.greeks.available === false
                  ? analysis.data.greeks.reason
                  : "Greeks require market quotes to calibrate."}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* ─── Sensibull Scenario Simulator Drawer Toggle ─────────────── */}
      <TouchableOpacity
        style={[styles.scenarioToggle, { borderTopColor: colors.border }]}
        onPress={() => setShowScenario(prev => !prev)}
        accessibilityRole="button"
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Ionicons
            name={showScenario ? "chevron-up" : "options-outline"}
            size={16}
            color={colors.brand}
          />
          <Text style={[styles.scenarioToggleText, { color: colors.brand }]}>
            {showScenario ? "Hide What-If Simulator" : "Sensibull What-If Simulator (Target & IV)"}
          </Text>
          {(spotShockPct !== 0 || ivShiftPoints !== 0) && (
            <View style={[styles.activePill, { backgroundColor: colors.warnBg }]}>
              <Text style={[styles.activePillText, { color: colors.warn }]}>Active</Text>
            </View>
          )}
        </View>
      </TouchableOpacity>

      {/* Simulator Sliders */}
      {showScenario && (
        <View style={[styles.simulatorBox, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
          {/* Spot Move Simulation */}
          <View style={styles.simRow}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
              <Text style={[styles.simLabel, { color: colors.text }]}>Target Spot Move:</Text>
              <Text style={[styles.simValue, { color: spotShockPct === 0 ? colors.muted : spotShockPct > 0 ? colors.pos : colors.neg }]}>
                {`${spotShockPct > 0 ? "+" : ""}${spotShockPct.toFixed(1)}%`}
                {effectiveSpot > 0 && ` (${formatNumber(effectiveSpot * (1 + spotShockPct / 100), 1)})`}
              </Text>
            </View>
            <View style={styles.simButtonsRow}>
              {[-3, -2, -1, 0, 1, 2, 3].map(pct => (
                <TouchableOpacity
                  key={`spot-${pct}`}
                  style={[
                    styles.simPill,
                    spotShockPct === pct
                      ? { backgroundColor: colors.brand, borderColor: colors.brand }
                      : { backgroundColor: colors.card, borderColor: colors.border },
                  ]}
                  onPress={() => setSpotShockPct(pct)}
                >
                  <Text
                    style={[
                      styles.simPillText,
                      { color: spotShockPct === pct ? "#ffffff" : colors.text },
                    ]}
                  >
                    {pct === 0 ? "ATM" : `${pct > 0 ? "+" : ""}${pct}%`}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* IV Shift Simulation */}
          <View style={[styles.simRow, { marginTop: 10 }]}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
              <Text style={[styles.simLabel, { color: colors.text }]}>IV Shift:</Text>
              <Text style={[styles.simValue, { color: ivShiftPoints === 0 ? colors.muted : colors.warn }]}>
                {`${ivShiftPoints > 0 ? "+" : ""}${ivShiftPoints}%`}
              </Text>
            </View>
            <View style={styles.simButtonsRow}>
              {[-5, -2, 0, 2, 5].map(pts => (
                <TouchableOpacity
                  key={`iv-${pts}`}
                  style={[
                    styles.simPill,
                    ivShiftPoints === pts
                      ? { backgroundColor: colors.warn, borderColor: colors.warn }
                      : { backgroundColor: colors.card, borderColor: colors.border },
                  ]}
                  onPress={() => setIvShiftPoints(pts)}
                >
                  <Text
                    style={[
                      styles.simPillText,
                      { color: ivShiftPoints === pts ? "#ffffff" : colors.text },
                    ]}
                  >
                    {pts === 0 ? "0%" : `${pts > 0 ? "+" : ""}${pts}%`}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Reset simulation */}
          {(spotShockPct !== 0 || ivShiftPoints !== 0) && (
            <TouchableOpacity
              style={styles.resetBtn}
              onPress={() => {
                setSpotShockPct(0);
                setIvShiftPoints(0);
              }}
            >
              <Text style={[styles.resetBtnText, { color: colors.brand }]}>Reset to Live Market</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginVertical: 6,
    gap: 10,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 8,
  },
  cardTitle: {
    fontSize: 14.5,
    fontWeight: "700",
  },
  cardSubtitle: {
    fontSize: 11,
    marginTop: 1,
  },
  tabSegment: {
    flexDirection: "row",
    borderWidth: 1,
    borderRadius: 8,
    padding: 2,
  },
  tabBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  tabBtnText: {
    fontSize: 11.5,
    fontWeight: "600",
  },
  emptyContainer: {
    padding: 24,
    alignItems: "center",
    gap: 8,
  },
  emptyTitle: {
    fontSize: 14,
    fontWeight: "700",
  },
  emptySubtitle: {
    fontSize: 12,
    textAlign: "center",
    lineHeight: 18,
  },
  metricsRow: {
    flexDirection: "row",
    gap: 6,
  },
  metricTile: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 7,
    gap: 2,
  },
  metricLabel: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  metricValue: {
    fontSize: 12.5,
    fontWeight: "700",
  },
  chartControlBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 4,
  },
  legendContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    fontSize: 11,
    fontWeight: "600",
  },
  currentPnlBadge: {
    fontSize: 11,
    fontWeight: "700",
  },
  zoomControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  zoomBtn: {
    width: 24,
    height: 24,
    borderRadius: 5,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  fitBtn: {
    paddingHorizontal: 6,
    height: 24,
    borderRadius: 5,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  fitBtnText: {
    fontSize: 10,
    fontWeight: "700",
  },
  loadingChartBox: {
    height: 150,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  loadingText: {
    fontSize: 11.5,
  },
  crosshairTooltip: {
    position: "absolute",
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    gap: 2,
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 3,
    minWidth: 125,
  },
  tooltipSpot: {
    fontSize: 11.5,
    fontWeight: "700",
  },
  tooltipMove: {
    fontSize: 10.5,
    fontWeight: "700",
  },
  tooltipPnl: {
    fontSize: 10.5,
    fontWeight: "600",
  },
  axisRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 2,
    marginTop: -2,
  },
  axisText: {
    fontSize: 10.5,
  },
  detailStatsContainer: {
    flexDirection: "row",
    borderTopWidth: 1,
    paddingTop: 8,
    gap: 10,
  },
  detailStatItem: {
    flex: 1,
    gap: 1,
  },
  detailStatLabel: {
    fontSize: 9.5,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  detailStatValue: {
    fontSize: 11.5,
    fontWeight: "700",
  },
  greeksContainer: {
    paddingVertical: 6,
    gap: 8,
  },
  sectionHeading: {
    fontSize: 12,
    fontWeight: "700",
  },
  greeksGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  greekCard: {
    flex: 1,
    minWidth: 100,
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
    gap: 2,
  },
  greekName: {
    fontSize: 10,
    fontWeight: "600",
  },
  greekVal: {
    fontSize: 14,
    fontWeight: "800",
  },
  greekDesc: {
    fontSize: 9.5,
  },
  unavailableBox: {
    padding: 16,
    alignItems: "center",
  },
  unavailableText: {
    fontSize: 12,
    textAlign: "center",
  },
  scenarioToggle: {
    borderTopWidth: 1,
    paddingTop: 8,
    alignItems: "center",
  },
  scenarioToggleText: {
    fontSize: 11.5,
    fontWeight: "700",
  },
  activePill: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  activePillText: {
    fontSize: 9.5,
    fontWeight: "700",
  },
  simulatorBox: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginTop: 4,
  },
  simRow: {
    gap: 4,
  },
  simLabel: {
    fontSize: 11.5,
    fontWeight: "600",
  },
  simValue: {
    fontSize: 11.5,
    fontWeight: "700",
  },
  simButtonsRow: {
    flexDirection: "row",
    gap: 6,
  },
  simPill: {
    flex: 1,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: "center",
  },
  simPillText: {
    fontSize: 10.5,
    fontWeight: "700",
  },
  resetBtn: {
    alignSelf: "center",
    marginTop: 10,
    paddingVertical: 4,
    paddingHorizontal: 12,
  },
  resetBtnText: {
    fontSize: 11,
    fontWeight: "700",
  },
});
