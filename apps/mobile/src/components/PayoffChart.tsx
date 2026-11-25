/**
 * PayoffChart — the payoff graph of a staged or held option position.
 *
 * Two curves over one underlying-price axis:
 *   "On expiry"      intrinsic at settlement less the premiums paid, the phone's own arithmetic over the
 *                    contracts, so it is on screen before any read answers and needs no model.
 *   "On target date" the same position valued on a date the trader picks, with the time value still on it.
 *                    Priced here with Black-Scholes, because the server's model answers only for today.
 *
 * Everything under the graph is a what-if: the target price, the target date, an IV shift. None of them
 * re-prices on the server — a drag would otherwise fire one POST per step — they move the phone-side curve
 * only, and the source line says which curve came from where.
 *
 * `booked` is the money a held basket already made on the units it exited. The curves price only what is
 * still open, so without the shift the graph and the Total P&L printed above it are two different answers
 * to the same question.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Circle, Line, Path, Rect } from "react-native-svg";
import { Ionicons } from "@expo/vector-icons";
import {
  blackScholes,
  buildAnalysis,
  curves,
  heldPayoff,
  impliedVol,
  payoffFigures,
  priceProvenance,
  rupees,
  valueAt,
  type Basket,
  type OptionChainData,
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
  /** Rupees the already-exited units of a held basket made, added back to every curve and figure. */
  booked?: number;
  /** The screen's own margin sentence, when it resolved one; the basket desk's wording beats ours. */
  marginNote?: string | null;
}

interface Greeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  ivPct: number;
}

type TargetCurve =
  | { ok: true; values: number[]; greeks: Greeks }
  | { ok: false; reason: string };

interface ChartGeom {
  w: number;
  h: number;
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
  lo: number;
  hi: number;
  xs: number[];
  px: (x: number) => number;
  py: (y: number) => number;
  zeroY: number;
  expiryLine: number[] | null;
  targetLine: number[] | null;
  yTicks: number[];
  xTicks: number[];
  expiryPath: string | null;
  targetPath: string | null;
  profitZone: string;
  lossZone: string;
}

/** Theme palette generator */
function getPalette(theme: string) {
  const isDark = theme === "dark";
  return {
    isDark,
    bg: isDark ? "#0f172a" : "#f8fafc",
    plot: isDark ? "#10141b" : "#ffffff",
    card: isDark ? "#1e293b" : "#ffffff",
    cardAlt: isDark ? "#182234" : "#f1f5f9",
    text: isDark ? "#f1f5f9" : "#0f172a",
    muted: isDark ? "#94a3b8" : "#64748b",
    border: isDark ? "#334155" : "#e2e8f0",
    borderLight: isDark ? "#1e293b" : "#f1f5f9",
    brand: isDark ? "#38bdf8" : "#0284c7",
    brandBg: isDark ? "rgba(56, 189, 248, 0.12)" : "rgba(2, 132, 199, 0.08)",
    pos: isDark ? "#22c55e" : "#16a34a",
    posFill: isDark ? "rgba(34, 197, 94, 0.13)" : "rgba(22, 163, 74, 0.10)",
    neg: isDark ? "#ef4444" : "#dc2626",
    negFill: isDark ? "rgba(239, 68, 68, 0.11)" : "rgba(220, 38, 38, 0.10)",
    warn: isDark ? "#f59e0b" : "#d97706",
    ltp: isDark ? "#fb923c" : "#ea580c",
    guide: isDark ? "#e2e8f0" : "#334155",
    knob: "#0b1220",
  };
}

/** Axis and tooltip money, in the units a trader reads off a payoff graph rather than in rupees. */
function shortMoney(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 10000000) return `${sign}${(abs / 10000000).toFixed(2)}Cr`;
  if (abs >= 100000) return `${sign}${(abs / 100000).toFixed(2)}L`;
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}K`;
  if (abs === 0) return "0";
  return `${sign}${abs.toFixed(0)}`;
}

const DAY_MS = 86400000;

/** Days from now to an ISO expiry at the IST close; null when the date will not parse. */
function daysToExpiry(expiry: string): number | null {
  const parts = expiry.split("-").map(Number);
  if (parts.length !== 3 || parts.some(part => !Number.isFinite(part))) return null;
  const close = new Date(parts[0]!, parts[1]! - 1, parts[2]!, 15, 30, 0).getTime();
  return Math.max(0, (close - Date.now()) / DAY_MS);
}

export default function PayoffChart({
  underlying,
  expiry,
  legs,
  spot,
  chains,
  title,
  booked = 0,
  marginNote = null,
}: PayoffChartProps) {
  const { useStrategyAnalysis, usePlanningMargin } = useApi();
  const { resolvedTheme } = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  const colors = useMemo(() => getPalette(resolvedTheme), [resolvedTheme]);

  const [view, setView] = useState<"chart" | "table" | "greeks">("chart");
  const [showOiBar, setShowOiBar] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [touchPx, setTouchPx] = useState<number | null>(null);

  // What-if state. None of it changes the server request; see the file header.
  const [targetMovePct, setTargetMovePct] = useState(0);
  const [daysForward, setDaysForward] = useState(0);
  const [ivShiftPct, setIvShiftPct] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const activeLegs = useMemo(() => legs.filter(leg => leg.lots > 0 && leg.lotSize > 0), [legs]);

  const virtualBasket: Basket = useMemo(() => {
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
  }, [activeLegs, underlying, expiry, spot, title]);

  // A leg whose ladder quote has gone quiet is priced from its own entry premium, so an after-hours build
  // still draws the curve the trader staged rather than refusing to draw one.
  const preparedChains = useMemo(() => {
    const answered = chains.filter((c): c is OptionChainData => !!c);
    if (!answered.length) return answered;

    return answered.map(c => ({
      ...c,
      rows: c.rows.map(row => {
        const prepareQuote = (quote: typeof row.call, right: "CE" | "PE") => {
          if (!quote) return quote;
          const matchingLeg = activeLegs.find(
            l => Number(l.strike) === Number(row.strike) && l.right === right && l.expiry === c.expiry
          );
          const fallbackPrice =
            matchingLeg?.entryPrice && matchingLeg.entryPrice > 0 ? String(matchingLeg.entryPrice) : undefined;

          const currentLtp = Number(quote.ltp);
          const hasLtp = Number.isFinite(currentLtp) && currentLtp > 0;
          const ltpVal = hasLtp ? quote.ltp : quote.ask || quote.bid || fallbackPrice || quote.ltp;

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

        return { ...row, call: prepareQuote(row.call, "CE"), put: prepareQuote(row.put, "PE") };
      }),
    })) as unknown as readonly OptionChainData[];
  }, [chains, activeLegs, spot]);

  const built = useMemo(() => buildAnalysis(virtualBasket, preparedChains), [virtualBasket, preparedChains]);
  const analysis = useStrategyAnalysis(built.body);
  // A screen that already resolved the margin in its own words does not need a second read for it.
  const margin = usePlanningMargin(marginNote ? null : built.margin);

  const model = useMemo(
    () => (analysis.data ? curves(analysis.data, booked) : null),
    [analysis.data, booked]
  );
  const held = useMemo(() => heldPayoff(virtualBasket, booked), [virtualBasket, booked]);

  const until = useMemo(() => {
    const dates = [...new Set(virtualBasket.payoffLegs.map(l => l.expiry).filter(Boolean))];
    return dates.join(" & ") || null;
  }, [virtualBasket]);

  const figures = useMemo(
    () => (analysis.data ? payoffFigures(analysis.data, until, booked) : null),
    [analysis.data, until, booked]
  );

  const currentSpot = Number(analysis.data?.spot ?? spot ?? 0);

  /** The price the trader is asking about: today's spot moved by the target stepper. */
  const targetSpot = currentSpot > 0 ? currentSpot * (1 + targetMovePct / 100) : 0;

  const horizon = useMemo(() => {
    const days = activeLegs
      .map(leg => daysToExpiry(leg.expiry))
      .filter((d): d is number => d !== null);
    // The curve settles on the earliest date it expires on, which is the one the server draws against.
    return days.length ? { nearest: Math.min(...days), furthest: Math.max(...days) } : null;
  }, [activeLegs]);

  const forwardDays = Math.max(0, Math.min(daysForward, horizon ? Math.ceil(horizon.nearest) : daysForward));
  const remainingDays = horizon ? Math.max(0, horizon.nearest - forwardDays) : null;

  // Auto-play walks the target price across a ±5% band so the shape of the payoff can be watched moving.
  useEffect(() => {
    if (!isPlaying) return;
    const timer = setInterval(() => {
      setTargetMovePct(prev => (prev >= 5 ? -5 : Number((prev + 0.25).toFixed(2))));
    }, 120);
    return () => clearInterval(timer);
  }, [isPlaying]);

  /**
   * The target-date curve, priced here. Each leg keeps its own remaining life, so a calendar basket decays
   * its near wing towards expiry while the far wing still carries time value — one shared tau would flatten
   * both at the near date and be wrong about the basket the trader holds.
   */
  const targetCurve = useMemo<TargetCurve | null>(() => {
    const spots = model?.spots ?? held?.spots ?? [];
    if (spots.length < 3) return null;
    if (!activeLegs.length) return { ok: false, reason: "no legs to price" };
    if (!(currentSpot > 0)) return { ok: false, reason: "no underlying price from the broker yet" };

    const rate = Number(analysis.data?.assumptions.ratePct ?? 0) / 100;
    const dividend = Number(analysis.data?.assumptions.dividendPct ?? 0) / 100;

    const priced: Array<{ strike: number; right: "CE" | "PE"; qty: number; basis: number; years: number; iv: number }> = [];
    const unpriceable: string[] = [];

    for (const leg of activeLegs) {
      const strike = Number(leg.strike);
      const chain = preparedChains.find(c => c.expiry === leg.expiry);
      const row = chain?.rows.find(r => Number(r.strike) === strike);
      const quote = row ? (leg.right === "CE" ? row.call : row.put) : null;
      const quoted = Number(quote?.ltp);
      const price = Number.isFinite(quoted) && quoted > 0 ? quoted : Number(leg.entryPrice);
      const total = daysToExpiry(leg.expiry);

      if (!Number.isFinite(strike) || strike <= 0) {
        unpriceable.push(`${leg.strike}${leg.right} has no readable strike`);
        continue;
      }
      if (!(price > 0)) {
        unpriceable.push(`${leg.strike}${leg.right} has no premium`);
        continue;
      }
      if (total === null) {
        unpriceable.push(`${leg.strike}${leg.right} has no readable expiry`);
        continue;
      }

      // The ladder quotes IV in percent; Black-Scholes wants a fraction of one.
      const ladderIv = quote?.iv != null ? Number(quote.iv) / 100 : null;
      const yearsToQuote = Math.max(total, 0.25) / 365;
      const solved = ladderIv && ladderIv > 0
        ? ladderIv
        : impliedVol(price, currentSpot, strike, yearsToQuote, rate, dividend, leg.right);
      if (solved === null) {
        unpriceable.push(`${leg.strike}${leg.right}'s premium is at or under its intrinsic, so it implies no volatility`);
        continue;
      }

      priced.push({
        strike,
        right: leg.right,
        qty: (leg.side === "BUY" ? 1 : -1) * leg.lots * leg.lotSize,
        basis: price,
        years: Math.max(0, total - forwardDays) / 365,
        iv: Math.max(0.001, solved + ivShiftPct / 100),
      });
    }

    // One unpriceable wing stops the curve: a line drawn over only the legs that answered would read as the
    // payoff of the basket, and it is not that.
    if (unpriceable.length) return { ok: false, reason: unpriceable.join(" · ") };

    const values = spots.map(s =>
      priced.reduce((sum, leg) => {
        const est = blackScholes(s, leg.strike, leg.years, rate, dividend, leg.iv, leg.right).price;
        return sum + leg.qty * (est - leg.basis);
      }, 0) + booked
    );

    const greeks = priced.reduce(
      (sum, leg) => {
        const at = blackScholes(currentSpot, leg.strike, leg.years, rate, dividend, leg.iv, leg.right);
        return {
          delta: sum.delta + leg.qty * at.delta,
          gamma: sum.gamma + leg.qty * at.gamma,
          theta: sum.theta + leg.qty * at.theta,
          vega: sum.vega + leg.qty * at.vega,
          iv: sum.iv + leg.iv,
          legs: sum.legs + 1,
        };
      },
      { delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0, legs: 0 }
    );

    return {
      ok: true,
      values,
      greeks: {
        delta: greeks.delta,
        gamma: greeks.gamma,
        theta: greeks.theta,
        vega: greeks.vega,
        ivPct: (greeks.iv / (greeks.legs || 1)) * 100,
      },
    };
  }, [activeLegs, preparedChains, currentSpot, forwardDays, ivShiftPct, booked, model, held, analysis.data]);

  const chart = useMemo<ChartGeom | null>(() => {
    const modelSpots = model?.spots ?? [];
    const heldSpots = held?.spots ?? [];
    const xs = modelSpots.length >= heldSpots.length ? modelSpots : heldSpots;
    if (xs.length < 3) return null;

    const resample = (fromSpots: number[], fromValues: number[] | null | undefined) => {
      if (!fromValues || fromSpots.length !== fromValues.length) return null;
      if (fromSpots.length === xs.length && fromSpots.every((s, i) => s === xs[i])) return fromValues;
      return xs.map(x => valueAt(fromSpots, fromValues, x) ?? 0);
    };

    const expiryLine = model?.expiry
      ? resample(modelSpots, model.expiry)
      : resample(heldSpots, held?.values);
    // The target curve was priced on the model's grid when the model answered, and on the phone's own exact
    // grid when it did not. Resampling from that grid, rather than from whichever of the two is longer, is
    // what keeps both lines on one axis instead of silently dropping the target line.
    const targetLine = targetCurve?.ok ? resample(modelSpots.length ? modelSpots : heldSpots, targetCurve.values) : null;
    if (!expiryLine && !targetLine) return null;

    const lines = [expiryLine, targetLine].filter((l): l is number[] => !!l);
    const w = Math.round(screenWidth - 32);
    const h = 260;
    const padLeft = 54;
    const padRight = 14;
    const padTop = 26;
    const padBottom = 22;

    const fullLo = xs[0]!;
    const fullHi = xs[xs.length - 1]!;
    const center = (fullLo + fullHi) / 2;
    const halfRange = (fullHi - fullLo) / 2 / zoom;
    const lo = center - halfRange;
    const hi = center + halfRange;

    let yMin = 0;
    let yMax = 0;
    for (const arr of lines) {
      for (let i = 0; i < xs.length; i += 1) {
        if (xs[i]! < lo || xs[i]! > hi) continue;
        const y = arr[i]!;
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
    const span = yMax - yMin;
    const pad = Math.max(span * 0.15, 60);
    const yLo = span < 0.005 ? yMin - 150 : yMin - pad;
    const yHi = span < 0.005 ? yMax + 150 : yMax + pad;

    const px = (x: number) => padLeft + ((x - lo) / (hi - lo || 1)) * (w - padLeft - padRight);
    const py = (y: number) => padTop + (1 - (y - yLo) / (yHi - yLo || 1)) * (h - padTop - padBottom);
    const path = (values: number[]) =>
      xs.map((x, i) => `${i === 0 ? "M" : "L"}${px(x).toFixed(1)},${py(values[i]!).toFixed(1)}`).join("");

    const zeroY = py(0);
    // The shaded zones are the area the curve encloses against zero, split at the zero line itself.
    const zone = (values: number[], side: "profit" | "loss") => {
      let d = `M${px(xs[0]!).toFixed(1)},${zeroY.toFixed(1)}`;
      for (let i = 0; i < xs.length; i += 1) {
        const y = py(values[i]!);
        d += ` L${px(xs[i]!).toFixed(1)},${(side === "profit" ? Math.min(zeroY, y) : Math.max(zeroY, y)).toFixed(1)}`;
      }
      return `${d} L${px(xs[xs.length - 1]!).toFixed(1)},${zeroY.toFixed(1)} Z`;
    };

    const shadeLine = targetLine ?? expiryLine!;

    return {
      w,
      h,
      padLeft,
      padRight,
      padTop,
      padBottom,
      lo,
      hi,
      xs,
      px,
      py,
      zeroY,
      expiryLine,
      targetLine,
      yTicks: [yHi * 0.82, yHi * 0.41, 0, yLo * 0.41, yLo * 0.82],
      xTicks: Array.from({ length: 6 }, (_, i) => lo + ((hi - lo) * i) / 5),
      expiryPath: expiryLine ? path(expiryLine) : null,
      targetPath: targetLine ? path(targetLine) : null,
      profitZone: zone(shadeLine, "profit"),
      lossZone: zone(shadeLine, "loss"),
    };
  }, [model, held, targetCurve, screenWidth, zoom]);

  /** Open interest per strike, for the optional histogram behind the curves. */
  const oi = useMemo(() => {
    if (!showOiBar) return null;
    const byStrike = new Map<number, { call: number; put: number }>();
    for (const chain of preparedChains) {
      for (const row of chain.rows) {
        const strike = Number(row.strike);
        if (!Number.isFinite(strike)) continue;
        const entry = byStrike.get(strike) ?? { call: 0, put: 0 };
        entry.call += Number(row.call?.oi) || 0;
        entry.put += Number(row.put?.oi) || 0;
        byStrike.set(strike, entry);
      }
    }
    const bars = [...byStrike.entries()].filter(([, v]) => v.call > 0 || v.put > 0).sort((a, b) => a[0] - b[0]);
    if (!bars.length) return { bars, max: 0 };
    return { bars, max: Math.max(...bars.map(([, v]) => Math.max(v.call, v.put))) };
  }, [showOiBar, preparedChains]);

  const spotOnChart = !!chart && currentSpot > 0 && currentSpot >= chart.lo && currentSpot <= chart.hi;

  const readSpot = useMemo(() => {
    if (!chart) return 0;
    if (touchPx === null) return targetSpot || currentSpot;
    const inner = chart.w - chart.padLeft - chart.padRight || 1;
    const raw = chart.lo + ((touchPx - chart.padLeft) / inner) * (chart.hi - chart.lo);
    return Math.min(chart.hi, Math.max(chart.lo, raw));
  }, [chart, touchPx, targetSpot, currentSpot]);

  const readExpiry = chart ? valueAt(chart.xs, chart.expiryLine, readSpot) : null;
  const readTarget = chart ? valueAt(chart.xs, chart.targetLine, readSpot) : null;
  const readPct = currentSpot > 0 ? ((readSpot - currentSpot) / currentSpot) * 100 : 0;

  /**
   * The pill under the graph answers the question the steppers ask: what this position is projected to be
   * worth on the target date if the underlying reaches the target price. With no target line to read it
   * falls back to today's price held to expiry, the one curve the phone always has.
   */
  const projected = useMemo(() => {
    if (!chart || !(currentSpot > 0)) return null;
    const atTarget = targetSpot > 0 ? valueAt(chart.xs, chart.targetLine, targetSpot) : null;
    return atTarget ?? valueAt(chart.xs, chart.expiryLine, currentSpot);
  }, [chart, currentSpot, targetSpot]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: evt => setTouchPx(evt.nativeEvent.locationX),
      onPanResponderMove: evt => setTouchPx(evt.nativeEvent.locationX),
      onPanResponderRelease: () => setTouchPx(null),
      onPanResponderTerminate: () => setTouchPx(null),
    })
  ).current;

  const marginDisplay = marginNote
    ?? (margin.data?.available
      ? `${rupees(margin.data.amount ?? null) ?? "no amount"}${margin.data.brokerVerified ? "" : " · planning figure, not the broker’s"}`
      : margin.data?.reason ?? (margin.isError ? "the margin read failed" : "reading"));

  /**
   * What the phone cannot invent: the probability of profit is a distribution, not a curve, so it
   * exists only once the model answers. Staying on "reading" after the model refused would hide a
   * failure the trader is deciding around, so each state gets its own words.
   */
  const modelOnly = analysis.isError
    ? "the model did not answer"
    : built.body === null
      ? "nothing sent to the model"
      : "reading";

  const serverGreeks = analysis.data?.greeks.available
    ? {
        delta: analysis.data.greeks.delta,
        gamma: analysis.data.greeks.gamma,
        theta: analysis.data.greeks.theta,
        vega: analysis.data.greeks.vega,
        ivPct: analysis.data.greeks.ivPct,
        basis: analysis.data.greeks.basis,
      }
    : null;
  const greeks = targetCurve?.ok ? targetCurve.greeks : serverGreeks;
  const greeksAreLocal = !!targetCurve?.ok;

  const noCurveReason = chart
    ? null
    : built.body === null
      ? built.unpriced.join("  ·  ") || "nothing here can be priced yet"
      : "the payoff is still being read";

  const targetNote = targetCurve && targetCurve.ok === false ? targetCurve.reason : null;

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.headRow}>
        <View style={styles.segment}>
          {(["chart", "table", "greeks"] as const).map(mode => (
            <TouchableOpacity
              key={mode}
              style={[styles.segmentBtn, view === mode && { backgroundColor: colors.brandBg, borderColor: colors.brand }]}
              onPress={() => setView(mode)}
              accessibilityRole="button"
              accessibilityLabel={`Show the payoff ${mode}`}
            >
              <Text style={[styles.segmentText, { color: view === mode ? colors.text : colors.muted }]}>
                {mode === "chart" ? "Chart" : mode === "table" ? "Table" : "Greeks"}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity
          style={styles.oiToggle}
          onPress={() => setShowOiBar(v => !v)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: showOiBar }}
          accessibilityLabel="Show open interest bars"
        >
          <Text style={[styles.small, { color: colors.text }]}>OI Bar</Text>
          <View style={[styles.checkbox, { borderColor: colors.border }, showOiBar && { backgroundColor: colors.brand, borderColor: colors.brand }]}>
            {showOiBar ? <Ionicons name="checkmark" size={12} color={colors.knob} /> : null}
          </View>
        </TouchableOpacity>
      </View>

      {noCurveReason ? (
        <Text style={[styles.source, { color: colors.muted }]}>{`No payoff curve: ${noCurveReason}`}</Text>
      ) : null}

      {chart ? (
        <>
          <View style={styles.legendRow}>
            <Legend swatch={colors.pos} label="On expiry" color={colors.pos} />
            <Legend swatch={colors.brand} label="On target date" color={colors.brand} dimmed={!chart.targetPath} />
            {showOiBar && oi?.bars.length ? (
              <View style={styles.legendItem}>
                <View style={[styles.legendBar, { backgroundColor: colors.neg }]} />
                <View style={[styles.legendBar, { backgroundColor: colors.pos }]} />
                <Text style={[styles.small, { color: colors.muted }]}>OI call / put</Text>
              </View>
            ) : null}
          </View>

          {/* ─── The graph ───────────────────────────────────────────────── */}
          {view === "chart" ? (
            <View style={{ position: "relative" }}>
              <View {...panResponder.panHandlers}>
                <Svg width={chart.w} height={chart.h}>
                  <Rect
                    x={chart.padLeft}
                    y={chart.padTop}
                    width={chart.w - chart.padLeft - chart.padRight}
                    height={chart.h - chart.padTop - chart.padBottom}
                    fill={colors.plot}
                  />
                  <Path d={chart.profitZone} fill={colors.posFill} />
                  <Path d={chart.lossZone} fill={colors.negFill} />

                  {showOiBar && oi && oi.bars.length ? (
                    oi.bars
                      .filter(([strike]) => strike >= chart.lo && strike <= chart.hi)
                      .map(([strike, quotes]) => {
                        const floor = chart.h - chart.padBottom;
                        const scale = (chart.h - chart.padTop - chart.padBottom) * 0.35;
                        const x = chart.px(strike);
                        const callH = (quotes.call / (oi.max || 1)) * scale;
                        const putH = (quotes.put / (oi.max || 1)) * scale;
                        return (
                          <React.Fragment key={`oi-${strike}`}>
                            <Rect x={x - 3} y={floor - callH} width={3} height={callH} fill={colors.neg} opacity={0.45} />
                            <Rect x={x} y={floor - putH} width={3} height={putH} fill={colors.pos} opacity={0.45} />
                          </React.Fragment>
                        );
                      })
                  ) : null}

                  {chart.yTicks.map((tick, i) => (
                    <Line
                      key={`grid-${i}`}
                      x1={chart.padLeft}
                      y1={chart.py(tick)}
                      x2={chart.w - chart.padRight}
                      y2={chart.py(tick)}
                      stroke={colors.borderLight}
                      strokeWidth={1}
                    />
                  ))}
                  <Line
                    x1={chart.padLeft}
                    y1={chart.zeroY}
                    x2={chart.w - chart.padRight}
                    y2={chart.zeroY}
                    stroke={colors.muted}
                    strokeWidth={1}
                    strokeDasharray="4 3"
                  />

                  {chart.targetPath ? <Path d={chart.targetPath} stroke={colors.brand} strokeWidth={2} fill="none" /> : null}
                  {chart.expiryPath ? <Path d={chart.expiryPath} stroke={colors.pos} strokeWidth={2} fill="none" /> : null}

                  {/* Today's price, and the price the trader is asking about. */}
                  {spotOnChart ? (
                    <Line
                      x1={chart.px(currentSpot)}
                      y1={chart.padTop + 12}
                      x2={chart.px(currentSpot)}
                      y2={chart.h - chart.padBottom}
                      stroke={colors.ltp}
                      strokeWidth={1.4}
                    />
                  ) : null}
                  {readSpot > 0 && Math.abs(readSpot - currentSpot) > (chart.hi - chart.lo) * 0.004 ? (
                    <>
                      <Line
                        x1={chart.px(readSpot)}
                        y1={chart.padTop}
                        x2={chart.px(readSpot)}
                        y2={chart.h - chart.padBottom}
                        stroke={colors.guide}
                        strokeWidth={1.2}
                        strokeDasharray="4 3"
                        opacity={0.7}
                      />
                      {readTarget !== null ? (
                        <Circle cx={chart.px(readSpot)} cy={chart.py(readTarget)} r={5} fill={colors.brand} stroke={colors.plot} strokeWidth={1.5} />
                      ) : null}
                      {readExpiry !== null ? (
                        <Circle cx={chart.px(readSpot)} cy={chart.py(readExpiry)} r={4} fill={colors.pos} stroke={colors.plot} strokeWidth={1.5} />
                      ) : null}
                    </>
                  ) : null}
                </Svg>
              </View>

              {chart.yTicks.map((tick, i) => (
                <Text
                  key={`ytick-${i}`}
                  style={[styles.yLabel, { color: colors.muted, left: 0, top: chart.py(tick) - 7, width: chart.padLeft - 8 }]}
                  numberOfLines={1}
                >
                  {shortMoney(tick)}
                </Text>
              ))}
              <Text style={[styles.axisTitle, { color: colors.muted }]}>Profit/Loss</Text>

              {spotOnChart ? (
                <View
                  style={[styles.ltpPill, { borderColor: colors.border, backgroundColor: colors.cardAlt, left: chart.px(currentSpot) - 46 }]}
                  pointerEvents="none"
                >
                  <Text style={[styles.ltpText, { color: colors.text }]}>{`LTP ${formatNumber(currentSpot, 0)}`}</Text>
                </View>
              ) : null}

              <View style={[styles.tooltipCard, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
                <View style={styles.tooltipHead}>
                  <Text style={[styles.small, { color: colors.muted }]}>When price is at</Text>
                  <Text style={[styles.tooltipSpot, { color: colors.text }]}>
                    {`${formatNumber(readSpot, 0)} `}
                    <Text style={{ color: readPct >= 0 ? colors.pos : colors.neg }}>
                      {`${readPct >= 0 ? "+" : ""}${readPct.toFixed(2)}%`}
                    </Text>
                  </Text>
                </View>
                <Text style={[styles.small, { color: colors.muted }]}>Expected P&amp;L on</Text>
                <TooltipRow label="Target" value={readTarget} colors={colors} />
                <TooltipRow label="Expiry" value={readExpiry} colors={colors} />
              </View>

              <TouchableOpacity
                style={[styles.zoomBtn, { borderColor: colors.border, backgroundColor: colors.cardAlt }]}
                onPress={() => setZoom(z => (z === 1 ? 1.6 : 1))}
                accessibilityRole="button"
                accessibilityLabel={zoom === 1 ? "Zoom in on the payoff chart" : "Zoom out on the payoff chart"}
              >
                <Ionicons name="scan-outline" size={16} color={colors.brand} />
              </TouchableOpacity>
            </View>
          ) : null}

          {view === "chart" ? (
            <>
              <View style={[styles.xAxis, { paddingLeft: chart.padLeft, paddingRight: chart.padRight }]}>
                {chart.xTicks.map((tick, i) => (
                  <Text key={`xt-${i}`} style={[styles.xLabel, { color: colors.muted }]}>
                    {formatNumber(tick, 0)}
                  </Text>
                ))}
              </View>

              <View style={styles.projectedRow}>
                <View style={[styles.projectedPill, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
                  <Text style={[styles.small, { color: colors.muted }]}>
                    {projected === null ? "Projected P&L " : projected >= 0 ? "Projected Profit " : "Projected Loss "}
                    <Text style={{ color: projected === null ? colors.muted : projected >= 0 ? colors.pos : colors.neg, fontWeight: "700" }}>
                      {projected === null ? "no price" : rupees(projected, true) ?? "no price"}
                    </Text>
                  </Text>
                </View>
              </View>

              <Text style={[styles.source, { color: colors.muted }]}>
                {`On expiry is the phone's own arithmetic · On target date is Black-Scholes here at ${remainingDays === null ? "today" : `${remainingDays.toFixed(0)}D to expiry`}`}
                {targetNote ? `, which stopped because ${targetNote}` : ""}
                {showOiBar && oi && !oi.bars.length ? " · the ladder sent no open interest" : ""}
              </Text>
            </>
          ) : null}

          {/* ─── Table view ──────────────────────────────────────────────── */}
          {view === "table" ? (
            <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator={false}>
              <View style={styles.tableHead}>
                <Text style={[styles.tableHeadText, { color: colors.muted, flex: 1 }]}>Price</Text>
                <Text style={[styles.tableHeadText, { color: colors.muted, flex: 1, textAlign: "right" }]}>Move</Text>
                <Text style={[styles.tableHeadText, { color: colors.muted, flex: 1.3, textAlign: "right" }]}>On target date</Text>
                <Text style={[styles.tableHeadText, { color: colors.muted, flex: 1.3, textAlign: "right" }]}>On expiry</Text>
              </View>
              {tableRows(chart, currentSpot).map(row => (
                <View key={row.spot} style={[styles.tableRow, { borderTopColor: colors.borderLight }]}>
                  <Text style={[styles.tableText, { color: colors.text, flex: 1 }]}>{formatNumber(row.spot, 0)}</Text>
                  <Text style={[styles.tableText, { color: row.pct >= 0 ? colors.pos : colors.neg, flex: 1, textAlign: "right" }]}>
                    {`${row.pct >= 0 ? "+" : ""}${row.pct.toFixed(2)}%`}
                  </Text>
                  <Text style={[styles.tableText, { color: row.target === null ? colors.muted : row.target >= 0 ? colors.pos : colors.neg, flex: 1.3, textAlign: "right" }]}>
                    {row.target === null ? "no line" : shortMoney(row.target)}
                  </Text>
                  <Text style={[styles.tableText, { color: row.expiry === null ? colors.muted : row.expiry >= 0 ? colors.pos : colors.neg, flex: 1.3, textAlign: "right" }]}>
                    {row.expiry === null ? "no line" : shortMoney(row.expiry)}
                  </Text>
                </View>
              ))}
            </ScrollView>
          ) : null}
        </>
      ) : null}

      {/* ─── Greeks view ─────────────────────────────────────────────────── */}
      {view === "greeks" ? (
        <View style={styles.greeksWrap}>
          {greeks ? (
            <>
              <Text style={[styles.small, { color: colors.muted }]}>
                {greeksAreLocal
                  ? `Priced on this phone at ${remainingDays === null ? "today" : `${remainingDays.toFixed(0)}D to expiry`} with a ${ivShiftPct >= 0 ? "+" : ""}${ivShiftPct}% IV shift`
                  : `From the server model${serverGreeks?.basis ? ` · ${serverGreeks.basis}` : ""}`}
              </Text>
              <View style={styles.greeksGrid}>
                <Greek label="Delta" value={greeks.delta.toFixed(2)} hint="per 1 pt of the underlying" colors={colors} signed={greeks.delta} />
                <Greek label="Gamma" value={greeks.gamma.toFixed(4)} hint="delta change per point" colors={colors} />
                <Greek label="Theta" value={`${greeks.theta.toFixed(2)}/day`} hint="daily decay" colors={colors} signed={greeks.theta} />
                <Greek label="Vega" value={greeks.vega.toFixed(2)} hint="per 1 vol point" colors={colors} />
                <Greek label="IV" value={`${greeks.ivPct.toFixed(1)}%`} hint="across the legs held" colors={colors} />
              </View>
            </>
          ) : (
            <Text style={[styles.small, { color: colors.muted }]}>
              {analysis.data && analysis.data.greeks.available === false
                ? `The server declined these: ${analysis.data.greeks.reason}`
                : targetNote
                  ? `Nothing to price: ${targetNote}`
                  : "Greeks need a premium and a volatility for every leg; neither has answered yet."}
            </Text>
          )}
        </View>
      ) : null}

      {/* ─── What-if: target price ───────────────────────────────────────── */}
      <View style={[styles.simBlock, { borderTopColor: colors.border }]}>
        <View style={styles.simHead}>
          <Text style={[styles.simTitle, { color: colors.text }]} numberOfLines={1}>{`${underlying} target`}</Text>
          {targetMovePct !== 0 ? (
            <TouchableOpacity onPress={() => setTargetMovePct(0)} accessibilityRole="button" accessibilityLabel="Reset the target price">
              <Text style={[styles.reset, { color: colors.brand }]}>RESET</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <View style={[styles.stepper, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
          <StepButton sign={-1} colors={colors} onPress={() => setTargetMovePct(p => Number((p - 0.5).toFixed(2)))} label="Lower the target price" />
          <View style={{ alignItems: "center" }}>
            <Text style={[styles.stepperValue, { color: colors.text }]}>{formatNumber(targetSpot, 2)}</Text>
            <Text style={[styles.stepperNote, { color: targetMovePct >= 0 ? colors.pos : colors.neg }]}>
              {`${targetMovePct >= 0 ? "+" : ""}${targetMovePct.toFixed(2)}%`}
            </Text>
          </View>
          <StepButton sign={1} colors={colors} onPress={() => setTargetMovePct(p => Number((p + 0.5).toFixed(2)))} label="Raise the target price" />
        </View>
        <Slider
          value={targetMovePct}
          min={-5}
          max={5}
          step={0.1}
          colors={colors}
          onChange={setTargetMovePct}
          playing={isPlaying}
          onPlayToggle={() => setIsPlaying(p => !p)}
          label="target price"
        />
      </View>

      {/* ─── What-if: target date ────────────────────────────────────────── */}
      <View style={[styles.simBlock, { borderTopColor: colors.border }]}>
        <View style={styles.simHead}>
          <Text style={[styles.simTitle, { color: colors.text }]}>
            Target date &amp; time
            {remainingDays !== null ? <Text style={{ color: colors.muted }}>{`  ${remainingDays.toFixed(0)}D to expiry`}</Text> : null}
          </Text>
          {daysForward !== 0 ? (
            <TouchableOpacity onPress={() => setDaysForward(0)} accessibilityRole="button" accessibilityLabel="Reset the target date to today">
              <Text style={[styles.reset, { color: colors.brand }]}>RESET</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        {horizon ? (
          <>
            <View style={[styles.stepper, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
              <StepButton sign={-1} colors={colors} onPress={() => setDaysForward(d => Math.max(0, d - 1))} label="One day closer to today" />
              <View style={{ alignItems: "center" }}>
                <Text style={[styles.stepperValue, { color: colors.text }]}>{`T+${forwardDays.toFixed(0)}D`}</Text>
                <Text style={[styles.stepperNote, { color: colors.muted }]}>{`${forwardDays.toFixed(0)} day${forwardDays === 1 ? "" : "s"} of decay`}</Text>
              </View>
              <StepButton
                sign={1}
                colors={colors}
                onPress={() => setDaysForward(d => Math.min(Math.ceil(horizon.nearest), d + 1))}
                label="One day closer to expiry"
              />
            </View>
            <Slider
              value={forwardDays}
              min={0}
              max={Math.max(1, Math.ceil(horizon.nearest))}
              step={1}
              colors={colors}
              onChange={v => setDaysForward(Math.round(v))}
              label="target date"
            />
          </>
        ) : (
          <Text style={[styles.small, { color: colors.muted }]}>No leg carries a readable expiry date, so there is no target date to move.</Text>
        )}
      </View>

      {/* ─── What-if: implied volatility ─────────────────────────────────── */}
      <View style={[styles.simBlock, { borderTopColor: colors.border }]}>
        <View style={styles.simHead}>
          <Text style={[styles.simTitle, { color: colors.text }]}>Implied volatility shift</Text>
          {ivShiftPct !== 0 ? (
            <TouchableOpacity onPress={() => setIvShiftPct(0)} accessibilityRole="button" accessibilityLabel="Reset the volatility shift">
              <Text style={[styles.reset, { color: colors.brand }]}>RESET</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <View style={styles.pillRow}>
          {[-10, -5, -2, 0, 2, 5, 10].map(pts => (
            <TouchableOpacity
              key={`iv-${pts}`}
              style={[styles.pill, { borderColor: colors.border }, ivShiftPct === pts && { backgroundColor: colors.warn, borderColor: colors.warn }]}
              onPress={() => setIvShiftPct(pts)}
              accessibilityRole="button"
              accessibilityLabel={`Shift implied volatility ${pts >= 0 ? "up" : "down"} ${Math.abs(pts)} percent`}
            >
              <Text style={[styles.pillText, { color: ivShiftPct === pts ? colors.knob : colors.muted }]}>
                {pts === 0 ? "0%" : `${pts > 0 ? "+" : ""}${pts}%`}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* ─── Figures ─────────────────────────────────────────────────────── */}
      <View style={[styles.metrics, { borderTopColor: colors.border }]}>
        <Metric
          label="MAX PROFIT"
          value={figures?.maxProfit ?? (held ? (held.max === null ? "Unlimited" : rupees(held.max) ?? "unknown") : modelOnly)}
          colors={colors}
        />
        <Metric
          label="MAX LOSS"
          value={figures?.maxLoss ?? (held ? (held.min === null ? "Unlimited - one side is naked" : rupees(Math.abs(held.min)) ?? "unknown") : modelOnly)}
          colors={colors}
        />
        <Metric
          label="BREAKEVENS"
          value={figures?.breakEvens ?? (held?.breakEvens.length ? held.breakEvens.map(v => formatNumber(v, 2)).join("  ·  ") : "none inside the strikes")}
          colors={colors}
          wide
        />
        <Metric label="POP" value={figures?.pop ?? modelOnly} colors={colors} />
        <Metric
          label={figures?.net.startsWith("Net credit") ? "NET CREDIT" : "NET DEBIT"}
          value={figures ? figures.net.replace(/^Net (credit|debit) /, "") : held ? rupees(Math.abs(held.netDebit)) ?? "unknown" : modelOnly}
          colors={colors}
        />
        <Metric label="RISK : REWARD" value={figures ? riskReward(figures) : modelOnly} colors={colors} />
        <Metric label="EST. MARGIN" value={marginDisplay} colors={colors} wide />
      </View>
      {figures?.horizon ? <Text style={[styles.source, { color: colors.muted }]}>{figures.horizon}</Text> : null}
      {analysis.isPending && built.body ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={colors.brand} />
          <Text style={[styles.small, { color: colors.muted }]}>Reading the model for the current-value line</Text>
        </View>
      ) : null}
      {analysis.isError ? (
        <Text style={[styles.source, { color: colors.neg }]}>
          {`The model read failed: ${analysis.error.message}. The expiry line is the phone's own arithmetic and still stands.`}
        </Text>
      ) : null}
      {built.marks.length ? (
        <Text style={[styles.source, { color: colors.muted }]}>{priceProvenance(built.marks)}</Text>
      ) : null}
    </View>
  );
}

function Legend({ swatch, label, color, dimmed }: { swatch: string; label: string; color: string; dimmed?: boolean }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendSwatch, { backgroundColor: color, opacity: dimmed ? 0.35 : 1 }]} />
      <Text style={[styles.small, { color, opacity: dimmed ? 0.5 : 1 }]}>{label}</Text>
    </View>
  );
}

function TooltipRow({ label, value, colors }: { label: string; value: number | null; colors: ReturnType<typeof getPalette> }) {
  return (
    <View style={styles.tooltipLine}>
      <Text style={[styles.small, { color: colors.muted }]}>{label}</Text>
      <Text style={[styles.tooltipValue, { color: value === null ? colors.muted : value >= 0 ? colors.pos : colors.neg }]}>
        {value === null ? "no line" : shortMoney(value)}
      </Text>
    </View>
  );
}

function Greek({
  label,
  value,
  hint,
  colors,
  signed,
}: {
  label: string;
  value: string;
  hint: string;
  colors: ReturnType<typeof getPalette>;
  signed?: number;
}) {
  return (
    <View style={[styles.greekCard, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
      <Text style={[styles.small, { color: colors.muted }]}>{label}</Text>
      <Text style={[styles.greekValue, { color: signed === undefined ? colors.text : signed >= 0 ? colors.pos : colors.neg }]}>{value}</Text>
      <Text style={[styles.hint, { color: colors.muted }]}>{hint}</Text>
    </View>
  );
}

function Metric({ label, value, colors, wide }: { label: string; value: string; colors: ReturnType<typeof getPalette>; wide?: boolean }) {
  return (
    <View style={[styles.metric, wide && { flexBasis: "48%" }]}>
      <Text style={[styles.metricLabel, { color: colors.muted }]}>{label}</Text>
      <Text style={[styles.metricValue, { color: colors.text }]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

function StepButton({ sign, onPress, colors, label }: { sign: 1 | -1; onPress: () => void; colors: ReturnType<typeof getPalette>; label: string }) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.stepBtn} accessibilityRole="button" accessibilityLabel={label}>
      <Ionicons name={sign === 1 ? "add" : "remove"} size={20} color={colors.brand} />
    </TouchableOpacity>
  );
}

/** A draggable band; with a play button as its knob when the caller passes a toggle. */
function Slider({
  value,
  min,
  max,
  step,
  colors,
  onChange,
  playing = false,
  onPlayToggle,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  colors: ReturnType<typeof getPalette>;
  onChange: (value: number) => void;
  playing?: boolean;
  onPlayToggle?: () => void;
  label: string;
}) {
  const widthRef = useRef(1);

  const clamp = (raw: number) => {
    const snapped = Math.round(raw / step) * step;
    return Number(Math.min(max, Math.max(min, snapped)).toFixed(4));
  };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: evt => onChange(clamp(min + (evt.nativeEvent.locationX / (widthRef.current || 1)) * (max - min))),
      onPanResponderMove: evt => onChange(clamp(min + (evt.nativeEvent.locationX / (widthRef.current || 1)) * (max - min))),
    })
  ).current;

  const ratio = Math.max(0, Math.min(1, (value - min) / (max - min || 1)));

  return (
    <View
      onLayout={e => { widthRef.current = e.nativeEvent.layout.width; }}
      style={styles.sliderTrack}
      {...responder.panHandlers}
      accessibilityRole="adjustable"
      accessibilityLabel={`Set the ${label}`}
      accessibilityValue={{ min: Math.round(min), max: Math.round(max), now: Math.round(value) }}
    >
      <View style={styles.sliderRail} />
      <View style={[styles.sliderFill, { backgroundColor: colors.brand, width: `${ratio * 100}%` }]} />
      <View style={[styles.sliderKnob, { backgroundColor: colors.brand, left: `${ratio * 100}%` }]}>
        {onPlayToggle ? (
          <TouchableOpacity
            style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
            onPress={onPlayToggle}
            accessibilityRole="button"
            accessibilityLabel={playing ? "Stop the target price animation" : "Play the target price animation"}
          >
            <Ionicons name={playing ? "pause" : "play"} size={12} color={colors.knob} />
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

/** ~18 rows across the drawn range, always including the current price. */
function tableRows(
  chart: ChartGeom,
  spot: number
): { spot: number; pct: number; expiry: number | null; target: number | null }[] {
  const lo = chart.xs[0]!;
  const hi = chart.xs[chart.xs.length - 1]!;
  const picks = [...new Set([
    ...Array.from({ length: 17 }, (_, i) => lo + ((hi - lo) * i) / 16),
    spot,
  ].map(v => Math.round(v)))].sort((a, b) => a - b);

  return picks
    .filter(p => p >= lo && p <= hi)
    .map(p => ({
      spot: p,
      pct: spot > 0 ? ((p - spot) / spot) * 100 : 0,
      expiry: valueAt(chart.xs, chart.expiryLine, p),
      target: valueAt(chart.xs, chart.targetLine, p),
    }));
}

function riskReward(figures: Record<string, string>): string {
  const parse = (text?: string): number | null => {
    if (!text || text.startsWith("Unlimited") || text.startsWith("Not stated")) return null;
    const match = text.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
    return match ? Math.abs(Number(match[0])) : null;
  };
  const profit = parse(figures.maxProfit);
  const loss = parse(figures.maxLoss);
  if (!profit || !loss) return "not a fixed ratio";
  return `${(profit / loss).toFixed(2)} : 1`;
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 10 },
  headRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  segment: { flexDirection: "row", gap: 6 },
  segmentBtn: { borderWidth: 1, borderColor: "transparent", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  segmentText: { fontSize: 13, fontWeight: "600" },
  oiToggle: { flexDirection: "row", alignItems: "center", gap: 8 },
  checkbox: { width: 18, height: 18, borderRadius: 4, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  legendRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 16, paddingLeft: 8 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  legendSwatch: { width: 16, height: 2, borderRadius: 1 },
  legendBar: { width: 4, height: 10, borderRadius: 1 },
  small: { fontSize: 12 },
  hint: { fontSize: 10 },
  yLabel: { position: "absolute", fontSize: 10, textAlign: "right" },
  axisTitle: { position: "absolute", left: -22, top: 120, transform: [{ rotate: "-90deg" }], fontSize: 10 },
  xAxis: { flexDirection: "row", justifyContent: "space-between" },
  xLabel: { fontSize: 10 },
  ltpPill: { position: "absolute", borderWidth: 1, borderRadius: 5, paddingHorizontal: 8, paddingVertical: 2, top: 2 },
  ltpText: { fontSize: 11, fontWeight: "700" },
  tooltipCard: { position: "absolute", right: 10, top: 46, width: 178, borderWidth: 1, borderRadius: 8, padding: 10, gap: 4 },
  tooltipHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 6 },
  tooltipSpot: { fontSize: 13, fontWeight: "700" },
  tooltipLine: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  tooltipValue: { fontSize: 13, fontWeight: "700" },
  zoomBtn: { position: "absolute", right: 8, bottom: 8, width: 30, height: 30, borderRadius: 6, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  projectedRow: { alignItems: "center", marginTop: 6 },
  projectedPill: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7 },
  source: { fontSize: 11, lineHeight: 15 },
  tableHead: { flexDirection: "row", paddingBottom: 6 },
  tableHeadText: { fontSize: 11, fontWeight: "600" },
  tableRow: { flexDirection: "row", borderTopWidth: 1, paddingVertical: 7 },
  tableText: { fontSize: 12 },
  greeksWrap: { gap: 8 },
  greeksGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  greekCard: { flexGrow: 1, minWidth: 100, borderWidth: 1, borderRadius: 8, padding: 10, gap: 2 },
  greekValue: { fontSize: 16, fontWeight: "700" },
  simBlock: { paddingTop: 12, gap: 10 },
  simHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  simTitle: { fontSize: 14, fontWeight: "600", flexShrink: 1 },
  reset: { fontSize: 12, fontWeight: "700" },
  stepper: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 6 },
  stepBtn: { paddingHorizontal: 14, paddingVertical: 4 },
  stepperValue: { fontSize: 16, fontWeight: "700" },
  stepperNote: { fontSize: 11, fontWeight: "600" },
  sliderTrack: { height: 30, justifyContent: "center" },
  sliderRail: { position: "absolute", height: 4, borderRadius: 2, left: 0, right: 0, backgroundColor: "rgba(148, 163, 184, 0.35)" },
  sliderFill: { position: "absolute", height: 4, borderRadius: 2, left: 0 },
  sliderKnob: { position: "absolute", width: 26, height: 26, borderRadius: 13, marginLeft: -13, alignItems: "center", justifyContent: "center" },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pill: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, minWidth: 46, alignItems: "center" },
  pillText: { fontSize: 12, fontWeight: "600" },
  metrics: { flexDirection: "row", flexWrap: "wrap", gap: 12, paddingTop: 12 },
  metric: { flexGrow: 1, minWidth: 100, gap: 2 },
  metricLabel: { fontSize: 10, fontWeight: "700", letterSpacing: 0.4 },
  metricValue: { fontSize: 13, fontWeight: "600" },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 8 },
});
