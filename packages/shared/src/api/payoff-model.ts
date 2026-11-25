/**
 * The phone's own option model — the arithmetic behind the target-date payoff line and its Greeks.
 *
 * The server prices a basket as of today; it has no curve for a date the trader picks. That curve is
 * drawn here, which means the app needs a pricer. Three functions, no dependencies, and one rule:
 *
 * `sigma` is a FRACTION (0.14 for 14%), matching what the backend puts in its `sigma` variables. The
 * ladder's `iv` column and the analysis `ivPct` field are PERCENT — prod sends `round(sigma * 100, 2)`
 * (services/option_estimates.py). Dividing by 100 at the call site is what keeps a 14% IV from
 * pricing an option ten times too rich.
 */

export interface BsPrice {
  price: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

/** Standard normal CDF, Abramowitz & Stegun 7.1.26 — accurate to ~7.5e-8, well past what a premium needs. */
export function normCdf(x: number): number {
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

/**
 * Black-Scholes with continuous dividend yield, both time-based rates per year and volatility as a
 * fraction. `theta` is rupees per calendar day (hence /365) and `vega` per volatility point (hence /100),
 * because those are the units a trader reads a Greeks panel in.
 */
export function blackScholes(
  spot: number,
  strike: number,
  years: number,
  rate: number,
  dividend: number,
  sigma: number,
  right: "CE" | "PE"
): BsPrice {
  const isCall = right === "CE";
  // No time or no volatility leaves only intrinsic, and Greeks are not defined on a straight line.
  if (spot <= 0 || strike <= 0 || years <= 0.0001 || sigma <= 0.0001) {
    return {
      price: isCall ? Math.max(0, spot - strike) : Math.max(0, strike - spot),
      delta: isCall ? (spot > strike ? 1 : 0) : spot < strike ? -1 : 0,
      gamma: 0,
      theta: 0,
      vega: 0,
    };
  }
  const root = Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (rate - dividend + (sigma * sigma) / 2) * years) / (sigma * root);
  const d2 = d1 - sigma * root;
  const df = Math.exp(-rate * years);
  const dq = Math.exp(-dividend * years);
  const density = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
  const sign = isCall ? 1 : -1;
  return {
    price: sign * (spot * dq * normCdf(sign * d1) - strike * df * normCdf(sign * d2)),
    delta: sign * dq * normCdf(sign * d1),
    gamma: (dq * density) / (spot * sigma * root),
    vega: (spot * dq * density * root) / 100,
    theta:
      ((-spot * dq * density * sigma) / (2 * root)
        - sign * rate * strike * df * normCdf(sign * d2)
        + sign * dividend * spot * dq * normCdf(sign * d1)) / 365,
  };
}

/**
 * The volatility a traded premium implies, by bisection. The ladder's own IV column is preferred and this
 * is the fallback, so a quiet IV field does not cost the trader their target-date curve.
 */
export function impliedVol(
  price: number,
  spot: number,
  strike: number,
  years: number,
  rate: number,
  dividend: number,
  right: "CE" | "PE"
): number | null {
  const intrinsic = right === "CE" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  // A premium at or under intrinsic implies no volatility, and bisecting it would invent one.
  if (!(price > intrinsic)) return null;
  let lower = 0.0001;
  let upper = 4.0;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lower + upper) / 2;
    if (blackScholes(spot, strike, years, rate, dividend, mid, right).price < price) lower = mid;
    else upper = mid;
  }
  return (lower + upper) / 2;
}
