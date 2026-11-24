/**
 * The basket desk's arithmetic, kept out of the screen so it can be tested against prod's real view model.
 *
 * Every number here comes from a row prod already sends or from a price the broker actually stamped. A
 * basket with a leg nobody has priced reports itself as unpriced rather than quietly treating that leg as
 * flat, and the model figures (T+0, POP, greeks) are only asked for when every leg carries a price with
 * the time and spot it was seen at - without those the server has no volatility to invert and answers
 * "unavailable", which is a truer screen than a curve invented locally.
 */

import { QUALITY_WORD, todayIST, type Basket, type BasketLeg, type MarginRequest, type MarginRequestLeg, type OpenPosition, type OptionChainData, type PayoffLeg, type StrategyAnalysisLeg, type StrategyAnalysisRequest } from "./hooks";
import { formatISTDate, formatISTTime, isTodayIST } from "../utils";

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

/** A usable broker price: the book sends null or 0 for a contract it is not currently marking. */
function price(value: number | null | undefined): number | null {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

/** An expiry as YYYY-MM-DD from either shape the book and the order token use, or null when unreadable. */
export function expiryKey(value: unknown): string | null {
  const text = String(value ?? "").trim().toUpperCase();
  const iso = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const written = /^(\d{1,2})[-/ ]([A-Z]{3})[-/ ](\d{4})/.exec(text);
  const month = written ? MONTHS.indexOf(written[2]) : -1;
  return written && month >= 0 ? `${written[3]}-${String(month + 1).padStart(2, "0")}-${written[1].padStart(2, "0")}` : null;
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
 * Whether a broker open-position row is this basket leg's contract.
 *
 * A leg names itself with the order token (HINLEV_20261229_2200_PE) while the position book names the
 * same contract with its stock code plus separate strike, right and expiry, so both shapes have to be
 * read. A looser test - one symbol containing the other - labelled every NIFTY position, at any strike
 * or expiry, with the newest NIFTY basket, which is how a wrong P&L reaches a trader.
 */
export function sameContract(row: OpenPosition, leg: BasketLeg): boolean {
  const rowSymbol = row.symbol.trim().toUpperCase();
  const legSymbol = (leg.symbol ?? "").trim().toUpperCase();
  if (!rowSymbol || rowSymbol === "UNAVAILABLE" || !legSymbol) return false;
  // ICICI places and reports the same code, so an order leg is usually already named identically.
  if (rowSymbol === legSymbol) return true;

  // The other shape is an order token (HINLEV_20261229_2200_PE) beside a book row whose code embeds the
  // underlying (HINLEV26DEC2200CE). The token's strike, right and expiry then have to carry the match.
  const parsed = /^([A-Z0-9&-]+)_(\d{8})_([\dP]+)_(CE|PE)$/.exec(legSymbol);
  if (!parsed) return false;
  // Finding #8: Match the complete underlying, not a prefix. "NIFTYIT" must not pass as "NIFTY".
  // In broker symbols the underlying is followed by a date digit (HINLEV26DEC...) or nothing,
  // so only reject when the next character is a letter (a different underlying name).
  const underlyingPrefix = parsed[1]!;
  if (!rowSymbol.startsWith(underlyingPrefix)) return false;
  if (rowSymbol.length > underlyingPrefix.length) {
    const nextChar = rowSymbol[underlyingPrefix.length];
    if (nextChar && /[A-Z]/.test(nextChar)) return false;
  }
  const legStrike = Number(parsed[3]!.replace("P", "."));
  const legExpiry = `${parsed[2]!.slice(0, 4)}-${parsed[2]!.slice(4, 6)}-${parsed[2]!.slice(6, 8)}`;

  const rowRight = String(row.right ?? "").trim().toUpperCase();
  const right = rowRight.startsWith("C") ? "CE" : rowRight.startsWith("P") ? "PE" : rowRight;
  if (right !== parsed[4]!) return false;
  // Finding #9: Require valid strikes on both sides. A non-numeric strike on either side must reject.
  const rowStrike = Number(row.strike);
  if (!Number.isFinite(legStrike) || !Number.isFinite(rowStrike)) return false;
  if (rowStrike !== legStrike) return false;

  // A row whose date the phone cannot read is not established as this contract. Accepting it would price a
  // December leg with November's money, which is a wrong number rather than a missing one.
  return expiryKey(row.expiry) === legExpiry;
}

/**
 * The marks the basket read does not carry.
 *
 * Prod prices a broker-held basket's legs from the open-position book the desk already shows, and leaves
 * `markPrice` empty on those legs, so a card built from `/v1/baskets` alone shows no price for every leg
 * it holds - on the web desk the same join happens in the browser. Only a leg the server left unmarked is
 * filled, only from a broker row that still holds quantity, and never a paper basket's.
 */
export function withBookMarks(baskets: readonly Basket[], positions: readonly OpenPosition[]): {
  baskets: Basket[];
  marked: number;
} {
  const held = positions.filter(row => row.quantity > 0 && price(row.markPrice) !== null);
  if (!held.length) return { baskets: [...baskets], marked: 0 };
  let marked = 0;
  const out = baskets.map(basket => {
    if (basket.provider === "paper") return basket;
    let filled = 0;
    const legs = basket.legs.map(leg => {
      if (!(leg.quantity > 0) || price(leg.markPrice) !== null) return leg;
      const row = held.find(item => sameContract(item, leg));
      if (!row) return leg;
      filled += 1;
      return { ...leg, markPrice: row.markPrice as number };
    });
    marked += filled;
    return filled ? { ...basket, legs } : basket;
  });
  return { baskets: out, marked };
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
 * The name the ladder answers to. A broker-held basket row carries the broker's own code - ICICI names the
 * SENSEX basket `BSESEN` and a stock one `BHAFOR` - while `/v1/option-chain` and the exact contracts both
 * use the canonical one. Asking for the ladder under the row's code answers with nothing at all, which is
 * how a live basket ended up with no curve and no legs to stage.
 */
export function ladderUnderlying(basket: Basket): string {
  return basket.payoffLegs.find(leg => leg.underlying)?.underlying || basket.underlying;
}

/**
 * One leg's current price, taken from the ladder that lists it. The broker's own mark on the basket row
 * is the fallback for the P&L table only - it arrives without a time, and the model refuses a price it
 * cannot date, so pretending otherwise would draw a curve the server never approved.
 *
 * The time is only ever the one the broker put on *this* quote. The ladder's own read time is not it:
 * the model works a leg's remaining maturity from `pricedAt`, so stamping an old trade with a fresh read
 * lengthens the T+0 line's time to expiry and invents a price the server never dated.
 */
function quoteOf(leg: PayoffLeg, chains: readonly (OptionChainData | undefined)[]): {
  price: string;
  pricedAt: string | null;
  quality: string;
  spot: string | null;
} | null {
  const chain = chains.find(item => item?.underlying?.toUpperCase() === leg.underlying?.toUpperCase() && item?.expiry === leg.expiry);
  if (!chain) return null;
  const row = chain.rows.find(item => Number(item.strike) === Number(leg.strike));
  const quote = leg.right === "CE" ? row?.call : row?.put;
  const ltp = Number(quote?.ltp);
  if (!quote || !(ltp > 0)) return null;
  const spotPrice = Number(chain.spot.price);
  return {
    price: ltp.toFixed(2),
    pricedAt: stamped(quote.ltpAt) ?? stamped(quote.quote?.at),
    quality: quote.quote?.quality ?? "unavailable",
    spot: Number.isFinite(spotPrice) && spotPrice > 0 ? spotPrice.toFixed(2) : null,
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** `instrument:v1:NSE:FO:...` - the exchange sits at a fixed offset behind the grammar's own prefix. */
const GRAMMAR = /^instrument:v1:(NSE|BSE):FO:/;

/** Where one leg's price came from: the time the broker stamped it and the state it was stamped in. */
export type LegMark = { contract: string; priceAt: string | null; quality: string };

/** What the model call needs, and - when it cannot be made - the exact reason the screen shows instead. */
export type AnalysisBuild =
  | { body: StrategyAnalysisRequest; margin: MarginRequest | null; marks: LegMark[]; unpriced: [] }
  | { body: null; margin: null; marks: []; unpriced: string[] };

/**
 * The legs are priced off the live ladder, so a basket whose contracts the chain no longer lists is
 * reported rather than drawn: the server model is `extra="forbid"` and 400s on a leg it cannot resolve,
 * which is a better answer than a curve missing a wing.
 */
export function buildAnalysis(basket: Basket, chains: readonly (OptionChainData | undefined)[]): AnalysisBuild {
  const legs = basket.payoffLegs;
  if (!legs.length) return { body: null, margin: null, marks: [], unpriced: ["prod does not know this basket’s contracts exactly"] };
  if (legs.length > 32) return { body: null, margin: null, marks: [], unpriced: ["prod models at most 32 legs in one call"] };

  // The model has one spot axis and no underlying per leg, so a basket built on two indices would be
  // drawn as if both moved together. The web desk refuses the same call; the phone says it in plain words.
  const underlyings = [...new Set(legs.map(leg => leg.underlying).filter(Boolean))];
  if (underlyings.length > 1) {
    return {
      body: null,
      margin: null,
      marks: [],
      unpriced: [`one payoff curve is one index wide, and this basket holds ${underlyings.slice(0, 3).join(", ")}${underlyings.length > 3 ? ", …" : ""}`],
    };
  }

  const answered = chains.filter((chain): chain is OptionChainData => !!chain);
  if (!answered.length) {
    // A date the exchange no longer lists is never asked for, so say which of the two it is: "no ladder
    // read yet" would leave a trader waiting for a curve that cannot exist.
    const dates = payoffExpiries(basket);
    const gone = dates.length > 0 && dates.every(day => ISO.test(day) && day < todayIST());
    return {
      body: null,
      margin: null,
      marks: [],
      unpriced: [gone ? `these legs expired on ${dates[dates.length - 1]}` : `no ladder read for ${legs[0].underlying} yet`],
    };
  }

  const missing: string[] = [];
  const priced: StrategyAnalysisLeg[] = [];
  const marginLegs: MarginRequestLeg[] = [];
  const marks: LegMark[] = [];
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
    marks.push({ contract: `${leg.underlying} ${leg.strike} ${leg.right}`, priceAt: quote.pricedAt, quality: quote.quality });
  }

  if (missing.length) return { body: null, margin: null, marks: [], unpriced: missing };
  if (!spot) return { body: null, margin: null, marks: [], unpriced: ["no underlying price from the broker yet"] };

  return {
    body: { spot, rate, dividend, legs: priced },
    margin: marginLegs.length <= 8 ? { legs: marginLegs } : null,
    marks,
    unpriced: [],
  };
}

/**
 * What the curve was drawn from, in one line the trader can act on: the oldest price the model was
 * given, the state the broker reported it in, and the fact that the model's own figures never subtract
 * the exit costs. A payoff the owner decides on must say whether it is live money or last close.
 */
export function priceProvenance(marks: readonly LegMark[]): string {
  if (!marks.length) return "";
  const dated = marks.filter(mark => mark.priceAt).map(mark => ({ at: Date.parse(mark.priceAt as string), iso: mark.priceAt as string }));
  const state = [...new Set(marks.map(mark => mark.quality))];
  const word = state.length === 1 ? QUALITY_WORD[state[0]] ?? state[0] : "mixed prices";
  const charges = "excludes exit charges";
  if (!dated.length) return `no leg price carries a time · the model assumes the spot right now · ${charges}`;
  const oldest = dated.reduce((best, mark) => (mark.at < best.at ? mark : best));
  // A clock time alone would let last week's close read like this minute, so an older print carries its day.
  const when = `${isTodayIST(oldest.iso) ? "" : `${formatISTDate(oldest.iso)} `}${formatISTTime(oldest.iso)}`;
  const undated = marks.length - dated.length;
  return `priced ${when} IST · ${word}${undated ? ` · ${undated} leg${undated === 1 ? " has" : "s have"} no recorded time` : ""} · ${charges}`;
}
/**
 * The two curves the chart draws, paired with their strikes, plus where the basket sits right now.
 * `today` is absent whenever the model could not calibrate, and the screen says so rather than passing
 * the expiry line off as a current value.
 *
 * `booked` is the money the already-exited units of this basket made. The model curves only what is still
 * open, so without the shift the chart and the Total P&L above it are two different answers to the same
 * question; adding it makes the line the trader reads be the whole basket's outcome.
 */
export function curves(analysis: {
  spot: string;
  curve: { spots: number[]; expiry: number[] | null; today: number[] | null };
}, booked = 0): { spots: number[]; expiry: number[] | null; today: number[] | null; atSpot: number | null; atSpotToday: number | null } | null {
  const spots = analysis.curve.spots ?? [];
  if (spots.length < 3) return null;
  const now = Number(analysis.spot);
  const move = (values: number[] | null): number[] | null => (values ? values.map(value => value + booked) : null);
  const at = (values: number[] | null): number | null => {
    const value = valueAt(spots, values, now);
    return value === null ? null : value + booked;
  };
  return {
    spots,
    expiry: move(analysis.curve.expiry),
    today: move(analysis.curve.today),
    atSpot: at(analysis.curve.expiry),
    atSpotToday: at(analysis.curve.today),
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

/** The spot levels where a gridded curve crosses a level, read between the samples rather than nearest.
 *  Finding #4: Also searches the linear tails beyond the first and last grid points, where the payoff
 *  continues as a straight line — a long call at strike 100 with premium 10 breaks even at 110, which
 *  may lie beyond the last displayed grid point. */
function crossedAt(spots: readonly number[], values: readonly number[], level: number): number[] {
  const out: number[] = [];
  // Left tail: the payoff is linear before the first sample. If the first two samples straddle the level,
  // the crossing may lie to the left of spots[0].
  const fromLeft = values[0]! - level;
  const toLeft = values[1]! - level;
  if (Number.isFinite(fromLeft) && Number.isFinite(toLeft) && fromLeft !== 0 && fromLeft * toLeft < 0) {
    const span = spots[1]! - spots[0]!;
    if (span > 0) {
      const crossing = spots[0]! + (span * -fromLeft) / (toLeft - fromLeft);
      if (crossing < spots[0]!) out.push(crossing);
    }
  }
  // Interior segments.
  for (let i = 1; i < spots.length; i += 1) {
    const from = values[i - 1]! - level;
    const to = values[i]! - level;
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (from === 0) out.push(spots[i - 1]!);
    else if (from * to < 0) out.push(spots[i - 1]! + ((spots[i]! - spots[i - 1]!) * -from) / (to - from));
  }
  // Right tail: the payoff is linear after the last sample. If the last two samples straddle the level,
  // the crossing may lie beyond spots[last].
  const n = spots.length;
  const fromRight = values[n - 2]! - level;
  const toRight = values[n - 1]! - level;
  if (Number.isFinite(fromRight) && Number.isFinite(toRight) && toRight !== 0 && fromRight * toRight < 0) {
    const span = spots[n - 1]! - spots[n - 2]!;
    if (span > 0) {
      const crossing = spots[n - 1]! + (span * -toRight) / (toRight - fromRight);
      if (crossing > spots[n - 1]!) out.push(crossing);
    }
  }
  return [...new Set(out.map(value => Math.round(value * 100) / 100))];
}

/** The exact expiry payoff of a held basket, sampled on the phone's own grid. */
export interface HeldPayoff {
  spots: number[];
  values: number[];
  breakEvens: number[];
  /** Rupees paid to put the open units on (positive) or received for them (negative), at their entry premiums. */
  netDebit: number;
  /** Best and worst at expiry, or null when the curve keeps running off the edge of the book. */
  max: number | null;
  min: number | null;
  legs: number;
}

/**
 * The payoff at expiry of exactly what the broker holds, from the leg table alone.
 *
 * A bought leg pays its premium and takes intrinsic back; a sold leg keeps its premium and owes the
 * intrinsic. Both are arithmetic on numbers `/v1/baskets` already sent - strike, right, side, entry
 * premium, lots, lot size - so this line needs no ladder, no implied volatility and no model call, and it
 * is on screen the moment the basket opens. The server's model then adds the T+0 line to the same card.
 *
 * Outside the outer strikes the payoff is one straight line, so a grid that spans the held strikes plus
 * five steps each side carries every kink, and its zero crossings are the true break-evens. A tail still
 * climbing at the edge is reported as unlimited rather than as the last sample, which would be a number
 * the trader could mistake for the most the basket can make.
 *
 * `booked` is the money the already-exited units made: the trader decides on the whole trade, so the line
 * is drawn from the same total the card above it prints.
 */
export function heldPayoff(basket: Basket, booked = 0): HeldPayoff | null {
  if (!basket.payoffLegs.length) return null;

  // Finding #10: Validate the same single-underlying and single-expiry constraints buildAnalysis enforces.
  // Return no exact local curve when either constraint is violated.
  const underlyings = [...new Set(basket.payoffLegs.map(leg => leg.underlying).filter(Boolean))];
  const expiries = [...new Set(basket.payoffLegs.map(leg => leg.expiry).filter(Boolean))];
  if (underlyings.length > 1 || expiries.length > 1) return null;

  // Finding #6: Reconcile quantities using the exact held contract. A fully exited leg must contribute
  // no remaining intrinsic value. Build a map from instrumentId -> remaining quantity from broker legs.
  const heldQtyMap = new Map<string, number>();
  for (const leg of basket.legs) {
    const remaining = Math.max(0, (leg.lots ?? 0) - closedUnits(leg));
    heldQtyMap.set(leg.instrumentId, remaining * leg.lotSize);
  }

  const lines = basket.payoffLegs.map(leg => {
    const payoffQty = leg.lots * leg.lotSize;
    const heldQty = heldQtyMap.get(leg.instrumentId);
    // Use the smaller of payoff-record quantity and broker-held quantity, so a fully exited leg contributes zero.
    const qty = (heldQty !== undefined && heldQty >= 0) ? Math.min(payoffQty, heldQty) : payoffQty;
    return {
      strike: Number(leg.strike),
      right: leg.right,
      sign: leg.action === "buy" ? 1 : -1,
      premium: Number(leg.entryPrice),
      qty,
    };
  });
  if (!lines.length || lines.some(leg => !Number.isFinite(leg.strike) || !(leg.premium > 0) || !(leg.qty > 0))) return null;

  const strikes = [...new Set(lines.map(leg => leg.strike))].sort((a, b) => a - b);
  const gaps = strikes.slice(1).map((strike, index) => strike - strikes[index]!).filter(gap => gap > 0);
  const step = gaps.length ? Math.min(...gaps) : Math.max(1, Math.round(strikes[0]! * 0.01));
  const low = Math.max(step, strikes[0]! - 5 * step);
  const high = strikes[strikes.length - 1]! + 5 * step;
  // Uniform samples for the shape, then every held strike as an anchor, so no kink falls between samples.
  const spots = [...new Set([
    ...Array.from({ length: 41 }, (_, index) => low + ((high - low) * index) / 40),
    ...strikes,
  ])].sort((a, b) => a - b).map(value => Math.round(value * 100) / 100);
  const values = spots.map(spot =>
    lines.reduce((sum, leg) => sum + leg.sign * ((leg.right === "CE" ? Math.max(spot - leg.strike, 0) : Math.max(leg.strike - spot, 0)) - leg.premium) * leg.qty, 0) + booked);

  // Half a paisa sits far below the smallest real slope over one step (a step times a lot) and far above
  // the rounding noise of decimal premiums multiplied out by a lot size.
  const FLAT = 0.005;
  const left = values[1]! - values[0]!;
  const right = values[values.length - 1]! - values[values.length - 2]!;

  // Finding #11: Treat spot zero as the finite lower bound for put payoff calculations.
  // The right tail: if slope is non-flat, the curve keeps running in that direction.
  const rightUnboundedProfit = right > FLAT;
  const rightUnboundedLoss = right < -FLAT;
  // The left tail: calculate the actual value at spot zero (the finite lower bound for puts).
  const valueAtZero = lines.reduce((sum, leg) => {
    const intrinsicAtZero = leg.right === "PE" ? leg.strike : 0;
    return sum + leg.sign * (intrinsicAtZero - leg.premium) * leg.qty;
  }, 0) + booked;
  // If the left edge is climbing (left > FLAT), the value increases toward the interior — bounded above on this side.
  // If the left edge is falling (left < -FLAT), the value at the leftmost sample is higher than at zero — bounded below.
  // The left tail is only "unbounded" if the value at zero would exceed the interior max/min.
  const leftUnboundedProfit = left < -FLAT && valueAtZero > Math.max(...values);
  const leftUnboundedLoss = left > FLAT && valueAtZero < Math.min(...values);

  const unboundedProfit = rightUnboundedProfit || leftUnboundedProfit;
  const unboundedLoss = rightUnboundedLoss || leftUnboundedLoss;

  return {
    spots,
    values,
    breakEvens: crossedAt(spots, values, 0),
    netDebit: lines.reduce((sum, leg) => sum + leg.sign * leg.premium * leg.qty, 0),
    max: unboundedProfit ? null : Math.max(...values),
    min: unboundedLoss ? null : Math.min(...values),
    legs: lines.length,
  };
}

/**
 * Everything the figures row prints, resolved to text or to the server's own reason. A label is never
 * paired with a blank: `Unavailable` only appears with the words prod gave for why.
 *
 * `basketExpiry` is the date the curve was drawn for, which the phone already read off the legs. Prod
 * leaves `settlement` empty for a single-expiry basket, and "expires at the basket's own date" would be
 * a placeholder in front of a trader who can see the date on the card above it.
 *
 * `booked` shifts the limits and the break-evens onto the whole basket, because the trader is deciding on
 * the trade they are in, not on the half of it that is still open.
 */
export function payoffFigures(analysis: {
  expiry: { available: boolean; reason?: string; maxProfit?: string | null; maxProfitUnbounded?: boolean;
    maxLoss?: string | null; maxLossUnbounded?: boolean; breakevens?: string[]; netDebit?: string;
    basis?: string; settlement?: string };
  curve?: { spots: number[]; expiry: number[] | null } | null;
  pop: { available: true; value: number; basis: string } | { available: false; reason: string };
  greeks: { available: true; delta: number; theta: number; vega: number; gamma: number; ivPct: number } | { available: false; reason: string };
  assumptions: { ratePct: number; dividendPct: number };
}, basketExpiry: string | null = null, booked = 0): Record<string, string> {
  const { expiry, pop, greeks } = analysis;
  const debit = Number(expiry.netDebit);
  // Finding #5: Treat null and blank values as unknown before parsing. Number(null) is 0, which would
  // silently add booked P&L to a zero limit and print a wrong number. Only finite limits get the shift.
  const limit = (value: string | null | undefined) => {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? rupees(parsed + booked) : null;
  };
  // The server's roots are for the open half alone; once the exited money is added the whole basket
  // breaks even where the open curve reaches the negative of it.
  const breakEvens = booked && analysis.curve?.expiry
    ? crossedAt(analysis.curve.spots, analysis.curve.expiry, -booked)
    : (expiry.breakevens ?? []).map(value => Number(value)).filter(Number.isFinite);
  const until = expiry.settlement ?? basketExpiry;
  return {
    horizon: expiry.basis === "front-expiry"
      ? `Front expiry · settles ${until ?? "the earlier date"}`
      : until ? `Expires ${until}` : "Expires at the basket’s own date",
    maxProfit: !expiry.available ? expiry.reason ?? "The server could not price this basket’s limits"
      : expiry.maxProfitUnbounded ? "Unlimited" : limit(expiry.maxProfit) ?? "Not stated by the server",
    maxLoss: !expiry.available ? expiry.reason ?? "The server could not price this basket’s limits"
      : expiry.maxLossUnbounded ? "Unlimited - one side is naked" : limit(expiry.maxLoss) ?? "Not stated by the server",
    pop: pop.available === false ? pop.reason
      : `${(pop.value * 100).toFixed(2)}% · ${pop.basis}${booked ? " · open legs" : ""}`,
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
