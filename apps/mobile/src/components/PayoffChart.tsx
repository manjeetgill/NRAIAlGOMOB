/**
 * PayoffChart — the payoff plot the Spread Builder and the Basket Desk both draw.
 *
 * Both curves are computed here, on the frame the legs change: the terminal payoff is exact intrinsic
 * against the premium each leg was taken at, and the target-date payoff is Black-Scholes on the same axis.
 * /v1/strategy-analysis refines the Greeks, POP and figures beside the plot; it is never what draws a line,
 * because a leg added or removed changes the request and leaves the previous answer unusable.
 *
 * On the plot: the expiry line tinted by which side of zero it is on, the target-date line, the live price
 * with its LTP tag, a price scrubber that stays where it was dragged, open interest behind them on request,
 * and the same two lines as a table. Below it: max profit and loss, risk:reward, POP, break-evens, the net
 * credit or debit, the margin estimate and the spot-and-IV what-if simulator.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { ClipPath, Circle, Defs, G, Line, Path, Rect, Text as SvgText } from "react-native-svg";
import { Ionicons } from "@expo/vector-icons";
import {
  buildAnalysis,
  curves,
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

// ─── Client-side Black-Scholes Mathematical Engine (T+0 Line & Greeks) ────────

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
  if (price <= intrinsic) return 0.14; // baseline IV ~14%
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

/** Axis labels the way the desk prints money: 2.00L, -4.77L, 1.25Cr rather than 400000. */
function lakhLabel(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e7) return `${(value / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${(value / 1e5).toFixed(2)}L`;
  if (abs > 0 && abs < 1) return value.toFixed(2);
  return value.toFixed(0);
}

/**
 * Round values that bracket a range, so the gridlines land on numbers a trader can read off.
 *
 * The step is the candidate whose resulting interval count sits closest to `count`, not simply the next
 * round number above the ideal: rounding a 1.16 Cr ideal step up to 2 Cr turns a five-label axis into two.
 */
function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min;
  if (!(span > 0) || !Number.isFinite(span)) return [];
  const mag = 10 ** Math.floor(Math.log10(span / count));
  let step = mag;
  let bestGap = Infinity;
  for (const base of [mag / 10, mag]) {
    for (const mult of [1, 2, 2.5, 5, 10]) {
      const candidate = base * mult;
      const intervals = span / candidate;
      if (intervals < 2 || intervals > count * 2) continue;
      const gap = Math.abs(intervals - count);
      if (gap < bestGap) {
        bestGap = gap;
        step = candidate;
      }
    }
  }
  const out: number[] = [];
  for (let k = 0; k < 12; k++) {
    const v = Math.ceil(min / step) * step + k * step;
    if (v > max + step * 1e-9) break;
    out.push(Math.round(v * 100) / 100);
  }
  return out;
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

function useThrottledValue<T>(value: T, intervalMs = 250): T {
  const [throttled, setThrottled] = useState(value);
  const lastUpdated = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const now = Date.now();
    const remaining = intervalMs - (now - lastUpdated.current);
    if (remaining <= 0) {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      lastUpdated.current = now;
      setThrottled(value);
    } else if (!timer.current) {
      timer.current = setTimeout(() => {
        timer.current = null;
        lastUpdated.current = Date.now();
        setThrottled(value);
      }, remaining);
    }
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [value, intervalMs]);

  return throttled;
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
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const colors = useMemo(() => getPalette(resolvedTheme), [resolvedTheme]);
  // Cap live spot updates to 4 FPS for BSM / SVG curve generation so spot ticks never starve the JS thread
  const throttledSpot = useThrottledValue(spot, 250);

  // Zoom & Pan state
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);

  // The price the trader has parked the scrubber on; null means "follow the live price".
  const [scrubSpot, setScrubSpot] = useState<number | null>(null);

  // Plot view: the curve, or the same numbers as rows. OI Bar draws the exchange's open interest behind it.
  const [plotView, setPlotView] = useState<"chart" | "table">("chart");
  const [showOIBars, setShowOIBars] = useState(false);

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
      spot: throttledSpot ? String(throttledSpot) : "0",
    } as unknown as Basket;
  }, [legs, underlying, expiry, throttledSpot, title]);

  // 2. Prepare chains: fallback missing ltp to close/ask/bid/entryPrice so after-hours builds succeed
  const preparedChains = useMemo(() => {
    const list = chains ?? [];
    const answered = list.filter((c): c is OptionChainData => !!c);
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
          const spotVal = Number.isFinite(currentSpot) && currentSpot > 0
            ? String(currentSpot)
            : throttledSpot ? String(throttledSpot) : "0";

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
  }, [chains, legs, throttledSpot]);

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

  // 5. The curves the phone draws itself, on the frame the legs change.
  //
  // /v1/strategy-analysis is a round trip and a new leg set is a new cache key, so a plot that waits on it
  // goes blank exactly when a leg is added or removed. The terminal payoff is arithmetic and the target-date
  // payoff is Black-Scholes, both of which this file already carries, so the line is drawn from the legs and
  // the server read refines the figures beside it rather than being the only thing that can draw at all.
  const model = useMemo(
    () => (analysis.data ? curves(analysis.data, 0) : null),
    [analysis.data]
  );

  // The price the axis is drawn around. The middle of the strike range is the only fallback, so a curve is
  // never refused because a quote has not arrived yet.
  const liveSpot = Number(analysis.data?.spot ?? throttledSpot ?? virtualBasket.spot) || 0;

  /** One sampled axis, from five steps below the lowest strike to five steps above the highest. */
  const grid = useMemo(() => {
    const strikes = [...new Set(
      legs.filter(l => l.lots > 0).map(l => Number(l.strike)).filter(s => Number.isFinite(s) && s > 0)
    )].sort((a, b) => a - b);
    if (!strikes.length) return null;
    const gaps = strikes.slice(1).map((s, i) => s - strikes[i]!).filter(g => g > 0);
    const step = gaps.length ? Math.min(...gaps) : Math.max(1, Math.round(strikes[0]! * 0.01));
    const low = Math.max(step, strikes[0]! - 5 * step);
    const high = strikes[strikes.length - 1]! + 5 * step;
    const spots = [...new Set([
      ...Array.from({ length: 61 }, (_, i) => low + ((high - low) * i) / 60),
      ...strikes,
    ])].sort((a, b) => a - b).map(v => Math.round(v * 100) / 100);
    return { spots, strikes };
  }, [legs]);

  // Each staged leg with the premium it is priced against and the time left to its own expiry: the price on
  // the leg row first, because that is the number the trader is being asked to trade, then the ladder.
  const pricedLegs = useMemo(() => {
    const active = legs.filter(l => l.lots > 0);
    if (!active.length) return [];
    const now = new Date();
    const anchor = liveSpot > 0
      ? liveSpot
      : ((grid?.spots[0] ?? 0) + (grid?.spots[grid?.spots.length ? grid.spots.length - 1 : 0] ?? 0)) / 2;

    return active.map(l => {
      const strike = Number(l.strike);
      const chain = chains.find(c => c?.expiry === l.expiry);
      const row = chain?.rows.find(r => Number(r.strike) === strike);
      const quote = l.right === "CE" ? row?.call : row?.put;
      const entry = Number(l.entryPrice);
      const ltp = Number(quote?.ltp);
      const ask = Number(quote?.ask);
      const bid = Number(quote?.bid);
      const price = entry > 0 ? entry : ltp > 0 ? ltp : ask > 0 ? ask : bid > 0 ? bid : null;

      let years = 7 / 365;
      if (l.expiry) {
        const parts = l.expiry.split("-").map(Number);
        if (parts.length === 3) {
          // 15:30 IST (UTC+05:30) on expiry day, whatever time zone the phone is set to.
          const expDate = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 10, 0, 0));
          years = Math.max(0.0005, (expDate.getTime() - now.getTime()) / (365 * 86400 * 1000));
        }
      }

      // The chain quotes IV in percent (17.3 = 17.3%); the model takes a fraction.
      const chainIv = quote?.iv != null && Number(quote.iv) > 0 ? Number(quote.iv) / 100 : null;
      const baseIv = chainIv ?? (price !== null && anchor > 0
        ? solveImpliedVol(price, anchor, strike, years, 0, 0, l.right)
        : 0.14);

      return {
        strike,
        right: l.right,
        qty: (l.side === "BUY" ? 1 : -1) * (l.lots || 1) * (l.lotSize || 1),
        price,
        years,
        iv: Math.max(0.001, baseIv + ivShiftPoints / 100),
      };
    });
  }, [legs, chains, liveSpot, grid, ivShiftPoints]);

  /** Why no curve can be drawn honestly, in the words the card shows, or null when one can. */
  const curveRefusal = useMemo(() => {
    const active = legs.filter(l => l.lots > 0);
    const malformed = active.find(l => !Number.isFinite(Number(l.strike)) || Number(l.strike) <= 0);
    if (malformed) return `${malformed.strike} ${malformed.right} is not a strike this curve can be drawn on.`;
    const bare = pricedLegs.find(l => l.price === null);
    // A premium of zero would draw the payoff of a free option, which is the wrong number in the one place
    // the trader is about to press a button.
    if (bare) return `${bare.strike} ${bare.right} has no price from the broker, so its payoff is unknown.`;
    return null;
  }, [legs, pricedLegs]);

  // On expiry: every leg has settled, so this is exact intrinsic against the premium taken in or paid out.
  // It holds across several expiries too — at the furthest date the nearer legs are already worthless.
  const expiryCurve = useMemo(() => {
    if (!grid || !pricedLegs.length || curveRefusal) return null;
    const values = grid.spots.map(s => pricedLegs.reduce((sum, l) => {
      const intrinsic = l.right === "CE" ? Math.max(s - l.strike, 0) : Math.max(l.strike - s, 0);
      return sum + l.qty * (intrinsic - (l.price ?? 0));
    }, 0));
    return { spots: grid.spots, values };
  }, [grid, pricedLegs, curveRefusal]);

  // The limits, break-evens and the credit or debit out of the same curve the plot draws, so the tiles under
  // it move on the same frame as the line instead of waiting for the model read.
  const localStats = useMemo(() => {
    if (!expiryCurve) return null;
    const { spots, values } = expiryCurve;
    if (values.length < 2) return null;

    const FLAT = 0.005;
    const left = values[1]! - values[0]!;
    const right = values[values.length - 1]! - values[values.length - 2]!;

    // The right tail keeps running off the chart; the left tail runs to spot zero, which is a finite floor.
    const valueAtZero = pricedLegs.reduce((sum, l) => {
      const intrinsic = l.right === "PE" ? l.strike : 0;
      return sum + l.qty * (intrinsic - (l.price ?? 0));
    }, 0);
    const rightUnboundedProfit = right > FLAT;
    const rightUnboundedLoss = right < -FLAT;
    const leftUnboundedProfit = left < -FLAT && valueAtZero > Math.max(...values);
    const leftUnboundedLoss = left > FLAT && valueAtZero < Math.min(...values);

    const breakevens: number[] = [];
    for (let i = 1; i < values.length; i++) {
      const a = values[i - 1]!;
      const b = values[i]!;
      if (b === 0) breakevens.push(spots[i]!);
      else if ((a < 0) !== (b < 0)) breakevens.push(spots[i - 1]! + ((0 - a) / (b - a)) * (spots[i]! - spots[i - 1]!));
    }

    return {
      max: rightUnboundedProfit || leftUnboundedProfit ? null : Math.max(...values),
      min: rightUnboundedLoss || leftUnboundedLoss ? null : Math.min(...values),
      profitUnbounded: rightUnboundedProfit || leftUnboundedProfit,
      lossUnbounded: rightUnboundedLoss || leftUnboundedLoss,
      breakevens,
      netDebit: pricedLegs.reduce((sum, l) => sum + (l.price ?? 0) * l.qty, 0),
    };
  }, [expiryCurve, pricedLegs]);

  // The target-date curve and the strategy's own Greeks, from the same legs the plot is drawn on. The server
  // model replaces the line when it answers; this is what the card shows while it has not.
  const localTarget = useMemo(() => {
    const spots = grid?.spots ?? [];
    if (spots.length < 3 || !pricedLegs.length || curveRefusal || !(liveSpot > 0)) return null;

    const values = spots.map(s => pricedLegs.reduce((sum, l) =>
      sum + l.qty * (bsm(s, l.strike, l.years, 0, 0, l.iv, l.right).price - (l.price ?? 0)), 0));

    let netDelta = 0;
    let netTheta = 0;
    let netGamma = 0;
    let netVega = 0;
    let totalIv = 0;
    for (const l of pricedLegs) {
      const res = bsm(liveSpot, l.strike, l.years, 0, 0, l.iv, l.right);
      netDelta += l.qty * res.delta;
      netTheta += l.qty * res.theta;
      netGamma += l.qty * res.gamma;
      netVega += l.qty * res.vega;
      totalIv += l.iv;
    }

    // Probability of Profit by log-normal terminal density, integrated over the axis the curve is drawn on.
    let popWeight = 0;
    let totalWeight = 0;
    const avgYears = pricedLegs.reduce((acc, l) => acc + l.years, 0) / pricedLegs.length;
    const avgSigma = totalIv / pricedLegs.length || 0.14;
    const rootYears = Math.sqrt(avgYears);
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i]!;
      if (s <= 0) continue;
      const d1 = (Math.log(s / liveSpot) + 0.5 * avgSigma * avgSigma * avgYears) / (avgSigma * rootYears);
      const density = Math.exp(-0.5 * d1 * d1) / (s * avgSigma * rootYears * Math.sqrt(2 * Math.PI));
      totalWeight += density;
      if ((expiryCurve?.values[i] ?? 0) > 0) popWeight += density;
    }

    return {
      spots,
      values,
      atSpotToday: valueAt(spots, values, liveSpot),
      popPct: totalWeight > 0 ? (popWeight / totalWeight) * 100 : 50,
      greeks: {
        delta: netDelta,
        theta: netTheta,
        gamma: netGamma,
        vega: netVega,
        ivPct: (totalIv / pricedLegs.length) * 100,
      },
    };
  }, [grid, pricedLegs, expiryCurve, liveSpot, curveRefusal]);

  // Expiry figures
  const until = useMemo(() => {
    const dates = [...new Set(virtualBasket.payoffLegs.map(l => l.expiry).filter(Boolean))];
    return dates.join(" & ") || null;
  }, [virtualBasket]);

  const figures = useMemo(
    () => (analysis.data ? payoffFigures(analysis.data, until, 0) : null),
    [analysis.data, until]
  );

  // 6. Plot geometry. The line comes from the local curves; the model read only replaces the target line
  // once it has answered, so nothing on the plot is ever waiting on a request.
  const chart = useMemo(() => {
    const xs = grid?.spots ?? [];
    if (xs.length < 3) return null;

    const resample = (fromSpots: number[] | undefined, fromValues: number[] | null | undefined) => {
      if (!fromValues || !fromSpots || fromSpots.length !== fromValues.length) return null;
      if (fromSpots.length === xs.length && fromSpots.every((s, i) => s === xs[i])) return fromValues;
      return xs.map(x => valueAt(fromSpots, fromValues, x) ?? 0);
    };

    const expiryLine = expiryCurve?.values ?? null;
    const targetLine = resample(model?.spots, model?.today) ?? localTarget?.values ?? null;
    if (!expiryLine && !targetLine) return null;

    const w = Math.round(screenWidth - (expanded ? 40 : 32));
    const h = expanded ? Math.round(screenHeight - 250) : 286;
    const padLeft = 54;
    const padRight = 12;
    const padTop = 30;
    const padBottom = 26;

    const fullLo = xs[0]!;
    const fullHi = xs[xs.length - 1]!;
    const center = (fullLo + fullHi) / 2;
    const halfRange = (fullHi - fullLo) / 2 / zoom;
    const lo = center - halfRange;
    const hi = center + halfRange;

    const idx: number[] = [];
    for (let i = 0; i < xs.length; i++) if (xs[i]! >= lo && xs[i]! <= hi) idx.push(i);
    if (idx.length < 2) return null;

    let yMin = 0;
    let yMax = 0;
    for (const arr of [expiryLine, targetLine]) {
      if (!arr) continue;
      for (const i of idx) {
        const y = arr[i]!;
        if (!Number.isFinite(y)) continue;
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
    const span = yMax - yMin;
    const yLo = span < 0.005 ? yMin - 100 : yMin - Math.max(span * 0.08, 50);
    const yHi = span < 0.005 ? yMax + 100 : yMax + Math.max(span * 0.08, 50);

    const px = (x: number) => padLeft + ((x - lo) / (hi - lo || 1)) * (w - padLeft - padRight);
    const py = (y: number) => padTop + (1 - (y - yLo) / (yHi - yLo || 1)) * (h - padTop - padBottom);

    const makePath = (values: number[]) => {
      let path = `M${px(xs[idx[0]!]!).toFixed(1)},${py(values[idx[0]!]!).toFixed(1)}`;
      for (let k = 1; k < idx.length; k++) {
        const i = idx[k]!;
        path += `L${px(xs[i]!).toFixed(1)},${py(values[i]!).toFixed(1)}`;
      }
      return path;
    };
    // Down to the zero line and back, so the loss half of the fill can be tinted red and the profit half
    // green from the one shape.
    const makeArea = (values: number[]) => {
      const first = idx[0]!;
      const last = idx[idx.length - 1]!;
      return `${makePath(values)}L${px(xs[last]!).toFixed(1)},${py(0).toFixed(1)}L${px(xs[first]!).toFixed(1)},${py(0).toFixed(1)}Z`;
    };

    return {
      w,
      h,
      px,
      py,
      lo,
      hi,
      fullLo,
      fullHi,
      xs,
      plotLeft: padLeft,
      plotRight: w - padRight,
      plotTop: padTop,
      plotBottom: h - padBottom,
      zero: py(0),
      expiryValues: expiryLine,
      targetValues: targetLine,
      expiryPath: expiryLine ? makePath(expiryLine) : null,
      targetPath: targetLine ? makePath(targetLine) : null,
      areaPath: expiryLine ? makeArea(expiryLine) : null,
      yTicks: niceTicks(yLo, yHi, 5),
      xTicks: niceTicks(lo, hi, 5).filter(v => v >= lo && v <= hi),
    };
  }, [grid, expiryCurve, localTarget, model, screenWidth, screenHeight, zoom, expanded]);

  // Current spot coordinates & values, read off the line that is actually drawn.
  const effectiveSpot = liveSpot;
  const spotOnChart =
    !!chart && Number.isFinite(effectiveSpot) && effectiveSpot > 0 && effectiveSpot >= chart.lo && effectiveSpot <= chart.hi;

  const expiryAtSpot =
    chart?.expiryValues && spotOnChart ? valueAt(chart.xs, chart.expiryValues, effectiveSpot) : null;
  const todayAtSpot =
    chart?.targetValues && spotOnChart ? valueAt(chart.xs, chart.targetValues, effectiveSpot) : null;

  // The scrubber sits on the live price until the trader drags it, then stays where they left it.
  const scrubbed = scrubSpot !== null ? scrubSpot : effectiveSpot;
  const scrubOnChart =
    !!chart && Number.isFinite(scrubbed) && scrubbed >= chart.lo && scrubbed <= chart.hi;
  const scrubX = chart && scrubOnChart ? chart.px(scrubbed) : null;
  const scrubExpiry =
    chart?.expiryValues && scrubOnChart ? valueAt(chart.xs, chart.expiryValues, scrubbed) : null;
  const scrubTarget =
    chart?.targetValues && scrubOnChart ? valueAt(chart.xs, chart.targetValues, scrubbed) : null;
  const scrubPctMove = scrubOnChart && effectiveSpot > 0 ? ((scrubbed - effectiveSpot) / effectiveSpot) * 100 : 0;
  // The chip under the axis prints the date the scrubber is being dragged along, because that is the one the
  // handle is drawn on.
  const projected = scrubTarget ?? scrubExpiry;

  const chartRef = useRef(chart);
  chartRef.current = chart;

  const spotAtPixel = (x: number) => {
    const c = chartRef.current;
    if (!c || !Number.isFinite(x)) return null;
    const inside = Math.min(Math.max(x, c.plotLeft), c.plotRight);
    return c.lo + ((inside - c.plotLeft) / (c.plotRight - c.plotLeft || 1)) * (c.hi - c.lo);
  };

  const moveRaf = useRef<number | null>(null);
  const panResponder = useMemo(() => {
    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      // Only a horizontal drag is a scrub. A vertical one belongs to the screen this plot sits in, which is
      // how a trader leaves the basket desk without fighting the chart for the gesture.
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.2,
      onPanResponderGrant: evt => {
        const at = spotAtPixel(evt.nativeEvent.locationX);
        if (at !== null) setScrubSpot(at);
      },
      onPanResponderMove: evt => {
        const at = spotAtPixel(evt.nativeEvent.locationX);
        if (at === null) return;
        if (moveRaf.current !== null) cancelAnimationFrame(moveRaf.current);
        moveRaf.current = requestAnimationFrame(() => setScrubSpot(at));
      },
    });
  }, []);

  // Open interest at each strike on its own scale behind the curve, which is what the desk's OI Bar toggle
  // draws. A strike the ladder does not list is not drawn, and a read with no OI says so rather than
  // showing an empty toggle.
  const oiBars = useMemo(() => {
    if (!showOIBars || !chart) return null;
    const byStrike = new Map<number, { call: number; put: number }>();
    for (const chain of chains) {
      if (!chain) continue;
      for (const row of chain.rows) {
        const strike = Number(row.strike);
        if (!Number.isFinite(strike) || strike < chart.lo || strike > chart.hi) continue;
        const seen = byStrike.get(strike) ?? { call: 0, put: 0 };
        byStrike.set(strike, {
          call: seen.call + (Number(row.call?.oi) || 0),
          put: seen.put + (Number(row.put?.oi) || 0),
        });
      }
    }
    const items = [...byStrike.entries()];
    const max = Math.max(...items.map(([, v]) => Math.max(v.call, v.put)), 0);
    return items.length && max > 0 ? { items, max } : null;
  }, [showOIBars, chains, chart]);

  // Breakevens
  const breakEvens = useMemo(() => {
    if (figures?.breakEvens && figures.breakEvens !== "None inside the range the curve was drawn over") {
      return figures.breakEvens;
    }
    if (localStats?.breakevens.length) {
      return localStats.breakevens.map(v => formatNumber(v, 2)).join(" · ");
    }
    return "None in range";
  }, [figures, localStats]);

  // Risk : Reward ratio calculation
  const riskRewardText = useMemo(() => {
    const profitUnbounded = analysis.data?.expiry?.maxProfitUnbounded ?? localStats?.profitUnbounded;
    const lossUnbounded = analysis.data?.expiry?.maxLossUnbounded ?? localStats?.lossUnbounded;

    if (profitUnbounded && lossUnbounded) return "1 : 1 (Open)";
    if (profitUnbounded) return "1 : Unlimited";
    if (lossUnbounded) return "Unlimited Risk";

    const pNum = Number(analysis.data?.expiry?.maxProfit ?? localStats?.max);
    const lNum = Math.abs(Number(analysis.data?.expiry?.maxLoss ?? localStats?.min));

    if (Number.isFinite(pNum) && Number.isFinite(lNum) && pNum > 0 && lNum > 0) {
      return `1 : ${(pNum / lNum).toFixed(2)}`;
    }
    return "—";
  }, [analysis.data, localStats]);

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

  // A tile never prints a bare dash when the reason is already known: the words the plot shows are the same
  // words for why the figure beside it is missing.
  const noFigureText = curveRefusal ? "no price" : "—";
  const maxProfitText = figures?.maxProfit
    ? figures.maxProfit
    : localStats
    ? localStats.max === null
      ? "Unlimited"
      : rupees(localStats.max) ?? noFigureText
    : noFigureText;
  const maxLossText = figures?.maxLoss
    ? figures.maxLoss
    : localStats
    ? localStats.min === null
      ? "Unlimited"
      : rupees(Math.abs(localStats.min)) ?? noFigureText
    : noFigureText;
  const netText = figures?.net
    ? figures.net.replace(/^Net (credit|debit) /, "")
    : localStats
    ? rupees(localStats.netDebit) ?? noFigureText
    : noFigureText;

  // The plot, built once and shown either inside the card or full screen. Everything on it — the shaded loss
  // and profit halves, the LTP guide, the price scrubber — comes off the two lines the phone just computed,
  // so it repaints on the frame the legs change.
  const renderPlot = (scope: "card" | "full") => {
    if (!chart) return null;
    const { w, h, px, py, plotLeft, plotRight, plotTop, plotBottom, zero } = chart;
    // SVG ids are document-global, so the card's plot and the full screen one cannot both claim the halves.
    const lossId = `loss-${scope}`;
    const profitId = `profit-${scope}`;
    return (
      <View style={{ position: "relative" }} {...panResponder.panHandlers}>
        <TouchableOpacity
          activeOpacity={1}
          accessibilityRole="image"
          accessibilityLabel={`Payoff curve from ${formatNumber(chart.lo, 0)} to ${formatNumber(chart.hi, 0)}`}
          onPress={evt => {
            const at = spotAtPixel(evt.nativeEvent.locationX);
            if (at !== null) setScrubSpot(at);
          }}
        >
        <Svg width={w} height={h}>
          <Defs>
            <ClipPath id={lossId}>
              <Rect x={plotLeft} y={zero} width={plotRight - plotLeft} height={Math.max(plotBottom - zero, 0)} />
            </ClipPath>
            <ClipPath id={profitId}>
              <Rect x={plotLeft} y={plotTop} width={plotRight - plotLeft} height={Math.max(zero - plotTop, 0)} />
            </ClipPath>
          </Defs>

          {chart.yTicks.map(value => (
            <G key={`y${value}`}>
              <Line x1={plotLeft} y1={py(value)} x2={plotRight} y2={py(value)} stroke={colors.borderLight} strokeWidth={0.6} />
              <SvgText x={plotLeft - 6} y={py(value) + 3.5} fill={colors.muted} fontSize={9.5} textAnchor="end">
                {lakhLabel(value)}
              </SvgText>
            </G>
          ))}
          {chart.xTicks.map(value => (
            <G key={`x${value}`}>
              <Line x1={px(value)} y1={plotTop} x2={px(value)} y2={plotBottom} stroke={colors.borderLight} strokeWidth={0.6} />
              <SvgText x={px(value)} y={plotBottom + 15} fill={colors.muted} fontSize={9.5} textAnchor="middle">
                {formatNumber(value, 0)}
              </SvgText>
            </G>
          ))}
          <Line x1={plotLeft} y1={zero} x2={plotRight} y2={zero} stroke={colors.muted} strokeWidth={0.8} strokeDasharray="4 3" />

          {/* Open interest on its own scale, behind the money: calls from the top, puts from the bottom. */}
          {oiBars &&
            oiBars.items.map(([strike, oi]) => {
              const band = (plotBottom - plotTop) * 0.28;
              const x = px(strike);
              const callHeight = (oi.call / oiBars.max) * band;
              const putHeight = (oi.put / oiBars.max) * band;
              return (
                <G key={`oi${strike}`}>
                  <Rect x={x - 1.5} y={plotTop} width={3} height={Math.max(callHeight, 0)} fill={colors.pos} opacity={0.35} />
                  <Rect x={x - 1.5} y={plotBottom - Math.max(putHeight, 0)} width={3} height={Math.max(putHeight, 0)} fill={colors.neg} opacity={0.35} />
                </G>
              );
            })}

          {chart.areaPath && (
            <>
              <Path d={chart.areaPath} fill={colors.neg} opacity={0.16} clipPath={`url(#${lossId})`} />
              <Path d={chart.areaPath} fill={colors.pos} opacity={0.16} clipPath={`url(#${profitId})`} />
            </>
          )}

          {chart.targetPath && <Path d={chart.targetPath} stroke={colors.brand} strokeWidth={2} fill="none" />}

          {chart.expiryPath && (
            <>
              <Path d={chart.expiryPath} stroke={colors.neg} strokeWidth={2.2} fill="none" clipPath={`url(#${lossId})`} />
              <Path d={chart.expiryPath} stroke={colors.pos} strokeWidth={2.2} fill="none" clipPath={`url(#${profitId})`} />
            </>
          )}

          {spotOnChart && (
            <>
              <Line
                x1={px(effectiveSpot)}
                y1={plotTop - 14}
                x2={px(effectiveSpot)}
                y2={plotBottom}
                stroke={colors.warn}
                strokeWidth={1.2}
              />
              {expiryAtSpot !== null && (
                <Circle cx={px(effectiveSpot)} cy={py(expiryAtSpot)} r={3.5} fill={colors.pos} stroke={colors.card} strokeWidth={1} />
              )}
            </>
          )}

          {scrubX !== null && (
            <>
              <Line x1={scrubX} y1={plotTop - 4} x2={scrubX} y2={plotBottom} stroke={colors.muted} strokeWidth={1} strokeDasharray="3 3" />
              <Circle cx={scrubX} cy={py(scrubTarget ?? scrubExpiry ?? 0)} r={6} fill={colors.pos} stroke="#ffffff" strokeWidth={2} />
            </>
          )}
        </Svg>
        </TouchableOpacity>

        {spotOnChart && (
          <View
            pointerEvents="none"
            style={[
              styles.ltpTag,
              { borderColor: colors.border, backgroundColor: colors.card, left: Math.min(Math.max(px(effectiveSpot) - 42, plotLeft), plotRight - 84) },
            ]}
          >
            <Text style={[styles.ltpTagText, { color: colors.text }]}>LTP {formatNumber(effectiveSpot, 0)}</Text>
          </View>
        )}

        {scrubX !== null && (
          <View
            pointerEvents="none"
            style={[
              styles.scrubCard,
              {
                borderColor: colors.border,
                backgroundColor: colors.card,
                left: Math.min(Math.max(scrubX - 82, 4), w - 176),
                top: plotTop + 26,
              },
            ]}
          >
            <Text style={[styles.scrubLabel, { color: colors.muted }]} numberOfLines={1}>
              When price is at
            </Text>
            <View style={styles.scrubRow}>
              <Text style={[styles.scrubPrice, { color: colors.text }]}>{formatNumber(scrubbed, 0)}</Text>
              <Text style={[styles.scrubPct, { color: scrubPctMove >= 0 ? colors.pos : colors.neg }]}>
                {`${scrubPctMove >= 0 ? "+" : ""}${scrubPctMove.toFixed(2)}%`}
              </Text>
            </View>
            {scrubTarget !== null && (
              <View style={styles.scrubRow}>
                <Text style={[styles.scrubLabel, { color: colors.muted }]} numberOfLines={1}>Expected P&amp;L on Target</Text>
                <Text style={[styles.scrubValue, { color: scrubTarget >= 0 ? colors.pos : colors.neg }]}>{lakhLabel(scrubTarget)}</Text>
              </View>
            )}
            {scrubExpiry !== null && (
              <View style={styles.scrubRow}>
                <Text style={[styles.scrubLabel, { color: colors.muted }]}>Expiry</Text>
                <Text style={[styles.scrubValue, { color: scrubExpiry >= 0 ? colors.pos : colors.neg }]}>{lakhLabel(scrubExpiry)}</Text>
              </View>
            )}
          </View>
        )}
      </View>
    );
  };

  /** The same two lines as rows, for when the trader wants the numbers rather than the shape. */
  const renderTable = () => {
    if (!chart) return null;
    const rows = Array.from({ length: 13 }, (_, i) => {
      const price = chart.lo + ((chart.hi - chart.lo) * i) / 12;
      return {
        price,
        target: chart.targetValues ? valueAt(chart.xs, chart.targetValues, price) : null,
        expiry: chart.expiryValues ? valueAt(chart.xs, chart.expiryValues, price) : null,
      };
    });
    return (
      <View style={styles.tableWrap}>
        <View style={[styles.tableRow, { borderBottomColor: colors.border }]}>
          <Text style={[styles.tableHeadCell, { color: colors.muted, flex: 1 }]}>Price</Text>
          <Text style={[styles.tableHeadCell, { color: colors.muted, flex: 1, textAlign: "right" }]}>On target date</Text>
          <Text style={[styles.tableHeadCell, { color: colors.muted, flex: 1, textAlign: "right" }]}>On expiry</Text>
        </View>
        {rows.map(row => (
          <View key={row.price} style={[styles.tableRow, { borderBottomColor: colors.borderLight }]}>
            <Text style={[styles.tableCell, { color: colors.text, flex: 1 }]}>{formatNumber(row.price, 0)}</Text>
            <Text style={[styles.tableCell, { color: (row.target ?? 0) >= 0 ? colors.pos : colors.neg, flex: 1, textAlign: "right" }]}>
              {row.target === null ? noFigureText : lakhLabel(row.target)}
            </Text>
            <Text style={[styles.tableCell, { color: (row.expiry ?? 0) >= 0 ? colors.pos : colors.neg, flex: 1, textAlign: "right" }]}>
              {row.expiry === null ? noFigureText : lakhLabel(row.expiry)}
            </Text>
          </View>
        ))}
      </View>
    );
  };

  // The Greeks the card prints: prod's when it returns them, otherwise the same Black-Scholes the target
  // line was drawn with, so adding a leg changes them on the frame instead of after a round trip.
  const shownGreeks = analysis.data?.greeks?.available ? analysis.data.greeks : localTarget?.greeks ?? null;

  /** What the scrubbed price leaves, and what the live price leaves right now. */
  const renderProjected = () => (
    <View style={styles.projectedRow}>
      <View style={[styles.projectedChip, { borderColor: colors.border, backgroundColor: colors.card }]}>
        <Text style={[styles.projectedLabel, { color: colors.muted }]}>
          {projected === null
            ? "Projected P&L"
            : projected > 0.005
            ? "Projected Profit"
            : projected < -0.005
            ? "Projected Loss"
            : "Projected P&L"}
        </Text>
        <Text style={[styles.projectedValue, { color: (projected ?? 0) >= 0 ? colors.pos : colors.neg }]}>
          {projected === null ? noFigureText : `${projected >= 0 ? "+" : ""}${formatNumber(projected, 2)}`}
        </Text>
      </View>
      {todayAtSpot !== null && (
        <Text style={[styles.atLtpText, { color: todayAtSpot >= 0 ? colors.pos : colors.neg }]}>
          {`At LTP: ${rupees(todayAtSpot, true)}`}
        </Text>
      )}
    </View>
  );

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
            {maxProfitText}
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
            {maxLossText}
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
            {analysis.data?.pop?.available
              ? `${(analysis.data.pop.value * 100).toFixed(1)}%`
              : localTarget
              ? `${localTarget.popPct.toFixed(1)}%`
              : noFigureText}
          </Text>
        </View>
      </View>

      {/* ─── TAB 1: Payoff Graph View ────────────────────────────────── */}
      {activeTab === "chart" && (
        <>
          {/* Plot controls: the curve or its numbers, with the exchange's open interest behind it. */}
          <View style={styles.plotControls}>
            <View style={[styles.segment, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
              {(["chart", "table"] as const).map(mode => (
                <TouchableOpacity
                  key={mode}
                  style={[styles.segmentBtn, plotView === mode && { backgroundColor: colors.card }]}
                  onPress={() => setPlotView(mode)}
                  accessibilityRole="button"
                >
                  <Text style={[styles.segmentText, { color: plotView === mode ? colors.text : colors.muted }]}>
                    {mode === "chart" ? "Chart" : "Table"}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <TouchableOpacity
                style={styles.oiToggle}
                onPress={() => setShowOIBars(value => !value)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: showOIBars }}
              >
                <Text style={[styles.legendText, { color: colors.text }]}>OI Bar</Text>
                <View
                  style={[
                    styles.checkbox,
                    { borderColor: colors.muted },
                    showOIBars && { borderColor: colors.brand, backgroundColor: colors.brandBg },
                  ]}
                >
                  {showOIBars && <Ionicons name="checkmark" size={11} color={colors.brand} />}
                </View>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => setExpanded(value => !value)}
                accessibilityRole="button"
                accessibilityLabel={expanded ? "Close the full screen chart" : "Open the full screen chart"}
              >
                <Ionicons name={expanded ? "contract-outline" : "expand-outline"} size={17} color={colors.text} />
              </TouchableOpacity>
            </View>
          </View>

          {/* The two lines, named the way the desk names them, with the zoom the card has always had. */}
          <View style={styles.legendRow}>
            <View style={styles.legendItem}>
              <View style={styles.expirySwatch}>
                <View style={[styles.swatchHalf, { backgroundColor: colors.pos }]} />
                <View style={[styles.swatchHalf, { backgroundColor: colors.neg }]} />
              </View>
              <Text style={[styles.legendText, { color: colors.text }]}>On expiry</Text>
            </View>
            {chart?.targetPath && (
              <View style={styles.legendItem}>
                <View style={[styles.legendBar, { backgroundColor: colors.brand }]} />
                <Text style={[styles.legendText, { color: colors.text }]}>On target date</Text>
              </View>
            )}

            <View style={{ flex: 1 }} />

            {scrubSpot !== null && (
              <TouchableOpacity onPress={() => setScrubSpot(null)} accessibilityRole="button">
                <Text style={[styles.legendAction, { color: colors.brand }]}>Back to LTP</Text>
              </TouchableOpacity>
            )}
            {chart && (
              <View style={styles.zoomControls}>
                <TouchableOpacity
                  style={[styles.zoomBtn, { borderColor: colors.border, backgroundColor: colors.cardAlt }]}
                  onPress={() => setZoom(z => Math.min(z * 1.5, 10))}
                  accessibilityRole="button"
                  accessibilityLabel="Zoom in"
                >
                  <Ionicons name="add" size={14} color={colors.text} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.zoomBtn, zoom <= 1 && { opacity: 0.3 }, { borderColor: colors.border, backgroundColor: colors.cardAlt }]}
                  onPress={() => setZoom(z => Math.max(z / 1.5, 1))}
                  disabled={zoom <= 1}
                  accessibilityRole="button"
                  accessibilityLabel="Zoom out"
                >
                  <Ionicons name="remove" size={14} color={colors.text} />
                </TouchableOpacity>
                {zoom > 1 && (
                  <TouchableOpacity
                    style={[styles.fitBtn, { borderColor: colors.border, backgroundColor: colors.cardAlt }]}
                    onPress={() => setZoom(1)}
                    accessibilityRole="button"
                    accessibilityLabel="Reset zoom"
                  >
                    <Text style={[styles.fitBtnText, { color: colors.brand }]}>Fit</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>

          {curveRefusal ? (
            <View style={[styles.refusalBox, { borderColor: colors.border, backgroundColor: colors.cardAlt }]}>
              <Ionicons name="alert-circle-outline" size={16} color={colors.warn} />
              <Text style={[styles.refusalText, { color: colors.text }]}>{curveRefusal}</Text>
            </View>
          ) : !chart ? (
            <View style={styles.loadingChartBox}>
              <ActivityIndicator color={colors.brand} />
              <Text style={[styles.loadingText, { color: colors.muted }]}>
                No strike to draw an axis on yet.
              </Text>
            </View>
          ) : plotView === "table" ? (
            renderTable()
          ) : (
            <>
              {!expanded && renderPlot("card")}
              {renderProjected()}
            </>
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
                {netText}
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
          {shownGreeks ? (
            <View style={styles.greeksGrid}>
              <View style={[styles.greekCard, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
                <Text style={[styles.greekName, { color: colors.muted }]}>Delta (Δ)</Text>
                <Text
                  style={[
                    styles.greekVal,
                    { color: shownGreeks.delta >= 0 ? colors.pos : colors.neg },
                  ]}
                >
                  {shownGreeks.delta.toFixed(2)}
                </Text>
                <Text style={[styles.greekDesc, { color: colors.muted }]}>Per 1 pt underlying move</Text>
              </View>

              <View style={[styles.greekCard, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
                <Text style={[styles.greekName, { color: colors.muted }]}>Theta (Θ)</Text>
                <Text
                  style={[
                    styles.greekVal,
                    { color: shownGreeks.theta >= 0 ? colors.pos : colors.neg },
                  ]}
                >
                  {`${shownGreeks.theta.toFixed(2)}/day`}
                </Text>
                <Text style={[styles.greekDesc, { color: colors.muted }]}>Daily time decay</Text>
              </View>

              <View style={[styles.greekCard, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
                <Text style={[styles.greekName, { color: colors.muted }]}>Gamma (Γ)</Text>
                <Text style={[styles.greekVal, { color: colors.text }]}>
                  {shownGreeks.gamma.toFixed(4)}
                </Text>
                <Text style={[styles.greekDesc, { color: colors.muted }]}>Delta acceleration</Text>
              </View>

              <View style={[styles.greekCard, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
                <Text style={[styles.greekName, { color: colors.muted }]}>Vega (ν)</Text>
                <Text
                  style={[
                    styles.greekVal,
                    { color: shownGreeks.vega >= 0 ? colors.pos : colors.neg },
                  ]}
                >
                  {shownGreeks.vega.toFixed(2)}
                </Text>
                <Text style={[styles.greekDesc, { color: colors.muted }]}>Per 1% IV change</Text>
              </View>

              <View style={[styles.greekCard, { backgroundColor: colors.cardAlt, borderColor: colors.border, flex: 2 }]}>
                <Text style={[styles.greekName, { color: colors.muted }]}>Average IV</Text>
                <Text style={[styles.greekVal, { color: colors.brand }]}>
                  {`${shownGreeks.ivPct.toFixed(1)}%`}
                </Text>
                <Text style={[styles.greekDesc, { color: colors.muted }]}>Strategy position IV</Text>
              </View>
            </View>
          ) : (
            <View style={styles.unavailableBox}>
              <Text style={[styles.unavailableText, { color: colors.muted }]}>
                {analysis.data?.greeks && analysis.data.greeks.available === false
                  ? analysis.data.greeks.reason
                  : curveRefusal ?? "No strike to price the Greeks on yet."}
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

      {/* The same plot at the size of the phone, for reading a wide wing without zooming. */}
      <Modal visible={expanded} animationType="fade" onRequestClose={() => setExpanded(false)}>
        <View style={[styles.fullScreen, { backgroundColor: colors.bg }]}>
          <View style={styles.fullHeader}>
            <Text style={[styles.cardTitle, { color: colors.text }]} numberOfLines={1}>
              {title || `${underlying} Payoff Analysis`}
            </Text>
            <TouchableOpacity
              onPress={() => setExpanded(false)}
              accessibilityRole="button"
              accessibilityLabel="Close the full screen chart"
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
          </View>
          {curveRefusal ? (
            <View style={[styles.refusalBox, { borderColor: colors.border, backgroundColor: colors.cardAlt }]}>
              <Ionicons name="alert-circle-outline" size={16} color={colors.warn} />
              <Text style={[styles.refusalText, { color: colors.text }]}>{curveRefusal}</Text>
            </View>
          ) : (
            <>
              {renderPlot("full")}
              {renderProjected()}
            </>
          )}
        </View>
      </Modal>
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
  plotControls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 4,
  },
  segment: {
    flexDirection: "row",
    borderWidth: 1,
    borderRadius: 7,
    padding: 2,
  },
  segmentBtn: {
    paddingHorizontal: 12,
    paddingVertical: 3,
    borderRadius: 5,
  },
  segmentText: {
    fontSize: 11.5,
    fontWeight: "700",
  },
  oiToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  checkbox: {
    width: 16,
    height: 16,
    borderWidth: 1,
    borderRadius: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  legendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  expirySwatch: {
    width: 20,
    height: 3,
    borderRadius: 1.5,
    overflow: "hidden",
    flexDirection: "row",
  },
  swatchHalf: {
    flex: 1,
    height: 3,
  },
  legendBar: {
    width: 20,
    height: 3,
    borderRadius: 1.5,
  },
  legendText: {
    fontSize: 11,
    fontWeight: "600",
  },
  legendAction: {
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
    height: 200,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  loadingText: {
    fontSize: 11.5,
  },
  ltpTag: {
    position: "absolute",
    top: 2,
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  ltpTagText: {
    fontSize: 10.5,
    fontWeight: "700",
  },
  scrubCard: {
    position: "absolute",
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 9,
    paddingVertical: 6,
    gap: 3,
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 3,
    width: 172,
  },
  scrubRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
  },
  scrubLabel: {
    fontSize: 10.5,
    flexShrink: 1,
  },
  scrubPrice: {
    fontSize: 11.5,
    fontWeight: "700",
  },
  scrubPct: {
    fontSize: 10.5,
    fontWeight: "700",
  },
  scrubValue: {
    fontSize: 11,
    fontWeight: "700",
  },
  projectedRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  projectedChip: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  projectedLabel: {
    fontSize: 11,
    fontWeight: "600",
  },
  projectedValue: {
    fontSize: 11.5,
    fontWeight: "700",
  },
  atLtpText: {
    fontSize: 11,
    fontWeight: "700",
  },
  refusalBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
  },
  refusalText: {
    fontSize: 12,
    flex: 1,
  },
  tableWrap: {
    gap: 0,
  },
  tableRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 7,
    borderBottomWidth: 1,
  },
  tableHeadCell: {
    fontSize: 10.5,
    fontWeight: "700",
  },
  tableCell: {
    fontSize: 11.5,
    fontWeight: "600",
  },
  fullScreen: {
    flex: 1,
    padding: 14,
    gap: 10,
  },
  fullHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
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
