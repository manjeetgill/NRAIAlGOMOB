/**
 * PayoffChart — Sensibull / Kotak Neo / Upstox Style Professional Options Strategy Analyzer.
 *
 * Implements the exact layout requested:
 * 1. Mode Controls: [Chart] [Table] + OI Bar toggle.
 * 2. Visual Color Palette:
 *    - Dark slate-charcoal trading desk background (#10141b).
 *    - Shaded Green Profit zone (above zero) & Shaded Red/Brown Loss zone (below zero).
 *    - Dual Curves:
 *      * 'On expiry': Sharp piecewise line with green in profit / red in loss or cyan.
 *      * 'On target date': Smooth Black-Scholes curve in cyan (#38bdf8).
 * 3. Dynamic Guides & Badges:
 *    - Vertical orange line at LTP with 'LTP XXXXXX' badge pill at the top.
 *    - Interactive dashed white/cyan vertical line at Target Spot with target dot.
 *    - Floating Crosshair / Target Tooltip Card:
 *      'When price is at <targetSpot> <targetPctMove>%'
 *      'Expected P&L on'
 *      'Target: <targetPL>'
 *      'Expiry: <expiryPL>'
 *    - Bottom Projected P&L badge: 'Projected Profit/Loss: +/-₹XXXX'.
 * 4. Interactive What-If Scenario Simulators below chart:
 *    - Target Underlying Spot ([-] [+] stepper, slider, Reset).
 *    - Target Date & Time ([-] [+] stepper, slider, 'XD to expiry', Reset).
 *    - Implied Volatility (IV) Shift (+/- 10%, Reset).
 * 5. Standalone client-side Black-Scholes Mathematical Engine:
 *    - Real-time pricing, theta decay towards expiry, and Greeks calculation.
 * 6. Detailed Strategy Metrics & Greeks view.
 */

import React, { useMemo, useRef, useState, useEffect } from "react";
import {
  ActivityIndicator,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Circle, Defs, LinearGradient, Line, Path, Rect, Stop, Text as SvgText } from "react-native-svg";
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

// ─── Mathematical Engine (Black-Scholes & Calibrated Volatility) ──────────────

function normCdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return 0.5 * (1.0 + sign * y);
}

function bsm(
  spot: number,
  strike: number,
  years: number,
  rate: number,
  dividend: number,
  sigma: number,
  right: "CE" | "PE"
): { price: number; delta: number; theta: number; gamma: number; vega: number } {
  const isCall = right === "CE";
  if (spot <= 0 || strike <= 0 || years <= 0.0001 || sigma <= 0.0001) {
    const intrinsic = isCall ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
    const delta = isCall ? (spot > strike ? 1 : 0) : (spot < strike ? -1 : 0);
    return { price: intrinsic, delta, theta: 0, gamma: 0, vega: 0 };
  }
  const root = Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (rate - dividend + (sigma * sigma) / 2) * years) / (sigma * root);
  const d2 = d1 - sigma * root;
  const df = Math.exp(-rate * years);
  const dq = Math.exp(-dividend * years);
  const density = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
  const sign = isCall ? 1 : -1;
  const price = sign * (spot * dq * normCdf(sign * d1) - strike * df * normCdf(sign * d2));
  const delta = sign * dq * normCdf(sign * d1);
  const gamma = (dq * density) / (spot * sigma * root);
  const vega = (spot * dq * density * root) / 100;
  const theta =
    (-spot * dq * density * sigma / (2 * root) -
      sign * rate * strike * df * normCdf(sign * d2) +
      sign * dividend * spot * dq * normCdf(sign * d1)) /
    365;

  return { price, delta, theta, gamma, vega };
}

function solveImpliedVol(
  price: number,
  spot: number,
  strike: number,
  years: number,
  rate: number,
  dividend: number,
  right: "CE" | "PE"
): number {
  const isCall = right === "CE";
  const intrinsic = isCall ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  if (price <= intrinsic) return 0.14;
  let lower = 0.0001;
  let upper = 4.0;
  for (let i = 0; i < 35; i++) {
    const mid = (lower + upper) / 2;
    const est = bsm(spot, strike, years, rate, dividend, mid, right).price;
    if (est < price) lower = mid;
    else upper = mid;
  }
  return (lower + upper) / 2;
}

function formatAxisPL(val: number): string {
  const abs = Math.abs(val);
  const sign = val < 0 ? "-" : "";
  if (abs >= 10000000) return `${sign}${(abs / 10000000).toFixed(1)}Cr`;
  if (abs >= 100000) return `${sign}${(abs / 100000).toFixed(2)}L`;
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(0)}K`;
  if (abs === 0) return "0";
  return `${sign}${abs.toFixed(0)}`;
}

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

  // Styling theme colors aligned with the user's Analyzer screenshot
  const C = {
    bg: "#10141b",
    card: "#141922",
    cardAlt: "#1b222e",
    border: "#242d3d",
    text: "#e2e8f0",
    textMuted: "#8492a6",
    brand: "#38bdf8",
    brandCyan: "#2dd4bf",
    onExpiryGreen: "#22c55e",
    onExpiryRed: "#ef4444",
    targetDateBlue: "#38bdf8",
    ltpOrange: "#f97316",
    profitArea: "rgba(34, 197, 94, 0.12)",
    lossArea: "rgba(239, 68, 68, 0.10)",
    white: "#ffffff",
  };

  // View state
  const [viewMode, setViewMode] = useState<"chart" | "table" | "greeks">("chart");
  const [showOiBar, setShowOiBar] = useState(false);
  const [zoom, setZoom] = useState(1);

  // Crosshair interactive touch state
  const [touchPx, setTouchPx] = useState<number | null>(null);

  // What-If scenario states
  const [targetSpotMovePct, setTargetSpotMovePct] = useState(0);
  const [targetDaysForward, setTargetDaysForward] = useState(0);
  const [ivShiftPoints, setIvShiftPoints] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  // Build virtual basket for server analysis
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

  const preparedChains = useMemo(() => {
    const answered = chains.filter((c): c is OptionChainData => !!c);
    if (!answered.length) return answered;
    return answered;
  }, [chains]);

  const built = useMemo(
    () => buildAnalysis(virtualBasket, preparedChains),
    [virtualBasket, preparedChains]
  );
  const analysisBody = useMemo(() => {
    if (!built.body) return null;
    return {
      ...built.body,
      spotShockPct: targetSpotMovePct,
      ivShiftPoints,
    };
  }, [built.body, targetSpotMovePct, ivShiftPoints]);

  const analysis = useStrategyAnalysis(analysisBody);
  const margin = usePlanningMargin(built.margin);

  const model = useMemo(
    () => (analysis.data ? curves(analysis.data, 0) : null),
    [analysis.data]
  );
  const held = useMemo(() => heldPayoff(virtualBasket, 0), [virtualBasket]);

  // Underlying current spot
  const currentSpot = Number(analysis.data?.spot ?? spot ?? virtualBasket.spot);

  // Target spot derived from What-If target spot move
  const targetSpot = useMemo(() => {
    if (!currentSpot || currentSpot <= 0) return 0;
    return currentSpot * (1 + targetSpotMovePct / 100);
  }, [currentSpot, targetSpotMovePct]);

  // Max days to expiry calculation across legs
  const maxDaysToExpiry = useMemo(() => {
    const now = new Date();
    let maxDays = 7;
    for (const leg of legs) {
      if (leg.expiry) {
        const parts = leg.expiry.split("-").map(Number);
        if (parts.length === 3) {
          const expDate = new Date(parts[0], parts[1] - 1, parts[2], 15, 30, 0);
          const diffDays = Math.max(0, Math.round((expDate.getTime() - now.getTime()) / (86400 * 1000)));
          if (diffDays > maxDays) maxDays = diffDays;
        }
      }
    }
    return maxDays;
  }, [legs]);

  // Auto-play What-If animation
  useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(() => {
      setTargetSpotMovePct(prev => {
        if (prev >= 5) return -5;
        return Number((prev + 0.5).toFixed(1));
      });
    }, 400);
    return () => clearInterval(interval);
  }, [isPlaying]);

  // Standalone Client-side Black-Scholes Mathematical Engine for Target Date curve
  const localTargetModel = useMemo(() => {
    const spots = model?.spots ?? held?.spots ?? [];
    if (spots.length < 3 || !legs.length) return null;

    const effSpot = currentSpot || (spots[0] + spots[spots.length - 1]) / 2;
    if (effSpot <= 0) return null;

    const rate = 0;
    const dividend = 0;
    const now = new Date();

    const calibratedLegs = legs.map(l => {
      const strike = Number(l.strike);
      const isCall = l.right === "CE";
      const sign = l.side === "BUY" ? 1 : -1;
      const lots = l.lots || 1;
      const lotSize = l.lotSize || 1;
      const qty = sign * lots * lotSize;

      const chain = chains.find(c => c?.expiry === l.expiry);
      const row = chain?.rows.find(r => Number(r.strike) === strike);
      const quote = isCall ? row?.call : row?.put;
      const ltp = Number(quote?.ltp);
      const price =
        Number.isFinite(ltp) && ltp > 0
          ? ltp
          : Number(l.entryPrice) || (quote?.ask ? Number(quote.ask) : quote?.bid ? Number(quote.bid) : 0);

      let totalDays = 7;
      if (l.expiry) {
        const parts = l.expiry.split("-").map(Number);
        if (parts.length === 3) {
          const expDate = new Date(parts[0], parts[1] - 1, parts[2], 15, 30, 0);
          const diffMs = expDate.getTime() - now.getTime();
          totalDays = Math.max(0.1, diffMs / (86400 * 1000));
        }
      }

      // Theta forward decay: advance target days towards expiry
      const remainingDays = Math.max(0.0001, totalDays - targetDaysForward);
      const years = remainingDays / 365;

      const baseIv = quote?.iv ? Number(quote.iv) : solveImpliedVol(price, effSpot, strike, totalDays / 365, rate, dividend, l.right);
      const effectiveIv = Math.max(0.001, baseIv + ivShiftPoints / 100);

      return {
        strike,
        right: l.right,
        qty,
        basis: price,
        years,
        iv: effectiveIv,
      };
    });

    const values = spots.map(s => {
      return calibratedLegs.reduce((sum, leg) => {
        const est = bsm(s, leg.strike, leg.years, rate, dividend, leg.iv, leg.right).price;
        return sum + leg.qty * (est - leg.basis);
      }, 0);
    });

    let netDelta = 0;
    let netTheta = 0;
    let netGamma = 0;
    let netVega = 0;
    let totalIv = 0;

    for (const leg of calibratedLegs) {
      const res = bsm(effSpot, leg.strike, leg.years, rate, dividend, leg.iv, leg.right);
      netDelta += leg.qty * res.delta;
      netTheta += leg.qty * res.theta;
      netGamma += leg.qty * res.gamma;
      netVega += leg.qty * res.vega;
      totalIv += leg.iv;
    }

    const atCurrentSpot = valueAt(spots, values, effSpot);
    const atTargetSpot = valueAt(spots, values, targetSpot || effSpot);

    return {
      spots,
      values,
      atCurrentSpot,
      atTargetSpot,
      greeks: {
        delta: netDelta,
        theta: netTheta,
        gamma: netGamma,
        vega: netVega,
        ivPct: (totalIv / (calibratedLegs.length || 1)) * 100,
      },
    };
  }, [model?.spots, held?.spots, legs, chains, currentSpot, targetSpot, targetDaysForward, ivShiftPoints]);

  const until = useMemo(() => {
    const dates = [...new Set(virtualBasket.payoffLegs.map(l => l.expiry).filter(Boolean))];
    return dates.join(" & ") || null;
  }, [virtualBasket]);

  const figures = useMemo(
    () => (analysis.data ? payoffFigures(analysis.data, until, 0) : null),
    [analysis.data, until]
  );

  // SVG Chart Geometry with exact Sensibull / Analyzer proportions
  const chart = useMemo(() => {
    const modelSpots = model?.spots ?? [];
    const heldSpots = held?.spots ?? [];
    const localSpots = localTargetModel?.spots ?? [];
    const xs =
      modelSpots.length >= heldSpots.length && modelSpots.length >= localSpots.length
        ? modelSpots
        : heldSpots.length >= localSpots.length
        ? heldSpots
        : localSpots;

    const resample = (fromSpots: number[] | undefined, fromValues: number[] | null | undefined) => {
      if (!fromValues || !fromSpots || fromSpots.length !== fromValues.length) return null;
      if (fromSpots.length === xs.length && fromSpots.every((s, i) => s === xs[i])) return fromValues;
      return xs.map(x => valueAt(fromSpots, fromValues, x) ?? 0);
    };

    const expiryLine = model?.expiry
      ? resample(modelSpots, model.expiry)
      : resample(heldSpots, held?.values);

    const targetLine = targetDaysForward === 0 && model?.today
      ? resample(modelSpots, model.today)
      : localTargetModel?.values
      ? resample(localTargetModel.spots, localTargetModel.values)
      : null;

    if (xs.length < 3 || (!expiryLine && !targetLine)) return null;

    const lines = [expiryLine, targetLine].filter((l): l is number[] => !!l);
    const w = Math.round(screenWidth - 32);
    const h = 260; // Professional height matching Analyzer screenshot
    const padLeft = 48; // Room for Y-axis profit/loss labels (e.g. 2.00L, 0, -2.00L)
    const padRight = 16;
    const padTop = 26; // Room for LTP pill tag
    const padBottom = 26; // Room for X-axis spot strikes

    const fullLo = xs[0];
    const fullHi = xs[xs.length - 1];
    const center = (fullLo + fullHi) / 2;
    const halfRange = (fullHi - fullLo) / 2 / zoom;
    const lo = center - halfRange;
    const hi = center + halfRange;

    let yMin = 0;
    let yMax = 0;
    for (const arr of lines) {
      for (let i = 0; i < xs.length; i++) {
        if (xs[i] >= lo && xs[i] <= hi) {
          const y = arr[i];
          if (y < yMin) yMin = y;
          if (y > yMax) yMax = y;
        }
      }
    }

    const ySpan = yMax - yMin;
    const yPad = Math.max(ySpan * 0.15, 60);
    const yLo = ySpan < 0.005 ? yMin - 150 : yMin - yPad;
    const yHi = ySpan < 0.005 ? yMax + 150 : yMax + yPad;

    const px = (x: number) => padLeft + ((x - lo) / (hi - lo || 1)) * (w - padLeft - padRight);
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

    const zeroY = py(0);

    // Build shaded green profit area path (above zero) & shaded red loss area path (below zero)
    const makeShadedPath = (values: number[], spotsArr: number[], zone: "profit" | "loss") => {
      const len = spotsArr.length;
      if (len < 2) return "";
      let d = `M${px(spotsArr[0]).toFixed(1)},${zeroY.toFixed(1)}`;
      for (let i = 0; i < len; i++) {
        const x = px(spotsArr[i]);
        const yVal = values[i];
        const clampedY = zone === "profit" ? Math.min(zeroY, py(yVal)) : Math.max(zeroY, py(yVal));
        d += ` L${x.toFixed(1)},${clampedY.toFixed(1)}`;
      }
      d += ` L${px(spotsArr[len - 1]).toFixed(1)},${zeroY.toFixed(1)} Z`;
      return d;
    };

    // Calculate Y-axis tick values (5 nicely spaced ticks)
    const yTicks = [yHi * 0.85, yHi * 0.45, 0, yLo * 0.45, yLo * 0.85];

    // Calculate X-axis spot strikes (6 equidistant points across screen)
    const xTicks = [0, 0.2, 0.4, 0.6, 0.8, 1.0].map(fraction => lo + fraction * (hi - lo));

    return {
      w,
      h,
      padLeft,
      padRight,
      padTop,
      padBottom,
      px,
      py,
      zero: zeroY,
      lo,
      hi,
      yLo,
      yHi,
      yTicks,
      xTicks,
      xs,
      expiryValues: expiryLine,
      targetValues: targetLine,
      expiryPath: expiryLine ? makePath(expiryLine, xs) : null,
      targetPath: targetLine ? makePath(targetLine, xs) : null,
      profitAreaPath: expiryLine ? makeShadedPath(expiryLine, xs, "profit") : null,
      lossAreaPath: expiryLine ? makeShadedPath(expiryLine, xs, "loss") : null,
    };
  }, [model, held, localTargetModel, screenWidth, zoom, targetDaysForward]);

  // Spot presence on chart
  const spotOnChart =
    !!chart && Number.isFinite(currentSpot) && currentSpot > 0 && currentSpot >= chart.lo && currentSpot <= chart.hi;

  const targetSpotOnChart =
    !!chart && Number.isFinite(targetSpot) && targetSpot > 0 && targetSpot >= chart.lo && targetSpot <= chart.hi;

  // Active target or touch spot coordinates
  const activeSpot =
    touchPx !== null && chart
      ? chart.lo + ((touchPx - chart.padLeft) / (chart.w - chart.padLeft - chart.padRight)) * (chart.hi - chart.lo)
      : targetSpot || currentSpot;

  const activeSpotPctMove = currentSpot > 0 ? ((activeSpot - currentSpot) / currentSpot) * 100 : 0;

  const activeExpiryPL =
    chart && chart.expiryValues && chart.xs ? valueAt(chart.xs, chart.expiryValues, activeSpot) : null;

  const activeTargetPL =
    chart && chart.targetValues && chart.xs ? valueAt(chart.xs, chart.targetValues, activeSpot) : null;

  // Touch & Crosshair gestures
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

  // Breakevens & Margin displays
  const breakEvens = useMemo(() => {
    if (figures?.breakEvens && figures.breakEvens !== "None inside the range the curve was drawn over") {
      return figures.breakEvens;
    }
    if (held?.breakEvens && held.breakEvens.length > 0) {
      return held.breakEvens.map(v => formatNumber(v, 2)).join(" · ");
    }
    return "None in range";
  }, [figures?.breakEvens, held?.breakEvens]);

  const marginDisplay = useMemo(() => {
    if (!built.margin) return "—";
    if (margin.isError) return "Unavailable";
    if (margin.isLoading) return "Estimating…";
    if (margin.data?.available && margin.data.amount) {
      return rupees(margin.data.amount, false) ?? "—";
    }
    return margin.data?.reason || "—";
  }, [built.margin, margin]);

  // Projected P&L badge value
  const projectedPL = activeTargetPL ?? activeExpiryPL ?? localTargetModel?.atTargetSpot ?? 0;

  return (
    <View style={[styles.card, { backgroundColor: C.bg, borderColor: C.border }]}>
      {/* ─── 1. Subheader: Leg Count & Current Net Value ──────────────── */}
      <View style={styles.topInfoRow}>
        <Text style={[styles.legsSelectedText, { color: C.textMuted }]}>
          {`${legs.length}/${legs.length} legs selected`}
        </Text>
        <Text
          style={[
            styles.totalNetText,
            { color: (localTargetModel?.atCurrentSpot ?? 0) >= 0 ? C.onExpiryGreen : C.onExpiryRed },
          ]}
        >
          {rupees(localTargetModel?.atCurrentSpot ?? 0, true)}
        </Text>
      </View>

      {/* ─── 2. Mode Selector: Chart | Table | Greeks & OI Bar Toggle ─── */}
      <View style={styles.controlsBar}>
        <View style={styles.toggleSegment}>
          <TouchableOpacity
            style={[styles.toggleBtn, viewMode === "chart" && styles.toggleBtnActive]}
            onPress={() => setViewMode("chart")}
          >
            <Text style={[styles.toggleBtnText, { color: viewMode === "chart" ? C.white : C.textMuted }]}>
              Chart
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toggleBtn, viewMode === "table" && styles.toggleBtnActive]}
            onPress={() => setViewMode("table")}
          >
            <Text style={[styles.toggleBtnText, { color: viewMode === "table" ? C.white : C.textMuted }]}>
              Table
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toggleBtn, viewMode === "greeks" && styles.toggleBtnActive]}
            onPress={() => setViewMode("greeks")}
          >
            <Text style={[styles.toggleBtnText, { color: viewMode === "greeks" ? C.white : C.textMuted }]}>
              Greeks
            </Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={styles.oiBarCheckboxRow}
          onPress={() => setShowOiBar(prev => !prev)}
          activeOpacity={0.7}
        >
          <Text style={[styles.oiBarLabel, { color: C.textMuted }]}>OI Bar</Text>
          <View style={[styles.checkboxBox, { borderColor: showOiBar ? C.brand : C.border }]}>
            {showOiBar && <Ionicons name="checkmark" size={12} color={C.brand} />}
          </View>
        </TouchableOpacity>
      </View>

      {/* ─── 3. Professional Legend Matching Screenshot ─────────────── */}
      {viewMode === "chart" && (
        <View style={styles.legendRow}>
          <View style={styles.legendItem}>
            <View style={[styles.legendDash, { backgroundColor: C.onExpiryRed }]} />
            <Text style={[styles.legendText, { color: C.textMuted }]}>On expiry</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendLine, { backgroundColor: C.targetDateBlue }]} />
            <Text style={[styles.legendText, { color: C.textMuted }]}>
              {targetDaysForward === 0 ? "On target date" : `On target date (+${targetDaysForward}D)`}
            </Text>
          </View>
        </View>
      )}

      {/* ─── 4. Main Analyzer Chart View ─────────────────────────────── */}
      {viewMode === "chart" && (
        <View style={styles.chartWrapper}>
          {!chart ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator color={C.brand} />
              <Text style={[styles.loadingText, { color: C.textMuted }]}>
                Calculating strategy curves…
              </Text>
            </View>
          ) : (
            <View {...panResponder.panHandlers} style={{ position: "relative" }}>
              <Svg width={chart.w} height={chart.h}>
                <Defs>
                  <LinearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
                    <Stop offset="0" stopColor="#22c55e" stopOpacity="0.22" />
                    <Stop offset="1" stopColor="#22c55e" stopOpacity="0.02" />
                  </LinearGradient>
                  <LinearGradient id="lossGrad" x1="0" y1="0" x2="0" y2="1">
                    <Stop offset="0" stopColor="#ef4444" stopOpacity="0.02" />
                    <Stop offset="1" stopColor="#ef4444" stopOpacity="0.20" />
                  </LinearGradient>
                </Defs>

                {/* Shaded Green Profit zone (above zero) & Shaded Red Loss zone (below zero) */}
                {chart.profitAreaPath && (
                  <Path d={chart.profitAreaPath} fill="url(#profitGrad)" />
                )}
                {chart.lossAreaPath && (
                  <Path d={chart.lossAreaPath} fill="url(#lossGrad)" />
                )}

                {/* Zero Reference P&L Axis */}
                <Line
                  x1={chart.padLeft}
                  y1={chart.zero}
                  x2={chart.w - chart.padRight}
                  y2={chart.zero}
                  stroke={C.border}
                  strokeWidth={1.2}
                  strokeDasharray="4 3"
                />

                {/* Y-Axis Grid Lines & Tick Labels (Profit/Loss: 2.00L, 0, -2.00L, etc.) */}
                {chart.yTicks.map((yVal, idx) => {
                  const yPos = chart.py(yVal);
                  if (yPos < chart.padTop || yPos > chart.h - chart.padBottom) return null;
                  return (
                    <React.Fragment key={`ytick-${idx}`}>
                      <Line
                        x1={chart.padLeft}
                        y1={yPos}
                        x2={chart.w - chart.padRight}
                        y2={yPos}
                        stroke={C.border}
                        strokeWidth={0.6}
                        strokeDasharray="2 4"
                        opacity={0.4}
                      />
                      <SvgText
                        x={chart.padLeft - 6}
                        y={yPos + 4}
                        fontSize={10}
                        fill={C.textMuted}
                        textAnchor="end"
                      >
                        {formatAxisPL(yVal)}
                      </SvgText>
                    </React.Fragment>
                  );
                })}

                {/* X-Axis Grid Lines & Strike Labels (24000, 63000, 102000, 141000...) */}
                {chart.xTicks.map((xVal, idx) => {
                  const xPos = chart.px(xVal);
                  return (
                    <React.Fragment key={`xtick-${idx}`}>
                      <SvgText
                        x={xPos}
                        y={chart.h - 6}
                        fontSize={9.5}
                        fill={C.textMuted}
                        textAnchor="middle"
                      >
                        {formatNumber(xVal, 0)}
                      </SvgText>
                    </React.Fragment>
                  );
                })}

                {/* On Expiry Curve (Piecewise: Green in profit / Red in loss or Cyan) */}
                {chart.expiryPath && (
                  <Path
                    d={chart.expiryPath}
                    stroke={C.onExpiryGreen}
                    strokeWidth={2.4}
                    fill="none"
                  />
                )}

                {/* On Target Date Curve (Cyan/Blue Smooth Black-Scholes curve) */}
                {chart.targetPath && (
                  <Path
                    d={chart.targetPath}
                    stroke={C.targetDateBlue}
                    strokeWidth={2.0}
                    fill="none"
                    opacity={0.95}
                  />
                )}

                {/* Vertical Orange Line at Current Market Price / LTP with LTP Pill Tag */}
                {spotOnChart && (
                  <>
                    <Line
                      x1={chart.px(currentSpot)}
                      y1={chart.padTop + 14}
                      x2={chart.px(currentSpot)}
                      y2={chart.h - chart.padBottom}
                      stroke={C.ltpOrange}
                      strokeWidth={1.4}
                      opacity={0.9}
                    />
                    {/* LTP Pill Badge at top of orange line */}
                    <Rect
                      x={chart.px(currentSpot) - 44}
                      y={chart.padTop - 12}
                      width={88}
                      height={20}
                      rx={4}
                      fill="#1e2533"
                      stroke={C.border}
                      strokeWidth={1}
                    />
                    <SvgText
                      x={chart.px(currentSpot)}
                      y={chart.padTop + 2}
                      fontSize={10}
                      fontWeight="bold"
                      fill={C.white}
                      textAnchor="middle"
                    >
                      {`LTP ${formatNumber(currentSpot, 0)}`}
                    </SvgText>
                  </>
                )}

                {/* Vertical Dashed White/Cyan Line at Target Spot with Target Dot */}
                {targetSpotOnChart && (
                  <>
                    <Line
                      x1={chart.px(activeSpot)}
                      y1={chart.padTop}
                      x2={chart.px(activeSpot)}
                      y2={chart.h - chart.padBottom}
                      stroke={C.white}
                      strokeWidth={1.2}
                      strokeDasharray="4 3"
                      opacity={0.7}
                    />
                    {activeTargetPL !== null && (
                      <Circle
                        cx={chart.px(activeSpot)}
                        cy={chart.py(activeTargetPL)}
                        r={5.5}
                        fill={C.brandCyan}
                        stroke={C.white}
                        strokeWidth={1.5}
                      />
                    )}
                  </>
                )}
              </Svg>

              {/* Y-Axis Label: 'Profit/Loss' rotated on left */}
              <View style={styles.yAxisLabelBox}>
                <Text style={styles.yAxisLabelText}>Profit/Loss</Text>
              </View>

              {/* Floating Target Tooltip Card matching Analyzer Screenshot */}
              <View style={[styles.targetTooltipCard, { backgroundColor: "#1a212d", borderColor: C.border }]}>
                <View style={styles.tooltipHeaderRow}>
                  <Text style={[styles.tooltipTitle, { color: C.textMuted }]}>When price is at</Text>
                  <Text style={[styles.tooltipSpot, { color: C.white }]}>
                    {`${formatNumber(activeSpot, 0)} `}
                    <Text style={{ color: activeSpotPctMove >= 0 ? C.onExpiryGreen : C.onExpiryRed }}>
                      {`${activeSpotPctMove >= 0 ? "+" : ""}${activeSpotPctMove.toFixed(2)}%`}
                    </Text>
                  </Text>
                </View>
                <Text style={[styles.tooltipSection, { color: C.textMuted }]}>Expected P&L on</Text>
                <View style={styles.tooltipPnlRow}>
                  <Text style={[styles.tooltipPnlLabel, { color: C.textMuted }]}>Target</Text>
                  <Text
                    style={[
                      styles.tooltipPnlVal,
                      { color: (activeTargetPL ?? 0) >= 0 ? C.onExpiryGreen : C.onExpiryRed },
                    ]}
                  >
                    {formatAxisPL(activeTargetPL ?? 0)}
                  </Text>
                </View>
                <View style={styles.tooltipPnlRow}>
                  <Text style={[styles.tooltipPnlLabel, { color: C.textMuted }]}>Expiry</Text>
                  <Text
                    style={[
                      styles.tooltipPnlVal,
                      { color: (activeExpiryPL ?? 0) >= 0 ? C.onExpiryGreen : C.onExpiryRed },
                    ]}
                  >
                    {formatAxisPL(activeExpiryPL ?? 0)}
                  </Text>
                </View>
              </View>

              {/* Fullscreen Button ⛶ on bottom right */}
              <TouchableOpacity
                style={styles.fullscreenBtn}
                onPress={() => setZoom(z => (z === 1 ? 1.5 : 1))}
              >
                <Ionicons name="scan-outline" size={16} color={C.brand} />
              </TouchableOpacity>
            </View>
          )}

          {/* Bottom Projected P&L Pill below chart */}
          <View style={styles.projectedPnlContainer}>
            <View style={[styles.projectedPnlBadge, { backgroundColor: "#18202c", borderColor: C.border }]}>
              <Text style={[styles.projectedPnlLabel, { color: C.textMuted }]}>
                {projectedPL >= 0 ? "Projected Profit " : "Projected Loss "}
                <Text style={{ color: projectedPL >= 0 ? C.onExpiryGreen : C.onExpiryRed, fontWeight: "bold" }}>
                  {rupees(projectedPL, true)}
                </Text>
              </Text>
            </View>
          </View>
        </View>
      )}

      {/* ─── 5. Sensibull / Kotak Neo What-If Simulators (Matching Screenshot) ─ */}
      <View style={styles.simulatorsSection}>
        {/* Simulator 1: Underlying Spot Target */}
        <View style={styles.simulatorRow}>
          <View style={styles.simHeaderRow}>
            <Text style={[styles.simTitle, { color: C.white }]}>{`${underlying} target`}</Text>
            {targetSpotMovePct !== 0 && (
              <TouchableOpacity onPress={() => setTargetSpotMovePct(0)}>
                <Text style={[styles.simResetText, { color: C.brand }]}>RESET</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Stepper Box: [-]   1,38,674.00   [+] */}
          <View style={[styles.stepperBox, { backgroundColor: "#161c26", borderColor: C.border }]}>
            <TouchableOpacity
              style={styles.stepperBtn}
              onPress={() => setTargetSpotMovePct(prev => Number((prev - 0.5).toFixed(1)))}
            >
              <Ionicons name="remove" size={18} color={C.brand} />
            </TouchableOpacity>

            <View style={{ alignItems: "center" }}>
              <Text style={[styles.stepperValueText, { color: C.white }]}>
                {formatNumber(targetSpot, 2)}
              </Text>
              <Text style={{ fontSize: 10, color: targetSpotMovePct >= 0 ? C.onExpiryGreen : C.onExpiryRed }}>
                {`${targetSpotMovePct >= 0 ? "+" : ""}${targetSpotMovePct.toFixed(1)}%`}
              </Text>
            </View>

            <TouchableOpacity
              style={styles.stepperBtn}
              onPress={() => setTargetSpotMovePct(prev => Number((prev + 0.5).toFixed(1)))}
            >
              <Ionicons name="add" size={18} color={C.brand} />
            </TouchableOpacity>
          </View>

          {/* Interactive Spot Move Slider & Play/Pause Button */}
          <View style={styles.sliderControlRow}>
            <TouchableOpacity
              style={[styles.playPauseBtn, { backgroundColor: C.brand }]}
              onPress={() => setIsPlaying(p => !p)}
            >
              <Ionicons name={isPlaying ? "pause" : "play"} size={14} color="#0f172a" />
            </TouchableOpacity>

            <View style={styles.spotQuickPills}>
              {[-3, -2, -1, 0, 1, 2, 3].map(pct => (
                <TouchableOpacity
                  key={`spot-${pct}`}
                  style={[
                    styles.quickPill,
                    targetSpotMovePct === pct
                      ? { backgroundColor: C.brand, borderColor: C.brand }
                      : { backgroundColor: "#1a2230", borderColor: C.border },
                  ]}
                  onPress={() => setTargetSpotMovePct(pct)}
                >
                  <Text
                    style={[
                      styles.quickPillText,
                      { color: targetSpotMovePct === pct ? "#0f172a" : C.textMuted },
                    ]}
                  >
                    {pct === 0 ? "ATM" : `${pct > 0 ? "+" : ""}${pct}%`}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>

        {/* Simulator 2: Target Date & Time (XD to expiry) */}
        <View style={[styles.simulatorRow, { marginTop: 14 }]}>
          <View style={styles.simHeaderRow}>
            <Text style={[styles.simTitle, { color: C.white }]}>
              {`Target date & time `}
              <Text style={{ fontSize: 12, color: C.textMuted }}>
                {`${Math.max(0, maxDaysToExpiry - targetDaysForward)}D to expiry`}
              </Text>
            </Text>
            {targetDaysForward !== 0 && (
              <TouchableOpacity onPress={() => setTargetDaysForward(0)}>
                <Text style={[styles.simResetText, { color: C.brand }]}>RESET</Text>
              </TouchableOpacity>
            )}
          </View>

          <View style={[styles.stepperBox, { backgroundColor: "#161c26", borderColor: C.border }]}>
            <TouchableOpacity
              style={styles.stepperBtn}
              onPress={() => setTargetDaysForward(prev => Math.max(0, prev - 1))}
            >
              <Ionicons name="remove" size={18} color={C.brand} />
            </TouchableOpacity>

            <View style={{ alignItems: "center" }}>
              <Text style={[styles.stepperValueText, { color: C.white }]}>
                {targetDaysForward === 0 ? "Today (T+0)" : `+${targetDaysForward} Days Forward`}
              </Text>
              <Text style={{ fontSize: 10, color: C.textMuted }}>
                {targetDaysForward >= maxDaysToExpiry ? "At Expiry" : "Theta Decay Projected"}
              </Text>
            </View>

            <TouchableOpacity
              style={styles.stepperBtn}
              onPress={() => setTargetDaysForward(prev => Math.min(maxDaysToExpiry, prev + 1))}
            >
              <Ionicons name="add" size={18} color={C.brand} />
            </TouchableOpacity>
          </View>

          {/* Quick Date Stepper Pills */}
          <View style={styles.dateQuickPills}>
            {[0, 1, 2, 3, 5, 7].map(days => {
              if (days > maxDaysToExpiry && days !== 0) return null;
              return (
                <TouchableOpacity
                  key={`day-${days}`}
                  style={[
                    styles.quickPill,
                    targetDaysForward === days
                      ? { backgroundColor: C.brand, borderColor: C.brand }
                      : { backgroundColor: "#1a2230", borderColor: C.border },
                  ]}
                  onPress={() => setTargetDaysForward(days)}
                >
                  <Text
                    style={[
                      styles.quickPillText,
                      { color: targetDaysForward === days ? "#0f172a" : C.textMuted },
                    ]}
                  >
                    {days === 0 ? "Today" : `+${days}D`}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Simulator 3: Implied Volatility (IV) Shift */}
        <View style={[styles.simulatorRow, { marginTop: 14 }]}>
          <View style={styles.simHeaderRow}>
            <Text style={[styles.simTitle, { color: C.white }]}>IV Shift</Text>
            {ivShiftPoints !== 0 && (
              <TouchableOpacity onPress={() => setIvShiftPoints(0)}>
                <Text style={[styles.simResetText, { color: C.brand }]}>RESET</Text>
              </TouchableOpacity>
            )}
          </View>
          <View style={styles.ivQuickPills}>
            {[-5, -2, 0, 2, 5].map(pts => (
              <TouchableOpacity
                key={`iv-${pts}`}
                style={[
                  styles.quickPill,
                  ivShiftPoints === pts
                    ? { backgroundColor: "#f59e0b", borderColor: "#f59e0b" }
                    : { backgroundColor: "#1a2230", borderColor: C.border },
                ]}
                onPress={() => setIvShiftPoints(pts)}
              >
                <Text
                  style={[
                    styles.quickPillText,
                    { color: ivShiftPoints === pts ? "#0f172a" : C.textMuted },
                  ]}
                >
                  {pts === 0 ? "0%" : `${pts > 0 ? "+" : ""}${pts}%`}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>

      {/* ─── 6. Key Strategy Metrics & Breakevens Bar ──────────────────── */}
      <View style={[styles.metricsGrid, { borderTopColor: C.border }]}>
        <View style={styles.metricItem}>
          <Text style={[styles.metricLabel, { color: C.textMuted }]}>MAX PROFIT</Text>
          <Text style={[styles.metricValue, { color: C.onExpiryGreen }]}>
            {figures?.maxProfit ?? "Unlimited"}
          </Text>
        </View>
        <View style={styles.metricItem}>
          <Text style={[styles.metricLabel, { color: C.textMuted }]}>MAX LOSS</Text>
          <Text style={[styles.metricValue, { color: C.onExpiryRed }]}>
            {figures?.maxLoss ?? rupees(held?.netDebit) ?? "Unlimited"}
          </Text>
        </View>
        <View style={styles.metricItem}>
          <Text style={[styles.metricLabel, { color: C.textMuted }]}>BREAKEVENS</Text>
          <Text style={[styles.metricValue, { color: C.white }]} numberOfLines={1}>
            {breakEvens}
          </Text>
        </View>
        <View style={styles.metricItem}>
          <Text style={[styles.metricLabel, { color: C.textMuted }]}>EST. MARGIN</Text>
          <Text style={[styles.metricValue, { color: C.white }]} numberOfLines={1}>
            {marginDisplay}
          </Text>
        </View>
      </View>

      {/* ─── 7. Greeks View (when 'Greeks' tab is selected) ──────────── */}
      {viewMode === "greeks" && (
        <View style={styles.greeksContainer}>
          <Text style={[styles.sectionHeading, { color: C.white }]}>Combined Strategy Greeks</Text>
          <View style={styles.greeksGrid}>
            <View style={[styles.greekCard, { backgroundColor: "#161c26", borderColor: C.border }]}>
              <Text style={[styles.greekName, { color: C.textMuted }]}>Delta (Δ)</Text>
              <Text
                style={[
                  styles.greekVal,
                  { color: (localTargetModel?.greeks?.delta ?? 0) >= 0 ? C.onExpiryGreen : C.onExpiryRed },
                ]}
              >
                {(localTargetModel?.greeks?.delta ?? 0).toFixed(2)}
              </Text>
              <Text style={[styles.greekDesc, { color: C.textMuted }]}>Per 1 pt spot move</Text>
            </View>

            <View style={[styles.greekCard, { backgroundColor: "#161c26", borderColor: C.border }]}>
              <Text style={[styles.greekName, { color: C.textMuted }]}>Theta (Θ)</Text>
              <Text
                style={[
                  styles.greekVal,
                  { color: (localTargetModel?.greeks?.theta ?? 0) >= 0 ? C.onExpiryGreen : C.onExpiryRed },
                ]}
              >
                {`${(localTargetModel?.greeks?.theta ?? 0).toFixed(2)}/day`}
              </Text>
              <Text style={[styles.greekDesc, { color: C.textMuted }]}>Daily decay</Text>
            </View>

            <View style={[styles.greekCard, { backgroundColor: "#161c26", borderColor: C.border }]}>
              <Text style={[styles.greekName, { color: C.textMuted }]}>Gamma (Γ)</Text>
              <Text style={[styles.greekVal, { color: C.white }]}>
                {(localTargetModel?.greeks?.gamma ?? 0).toFixed(4)}
              </Text>
              <Text style={[styles.greekDesc, { color: C.textMuted }]}>Delta acceleration</Text>
            </View>

            <View style={[styles.greekCard, { backgroundColor: "#161c26", borderColor: C.border }]}>
              <Text style={[styles.greekName, { color: C.textMuted }]}>Vega (ν)</Text>
              <Text
                style={[
                  styles.greekVal,
                  { color: (localTargetModel?.greeks?.vega ?? 0) >= 0 ? C.onExpiryGreen : C.onExpiryRed },
                ]}
              >
                {(localTargetModel?.greeks?.vega ?? 0).toFixed(2)}
              </Text>
              <Text style={[styles.greekDesc, { color: C.textMuted }]}>Per 1% IV shift</Text>
            </View>
          </View>
        </View>
      )}

      {/* ─── 8. Table View (when 'Table' tab is selected) ─────────────── */}
      {viewMode === "table" && (
        <View style={styles.tableContainer}>
          <Text style={[styles.sectionHeading, { color: C.white }]}>Strategy Legs</Text>
          {legs.map((leg, index) => (
            <View
              key={`leg-row-${index}`}
              style={[styles.tableRow, { backgroundColor: "#161c26", borderColor: C.border }]}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontWeight: "bold", color: C.white }}>
                  {`${leg.side} ${leg.strike} ${leg.right}`}
                </Text>
                <Text style={{ fontSize: 11, color: C.textMuted }}>{leg.expiry}</Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={{ fontSize: 13, fontWeight: "600", color: C.white }}>
                  {`${leg.lots} lot (${leg.lots * leg.lotSize} qty)`}
                </Text>
                <Text style={{ fontSize: 11, color: C.brand }}>
                  {leg.entryPrice ? `₹${leg.entryPrice.toFixed(2)}` : "Market"}
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginVertical: 8,
    gap: 10,
    overflow: "hidden",
  },
  topInfoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  legsSelectedText: {
    fontSize: 13,
    fontWeight: "500",
  },
  totalNetText: {
    fontSize: 14,
    fontWeight: "bold",
  },
  controlsBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginVertical: 4,
  },
  toggleSegment: {
    flexDirection: "row",
    backgroundColor: "#161c26",
    borderRadius: 8,
    padding: 2,
    borderWidth: 1,
    borderColor: "#242d3d",
  },
  toggleBtn: {
    paddingVertical: 5,
    paddingHorizontal: 14,
    borderRadius: 6,
  },
  toggleBtnActive: {
    backgroundColor: "#242d3d",
  },
  toggleBtnText: {
    fontSize: 12,
    fontWeight: "600",
  },
  oiBarCheckboxRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  oiBarLabel: {
    fontSize: 12,
    fontWeight: "500",
  },
  checkboxBox: {
    width: 18,
    height: 18,
    borderWidth: 1.5,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  legendRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 20,
    marginTop: 2,
    marginBottom: 4,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  legendDash: {
    width: 14,
    height: 3,
    borderRadius: 1.5,
  },
  legendLine: {
    width: 16,
    height: 2.5,
    borderRadius: 1,
  },
  legendText: {
    fontSize: 11.5,
    fontWeight: "500",
  },
  chartWrapper: {
    position: "relative",
    marginTop: 4,
  },
  loadingBox: {
    height: 220,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  loadingText: {
    fontSize: 12,
  },
  yAxisLabelBox: {
    position: "absolute",
    left: 2,
    top: 110,
    transform: [{ rotate: "-90deg" }],
  },
  yAxisLabelText: {
    fontSize: 10,
    color: "#8492a6",
    fontWeight: "500",
  },
  targetTooltipCard: {
    position: "absolute",
    left: 48,
    bottom: 50,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    minWidth: 165,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 4,
    elevation: 4,
  },
  tooltipHeaderRow: {
    flexDirection: "column",
    marginBottom: 4,
  },
  tooltipTitle: {
    fontSize: 10,
  },
  tooltipSpot: {
    fontSize: 11.5,
    fontWeight: "bold",
  },
  tooltipSection: {
    fontSize: 9.5,
    marginTop: 2,
  },
  tooltipPnlRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 2,
  },
  tooltipPnlLabel: {
    fontSize: 11,
  },
  tooltipPnlVal: {
    fontSize: 11,
    fontWeight: "bold",
  },
  fullscreenBtn: {
    position: "absolute",
    right: 8,
    bottom: 34,
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: "#1a2230",
    borderWidth: 1,
    borderColor: "#242d3d",
    alignItems: "center",
    justifyContent: "center",
  },
  projectedPnlContainer: {
    alignItems: "center",
    marginTop: 8,
  },
  projectedPnlBadge: {
    paddingVertical: 5,
    paddingHorizontal: 14,
    borderRadius: 6,
    borderWidth: 1,
  },
  projectedPnlLabel: {
    fontSize: 11.5,
  },
  simulatorsSection: {
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: "#242d3d",
    paddingTop: 12,
  },
  simulatorRow: {
    gap: 6,
  },
  simHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  simTitle: {
    fontSize: 13,
    fontWeight: "bold",
  },
  simResetText: {
    fontSize: 11,
    fontWeight: "bold",
  },
  stepperBox: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  stepperBtn: {
    width: 32,
    height: 32,
    borderRadius: 6,
    backgroundColor: "#1f2937",
    alignItems: "center",
    justifyContent: "center",
  },
  stepperValueText: {
    fontSize: 15,
    fontWeight: "bold",
  },
  sliderControlRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 6,
  },
  playPauseBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  spotQuickPills: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  dateQuickPills: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
  },
  ivQuickPills: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
  },
  quickPill: {
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: 6,
    borderWidth: 1,
  },
  quickPillText: {
    fontSize: 11,
    fontWeight: "600",
  },
  metricsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    borderTopWidth: 1,
    paddingTop: 12,
    marginTop: 6,
  },
  metricItem: {
    width: "50%",
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  metricLabel: {
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  metricValue: {
    fontSize: 13,
    fontWeight: "bold",
    marginTop: 2,
  },
  greeksContainer: {
    marginTop: 10,
    gap: 8,
  },
  sectionHeading: {
    fontSize: 13,
    fontWeight: "bold",
    marginBottom: 4,
  },
  greeksGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  greekCard: {
    width: "48%",
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  greekName: {
    fontSize: 11,
    fontWeight: "600",
  },
  greekVal: {
    fontSize: 16,
    fontWeight: "bold",
    marginVertical: 2,
  },
  greekDesc: {
    fontSize: 10,
  },
  tableContainer: {
    marginTop: 10,
    gap: 6,
  },
  tableRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
});
