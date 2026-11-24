/**
 * The basket desk's arithmetic, kept out of the screen so it can be tested against prod's real view model.
 *
 * Every number here comes from a row prod already sends or from a price the broker actually stamped. A
 * basket with a leg nobody has priced reports itself as unpriced rather than quietly treating that leg as
 * flat, and the model figures (T+0, POP, greeks) are only asked for when every leg carries a price with
 * the time and spot it was seen at - without those the server has no volatility to invert and answers
 * "unavailable", which is a truer screen than a curve invented locally.
 */

import type { Basket, BasketLeg, MarginRequest, MarginRequestLeg, OptionChainData, PayoffLeg, StrategyAnalysisLeg, StrategyAnalysisRequest } from "./hooks";

/** Prod's money in rupees arrives as floats on legs and decimal strings on payoff legs and curves. */
export function rupees(value: number | string | null | undefined, signed = false): string | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (parsed === null || parsed === undefined || !Number.isFinite(parsed)) return null;
  const abs = Math.abs(parsed).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${parsed < 0 ? "−" : signed ? "+" : ""}₹${abs}`;
}

/** A timestamp a model can trust must name its offset; a bare local string would be a guess. */
function stamped(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value === "") return null;
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/**
 * A 'run' is a live algo run unless the record itself says its money is simulated: prod hard-codes
 * provider "paper" for both scanner and managed paper baskets, while a broker run carries the broker's
 * own provider name.
 */
export const isLiveRun = (basket: Basket): boolean =>
  basket.kind === "run" && basket.provider !== "paper";

/** Real broker money: a named order ticket, a basket grouping broker positions, or a live algo run. */
export const isLiveMoney = (basket: Basket): boolean =>
  basket.kind === "order" || basket.kind === "manual" || isLiveRun(basket);

/** Open baskets only, newest first: a phone desk is about what is held now, not the archive. */
export function openLiveBaskets(baskets: readonly Basket[]): Basket[] {
  return baskets
    .filter(basket => isLiveMoney(basket) && basket.status !== "closed")
    .sort((a, b) => (b.openedAt ?? "").localeCompare(a.openedAt ?? ""));
}

/**
 * The basket's own money, in the two figures the trader decides on: what is booked from exits already on
 * record, and what the open legs are worth at the broker's last price. `unpriced` counts the open legs
 * with no mark, because their absence has to sit beside the total rather than inside it.
 */
export function basketPnl(legs: readonly BasketLeg[], realized: number): {
  booked: number;
  open: number | null;
  unpriced: number;
  total: number | null;
} {
  const booked = Number.isFinite(realized) ? realized : 0;
  let open: number | null = null;
  let unpriced = 0;
  for (const leg of legs) {
    if (!(leg.quantity > 0)) continue;
    const mark = leg.markPrice;
    if (mark === null || mark === undefined || !Number.isFinite(mark) || !Number.isFinite(leg.entryPrice)) {
      unpriced += 1;
      continue;
    }
    const moved = (mark - leg.entryPrice) * leg.quantity * (leg.side === "SELL" ? -1 : 1);
    open = (open ?? 0) + moved;
  }
  return { booked, open, unpriced, total: open === null ? booked : booked + open };
}

/**
 * The dates the payoff needs a ladder for. One read per distinct expiry is the whole cost: a basket is
 * built on one date, and a calendar spread needs both of its own dates and nothing else.
 */
export function payoffExpiries(basket: Basket): string[] {
  const days = [...new Set(basket.payoffLegs.map(leg => leg.expiry).filter(Boolean))];
  return (days.length ? days : [basket.expiry]).filter(Boolean).slice(0, 4);
}

/**
 * One leg's current price, taken from the ladder that lists it. The broker's own mark on the basket row
 * is the fallback for the P&L table only - it arrives without a time, and the model refuses a price it
 * cannot date, so pretending otherwise would draw a curve the server never approved.
 */
function quoteOf(leg: PayoffLeg, chains: readonly (OptionChainData | undefined)[]): {
  price: string;
  pricedAt: string | null;
  spot: string | null;
} | null {
  const chain = chains.find(item => item?.underlying === leg.underlying && item?.expiry === leg.expiry);
  if (!chain) return null;
  const row = chain.rows.find(item => Number(item.strike) === Number(leg.strike));
  const quote = leg.right === "CE" ? row?.call : row?.put;
  const ltp = Number(quote?.ltp);
  if (!quote || !(ltp > 0)) return null;
  const spotPrice = Number(chain.spot.price);
  return {
    price: ltp.toFixed(2),
    pricedAt: stamped(quote.ltpAt) ?? stamped(quote.quote?.at) ?? stamped(chain.asOf),
    spot: Number.isFinite(spotPrice) && spotPrice > 0 ? spotPrice.toFixed(2) : null,
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** `instrument:v1:NSE:FO:...` - the exchange sits at a fixed offset behind the grammar's own prefix. */
const GRAMMAR = /^instrument:v1:(NSE|BSE):FO:/;

/** What the model call needs, and - when it cannot be made - the exact reason the screen shows instead. */
export type AnalysisBuild =
  | { body: StrategyAnalysisRequest; margin: MarginRequest; unpriced: [] }
  | { body: null; margin: null; unpriced: string[] };

/**
 * The legs are priced off the live ladder, so a basket whose contracts the chain no longer lists is
 * reported rather than drawn: the server model is `extra="forbid"` and 400s on a leg it cannot resolve,
 * which is a better answer than a curve missing a wing.
 */
export function buildAnalysis(basket: Basket, chains: readonly (OptionChainData | undefined)[]): AnalysisBuild {
  const legs = basket.payoffLegs;
  if (!legs.length) return { body: null, margin: null, unpriced: ["prod does not know this basket’s contracts exactly"] };
  if (legs.length > 32) return { body: null, margin: null, unpriced: ["prod models at most 32 legs in one call"] };

  const answered = chains.filter((chain): chain is OptionChainData => !!chain);
  if (!answered.length) {
    return { body: null, margin: null, unpriced: [`no ladder read for ${legs[0].underlying} yet`] };
  }

  const missing: string[] = [];
  const priced: StrategyAnalysisLeg[] = [];
  const marginLegs: MarginRequestLeg[] = [];
  let spot: string | null = null;
  const rate = 0;
  const dividend = 0;

  for (const leg of legs) {
    const quote = quoteOf(leg, answered);
    const strike = Number(leg.strike);
    if (!quote) {
      missing.push(`${leg.underlying} ${leg.strike} ${leg.right}`);
      continue;
    }
    if (!Number.isFinite(strike) || strike <= 0 || !ISO.test(leg.expiry) || !(leg.lots > 0) || !(leg.lotSize > 0)) {
      missing.push(`${leg.underlying} ${leg.strike} ${leg.right} (contract details incomplete)`);
      continue;
    }
    // The exchange is part of the contract identity, not of the leg: BSE index options price differently.
    const exchange = GRAMMAR.exec(leg.instrumentId)?.[1];
    if (exchange !== "NSE" && exchange !== "BSE") {
      missing.push(`${leg.underlying} ${leg.strike} ${leg.right} (exchange unresolved)`);
      continue;
    }
    spot = quote.spot ?? spot;
    priced.push({
      action: leg.action,
      right: leg.right,
      exchange,
      strike: leg.strike,
      expiry: leg.expiry,
      lots: leg.lots,
      lotSize: leg.lotSize,
      price: quote.price,
      entryPrice: leg.entryPrice,
      // Both or neither: a dated price with no underlying to date against leaves the model without the
      // forward it needs, so it declines instead of guessing the spot.
      ...(quote.pricedAt && quote.spot ? { entrySpot: quote.spot, pricedAt: quote.pricedAt } : {}),
    });
    marginLegs.push({
      underlying: leg.underlying,
      exchange,
      action: leg.action,
      right: leg.right,
      strike: leg.strike,
      expiry: leg.expiry,
      lots: leg.lots,
      lotSize: leg.lotSize,
      price: quote.price,
      ...(quote.spot ? { spot: quote.spot } : {}),
    });
  }

  if (missing.length) return { body: null, margin: null, unpriced: missing };
  if (!spot) return { body: null, margin: null, unpriced: ["no underlying price from the broker yet"] };

  return {
    body: { spot, rate, dividend, legs: priced },
    margin: marginLegs.length <= 8 ? { legs: marginLegs } : null,
    unpriced: [],
  };
}

/**
 * The two curves the chart draws, paired with their strikes, plus where the basket sits right now.
 * `today` is absent whenever the model could not calibrate, and the screen says so rather than passing
 * the expiry line off as a current value.
 */
export function curves(analysis: {
  spot: string;
  curve: { spots: number[]; expiry: number[] | null; today: number[] | null };
}): { spots: number[]; expiry: number[] | null; today: number[] | null; atSpot: number | null; atSpotToday: number | null } | null {
  const spots = analysis.curve.spots ?? [];
  if (spots.length < 3) return null;
  const now = Number(analysis.spot);
  return {
    spots,
    expiry: analysis.curve.expiry,
    today: analysis.curve.today,
    atSpot: valueAt(spots, analysis.curve.expiry, now),
    atSpotToday: valueAt(spots, analysis.curve.today, now),
  };
}

/**
 * The curve is sampled on a grid, so the trader's own number is read between the samples rather than
 * from whichever sample happens to be nearest - a 20-point grid would otherwise be worth thousands.
 */
export function valueAt(spots: readonly number[], values: readonly number[] | null | undefined, spot: number): number | null {
  if (!values || values.length !== spots.length || !Number.isFinite(spot)) return null;
  if (spot <= spots[0]) return finite(values[0]);
  if (spot >= spots[spots.length - 1]) return finite(values[values.length - 1]);
  for (let i = 1; i < spots.length; i += 1) {
    if (spots[i] < spot) continue;
    const span = spots[i] - spots[i - 1];
    if (span <= 0) return finite(values[i]);
    const ratio = (spot - spots[i - 1]) / span;
    const from = values[i - 1];
    const to = values[i];
    return Number.isFinite(from) && Number.isFinite(to) ? from + (to - from) * ratio : null;
  }
  return null;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Everything the figures row prints, resolved to text or to the server's own reason. A label is never
 * paired with a blank: `Unavailable` only appears with the words prod gave for why.
 */
export function payoffFigures(analysis: {
  expiry: { available: boolean; reason?: string; maxProfit?: string | null; maxProfitUnbounded?: boolean;
    maxLoss?: string | null; maxLossUnbounded?: boolean; breakevens?: string[]; netDebit?: string;
    basis?: string; settlement?: string };
  pop: { available: true; value: number; basis: string } | { available: false; reason: string };
  greeks: { available: true; delta: number; theta: number; vega: number; gamma: number; ivPct: number } | { available: false; reason: string };
  assumptions: { ratePct: number; dividendPct: number };
}): Record<string, string> {
  const { expiry, pop, greeks } = analysis;
  const debit = Number(expiry.netDebit);
  const breakEvens = (expiry.breakevens ?? []).map(value => Number(value)).filter(Number.isFinite);
  return {
    horizon: expiry.basis === "front-expiry"
      ? `Front expiry · settles ${expiry.settlement ?? "the earlier date"}`
      : expiry.settlement ? `Expires ${expiry.settlement}` : "Expires at the basket’s own date",
    maxProfit: !expiry.available ? expiry.reason ?? "The server could not price this basket’s limits"
      : expiry.maxProfitUnbounded ? "Unlimited" : rupees(expiry.maxProfit) ?? "Not stated by the server",
    maxLoss: !expiry.available ? expiry.reason ?? "The server could not price this basket’s limits"
      : expiry.maxLossUnbounded ? "Unlimited - one side is naked" : rupees(expiry.maxLoss) ?? "Not stated by the server",
    pop: pop.available === false ? pop.reason
      : `${(pop.value * 100).toFixed(2)}% · ${pop.basis}`,
    net: Number.isFinite(debit)
      ? `${debit < 0 ? "Net credit" : "Net debit"} ${rupees(Math.abs(debit))}`
      : "The server sent no net cost for these legs",
    breakEvens: breakEvens.length
      ? breakEvens.slice(0, 4).map(value => value.toLocaleString("en-IN", { maximumFractionDigits: 2 })).join("  ·  ")
      : "None inside the range the curve was drawn over",
    greeks: greeks.available === false ? greeks.reason
      : `Δ ${greeks.delta.toFixed(2)}  ·  Γ ${greeks.gamma.toFixed(4)}  ·  Θ ${greeks.theta.toFixed(2)}/day  ·  Vega ${greeks.vega.toFixed(2)}  ·  IV ${greeks.ivPct.toFixed(1)}%`,
  };
}

/** The mark a leg is worth right now, for the legs table: a closed leg shows its booked exit, not a mark. */
export function legValue(leg: BasketLeg): { price: number | null; label: string } {
  if (leg.quantity <= 0) {
    return {
      price: finite(leg.exitPrice),
      label: leg.exitSource === "Broker trade book" ? "broker book"
        : leg.exitSource === "Recorded by you" ? "you recorded"
        : leg.exitSource ? leg.exitSource : "on record",
    };
  }
  if (leg.pending) return { price: finite(leg.markPrice), label: "order still working" };
  return { price: finite(leg.markPrice), label: "current price" };
}

/** How much of a leg was already closed, so a partly exited leg can say "85 of 170". */
export const closedUnits = (leg: BasketLeg): number => (Number.isFinite(leg.exited) && leg.exited > 0 ? leg.exited : 0);
