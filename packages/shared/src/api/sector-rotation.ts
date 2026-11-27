/**
 * Sector rotation and stock buildup, as the phone reads them.
 *
 * `GET /v1/sector-rotation` is one body holding every period the web desk shows: `windows` keyed by sessions
 * back ("1", "3", "5", "21"), each with its sector rows, the constituents under each sector, and the regime the
 * scored sectors add up to. It is stored end-of-day F&O rather than a live feed, so one read carries this whole
 * screen and switching 1D → 1M costs nothing on the network.
 *
 * Two rules come from the route rather than from taste. A sector the server could not score is still listed,
 * with the reason its own counts give or the sentence it sent in `unavailable` — a card that reads "—" over
 * nothing tells a trader less than one that says why. And a figure the server did not send stays a dash, never
 * a zero, so the phone and the web desk cannot disagree about the same sector.
 *
 * `/v1/sector-rotation/prices` (intraday index levels) is deliberately not read here: it needs a second
 * entitlement, and a screen about stored end-of-day flow that mixed in a live price would have to explain which
 * of its numbers were which.
 */

import type { SortColumn } from "./table-sort";

/** The five buildup states prod files each constituent under. "N" is neutral, not unknown. */
export type State = "LBU" | "SC" | "LU" | "SBU" | "N";
export const STATES: readonly State[] = ["LBU", "SC", "LU", "SBU", "N"];
/** The state in the words the web desk uses, so one screen's "long buildup" is not another's "accumulation". */
export const STATE_NAME: Record<State, string> = {
  LBU: "Long buildup", SC: "Short covering", LU: "Long unwinding", SBU: "Short buildup", N: "Neutral",
};
/** The code drawn in a constituent row's pill, where the full phrase will not fit. The screen prints a legend. */
export const STATE_CODE: Record<State, string> = { LBU: "LBU", SC: "SC", LU: "LU", SBU: "SBU", N: "N" };
/** What each state means in price and open interest, for the legend line under the table. */
export const STATE_HELP: Record<State, string> = {
  LBU: "price up, open interest up: new longs",
  SC: "price up, open interest down: shorts closing",
  LU: "price down, open interest down: longs closing",
  SBU: "price down, open interest up: new shorts",
  N: "price and open interest barely moved",
};
/** The same read in the fewest words that still mean something, for the line under a row's pill. */
export const STATE_SHORT: Record<State, string> = {
  LBU: "new longs", SC: "shorts close", LU: "longs close", SBU: "new shorts", N: "little moved",
};
/** Bullish to bearish: the order one tap on the Buildup heading puts on screen. */
export const STATE_ORDER: Record<State, number> = { LBU: 0, SC: 1, N: 2, LU: 3, SBU: 4 };

/** The six card colours the web desk bands SMFI into, strongest inflow to strongest outflow. */
export const TIERS = ["strong-up", "up", "mild-up", "flat", "down", "strong-down"] as const;
export type Tier = (typeof TIERS)[number];
export const TIER_NAME: Record<Tier, string> = {
  "strong-up": "Strong bullish", up: "Bullish", "mild-up": "Mild bullish",
  flat: "Neutral", down: "Bearish", "strong-down": "Strong bearish",
};
/** SMFI bands over the -100..+100 score. Under `mild` either way is neutral; `strong` is the dark end. */
export const TIER_LIMITS = { mild: 8, mid: 25, strong: 50 } as const;

/** The score decides the band, exactly as the web desk's `tierOf` does. */
export function tierOf(smfi: number | null | undefined): Tier {
  if (smfi === null || smfi === undefined || !Number.isFinite(smfi) || Math.abs(smfi) < TIER_LIMITS.mild) return "flat";
  if (smfi > 0) return smfi >= TIER_LIMITS.strong ? "strong-up" : smfi >= TIER_LIMITS.mid ? "up" : "mild-up";
  return smfi <= -TIER_LIMITS.strong ? "strong-down" : "down";
}

/** Gain, loss, nowhere — or muted, which is the server having sent no figure at all. */
export type CellTone = "up" | "down" | "flat" | "muted";
export function figureTone(value: number | null | undefined): CellTone {
  if (value === null || value === undefined || !Number.isFinite(value)) return "muted";
  return value > 0 ? "up" : value < 0 ? "down" : "flat";
}

/**
 * The period control: sessions back the score compares with, its label, and how the screen says the span out.
 * The keys are the server's own `windows` keys, so choosing one is a lookup rather than a translation.
 */
export const PERIODS = [
  { key: "1", label: "1D", sessions: 1 },
  { key: "3", label: "3D", sessions: 3 },
  { key: "5", label: "1W", sessions: 5 },
  { key: "21", label: "1M", sessions: 21 },
] as const;
export type PeriodKey = (typeof PERIODS)[number]["key"];

/** One constituent, field for field as `services/sector_rotation.py::stock_row` files it. */
export interface SectorStock {
  symbol: string;
  price: number | null;
  priceChgPct: number | null;
  openInterest: number | null;
  oiChgPct: number | null;
  oiValue: number | null;
  weekChgPct: number | null;
  monthChgPct: number | null;
  rvol: number | null;
  deliveryPct: number | null;
  lotSize?: number | null;
  corporateActionSuspected: boolean;
  state: State | null;
}

export interface SectorCounts { LBU: number; SC: number; LU: number; SBU: number; N: number }
export interface SectorParts { buildup: number; breadth: number; price: number }

/** A sector the score was computed for. `stocks`/`scored`/`excluded` are prod's own counts. */
export interface Sector {
  key: string;
  name: string;
  indexName: string;
  members: number;
  covered: number;
  counts: SectorCounts;
  stocks: number;
  scored: number;
  excluded: number;
  smfi: number | null;
  parts: SectorParts | null;
  breadthPct: number | null;
  priceChgPct: number | null;
  oiChgPct: number | null;
  oiValue: number | null;
  state: State | null;
  oiSharePct?: number | null;
}

/** A sector whose NSE constituent list could not be read, in the server's own sentence. */
export interface UnreadableSector { key: string; name: string; unavailable: string }

export interface SectorRegime {
  label: string | null;
  advancing: number;
  declining: number;
  adRatio: number | null;
  oiValueCrore: number | null;
}

export interface OpenWindow {
  available: true;
  baseDay: string;
  expiriesInWindow?: string[];
  sectors: (Sector | UnreadableSector)[];
  stocks: Record<string, SectorStock[]>;
  constituents?: Record<string, string[]>;
  regime: SectorRegime;
}

/** A period with too few stored sessions for buildup. The reason is the server's sentence. */
export interface ClosedWindow { available: false; reason: string }
export type WindowView = OpenWindow | ClosedWindow;

export interface SectorRotationBody {
  asOf: string;
  datasetVersion?: string;
  sources?: string[];
  notes?: string[];
  windows?: Record<string, WindowView | undefined>;
}

/** A sector listed without a score, and the reason the screen prints beside it. */
export interface SilentSector { key: string; name: string; reason: string }

export const isSector = (row: Sector | UnreadableSector): row is Sector => "smfi" in row;

/** The chosen period's view, or null when prod did not answer that window at all. */
export function windowOf(body: SectorRotationBody | null | undefined, period: string): WindowView | null {
  return body?.windows?.[period] ?? null;
}

/**
 * Why a sector prod listed has no score, from the counts it sent.
 *
 * `aggregate` returns a null SMFI when no constituent had both a state and an open interest value, and an
 * empty `covered` when the constituent list was readable but nothing in it has stored futures — two different
 * absences a trader needs told apart, since one is a data gap and the other is a quiet sector.
 */
export function unscoredReason(row: Sector): string {
  if (row.covered === 0) {
    return row.members > 0
      ? `NSE lists ${row.members} stocks in this sector, but none has stored futures data.`
      : "NSE published no constituents for this index on the stored session.";
  }
  return `${row.covered} futures stocks were read, but none had both a price move and open interest to score.`;
}

/**
 * The board: sectors the score was computed for, strongest inflow first, then the ones it was not.
 *
 * The ranked order is the web leaderboard's (SMFI descending, nulls dropped) and the silent ones keep their
 * reasons, so a phone and a laptop showing the same session list the same sectors in the same order.
 */
export function sectorBoard(view: WindowView | null): { ranked: Sector[]; silent: SilentSector[] } {
  if (!view || view.available !== true) return { ranked: [], silent: [] };
  const ranked: Sector[] = [];
  const silent: SilentSector[] = [];
  for (const row of view.sectors) {
    if (!isSector(row)) {
      silent.push({ key: row.key, name: row.name, reason: row.unavailable });
    } else if (row.smfi === null) {
      silent.push({ key: row.key, name: row.name, reason: unscoredReason(row) });
    } else {
      ranked.push(row);
    }
  }
  ranked.sort((a, b) => (b.smfi ?? 0) - (a.smfi ?? 0));
  silent.sort((a, b) => a.name.localeCompare(b.name));
  return { ranked, silent };
}

/** The constituents under one sector, in the order prod sent them (biggest futures book first). */
export function stocksOf(view: WindowView | null, key: string | null): SectorStock[] {
  if (!view || view.available !== true || !key) return [];
  return view.stocks[key] ?? [];
}

/** Bullish, bearish and neutral constituents — the split a sector card draws its bar from. */
export function buildupSplit(counts: SectorCounts | null | undefined): { bull: number; bear: number; flat: number } {
  if (!counts) return { bull: 0, bear: 0, flat: 0 };
  return { bull: counts.LBU + counts.SC, bear: counts.LU + counts.SBU, flat: counts.N };
}

/** The card's one-line read of its constituents: what the stocks are doing, in words. */
export function buildupLine(counts: SectorCounts | null | undefined): string {
  const { bull, bear, flat } = buildupSplit(counts);
  const total = bull + bear + flat;
  if (!total) return "No constituent scored";
  return `${bull} bullish · ${bear} bearish · ${flat} neutral`;
}

/** SMFI as the desk prints it: "+34.2", "-6.1", or a dash when there is no score. */
export function smfiWord(smfi: number | null | undefined): string {
  if (smfi === null || smfi === undefined || !Number.isFinite(smfi)) return "—";
  return `${smfi > 0 ? "+" : ""}${smfi.toFixed(1)}`;
}

/** A percentage that carries its sign: "+1.6%", "-2.3%", "0.0%", or a dash when the server sent nothing. */
export function signedPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const rounded = Number(value.toFixed(digits));
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(digits)}%`;
}

/** A ratio with no direction, beside a figure that has one. */
export function timesWord(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}×`;
}

/** A price: "₹1,482.30", or a dash. The grouping is Indian, the way every other rupee figure in the app reads. */
export function priceWord(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `₹${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * A rupee amount at the scale a trader can read: "₹1,204 Cr", "₹18.5 L", "₹9,400".
 *
 * Open interest value is rupees summed across every expiry, which is seven figures on a large-cap name and
 * unreadable in a table cell. Below a lakh the amount stays exact, because rounding ₹9,400 to "0.09 L" hides
 * the fact that the server had a number at all.
 */
export function moneyWord(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toLocaleString("en-IN", { minimumFractionDigits: abs >= 1e9 ? 0 : 1, maximumFractionDigits: abs >= 1e9 ? 0 : 1 })} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(1)} L`;
  return `${sign}₹${Math.round(abs).toLocaleString("en-IN")}`;
}

/** A count of shares or contracts at the same scale: "1.24 Cr", "18.5 L", "9,400". */
export function countWord(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(1)} L`;
  return `${sign}${Math.round(abs).toLocaleString("en-IN")}`;
}

/**
 * A stored session day ("2026-11-26") as "26 Nov 2026".
 *
 * Read from the string rather than through Date: the server sends an exchange session, not a moment, and a
 * device in another timezone must not be able to move yesterday's session to the day before it.
 */
export function sessionDayWord(iso: string | null | undefined): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? "").trim());
  if (!parts) return "the stored session";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = Number(parts[2]);
  if (month < 1 || month > 12) return "the stored session";
  return `${Number(parts[3])} ${months[month - 1]} ${parts[1]}`;
}

/**
 * The regime sentence: the market-wide read the scored sectors add up to.
 *
 * `adRatio` is null when nothing declined, which is the best breadth possible rather than an absence, and the
 * server says so with null — so the line names the advancing and declining counts and only adds the ratio when
 * it exists.
 */
export function regimeLine(view: WindowView | null): string {
  if (!view || view.available !== true) return "";
  const { regime } = view;
  const parts = [
    `Regime: ${regime.label ?? "not called"}`,
    `${regime.advancing} advancing / ${regime.declining} declining`,
  ];
  if (regime.adRatio !== null && regime.adRatio !== undefined) parts.push(`${regime.adRatio.toFixed(1)}x A/D`);
  if (regime.oiValueCrore !== null && regime.oiValueCrore !== undefined) {
    parts.push(`₹${regime.oiValueCrore.toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr futures OI`);
  }
  return parts.join(" · ");
}

/** The span one board is measuring, in words the screen can print above it. */
export function windowSpan(view: WindowView | null, asOf: string | null | undefined, period: PeriodKey): string {
  if (!view || view.available !== true) return "";
  const sessions = PERIODS.find(entry => entry.key === period)?.sessions ?? Number(period);
  return `End-of-day ${sessions} session${sessions === 1 ? "" : "s"} · ${sessionDayWord(view.baseDay)} to ${sessionDayWord(asOf)}`;
}

/** Why an expiry inside the window makes the states lean one way — the server's own caution, worded once. */
export function expiryCaution(view: WindowView | null): string {
  if (!view || view.available !== true) return "";
  const settled = (view.expiriesInWindow ?? []).filter(Boolean);
  if (settled.length === 0) return "";
  return `Monthly expiry ${settled.map(sessionDayWord).join(", ")} settles inside this window, so open interest falls on its own: read covering and unwinding with care.`;
}

/** A row's buildup pill: the code it shows, what it means, and which way it leans. */
export interface BuildupCell { code: string; name: string; short: string; side: "bull" | "bear" | "flat" | "none" }

/**
 * What a constituent's buildup cell says.
 *
 * A null state has two causes prod distinguishes, and the cell must too: a suspected split (the server sets
 * `corporateActionSuspected` and withholds the state) or a move inside the noise floors. Only the first has a
 * word of its own; a plain "N" is the server's own neutral, not an absence.
 */
export function buildupCell(row: SectorStock): BuildupCell {
  if (row.state === null) {
    return row.corporateActionSuspected
      ? { code: "Split?", name: "Moved over 25% in the window: excluded as a probable split, bonus or demerger", short: "probable split", side: "none" }
      : { code: "—", name: "No readable price move or open interest", short: "not scored", side: "none" };
  }
  return {
    code: STATE_CODE[row.state],
    name: STATE_NAME[row.state],
    short: STATE_SHORT[row.state],
    side: row.state === "LBU" || row.state === "SC" ? "bull" : row.state === "LU" || row.state === "SBU" ? "bear" : "flat",
  };
}

/**
 * The constituent table's headings, left to right, each carrying the figure a tap sorts by.
 *
 * Widths are dp and each figure column is as wide as the widest string it can print — a four-digit price with
 * two decimals, a "1M +11.7%" look-back, a "₹60,000 Cr" position — because a cell that does not fit ellipsises a
 * number instead of rounding it. The stock column is the one that gives way: it is flexible, and a symbol only
 * has to stay readable, not exact.
 */
export const STOCK_COLUMNS: readonly SortColumn<SectorStock>[] = [
  { key: "symbol", label: "Stock", width: 60, value: row => row.symbol },
  { key: "price", label: "Last ₹", width: 54, numeric: true, value: row => row.price },
  { key: "priceChgPct", label: "Price chg", width: 52, numeric: true, value: row => row.priceChgPct },
  { key: "oiChgPct", label: "OI chg", width: 52, numeric: true, value: row => row.oiChgPct },
  { key: "rvol", label: "RVOL", width: 50, numeric: true, value: row => row.rvol },
  {
    key: "state", label: "Buildup", width: 60,
    // Text rather than numeric so the first tap sorts bullish-to-bearish, which is STATE_ORDER's own direction.
    value: row => (row.state === null ? null : STATE_ORDER[row.state]),
  },
];

/** One constituent cell: the figure, the small line under it, and whether the figure has a direction. */
export interface StockCell { text: string; sub: string; tone: CellTone }

/**
 * What a constituent row shows in one column.
 *
 * The formatting lives here rather than in the screen so the phone and any later surface print the same
 * figures the same way, and so a test can pin a cell without rendering it. Every small line is self-labelled
 * ("1W", "1M", "% dly") because two figures stacked in one 50-point column are otherwise indistinguishable.
 */
export function stockCell(row: SectorStock, key: string): StockCell {
  if (key === "symbol") return { text: row.symbol, sub: `${countWord(row.openInterest)} sh open`, tone: "muted" };
  if (key === "price") return { text: priceWord(row.price), sub: `1W ${signedPct(row.weekChgPct)}`, tone: "muted" };
  if (key === "priceChgPct") return { text: signedPct(row.priceChgPct), sub: `1M ${signedPct(row.monthChgPct)}`, tone: figureTone(row.priceChgPct) };
  if (key === "oiChgPct") return { text: signedPct(row.oiChgPct), sub: moneyWord(row.oiValue), tone: figureTone(row.oiChgPct) };
  if (key === "rvol") {
    const delivery = row.deliveryPct === null || row.deliveryPct === undefined || !Number.isFinite(row.deliveryPct)
      ? "no delivery" : `${row.deliveryPct.toFixed(0)}% dly`;
    return { text: timesWord(row.rvol), sub: delivery, tone: "muted" };
  }
  const buildup = buildupCell(row);
  return {
    text: buildup.code,
    sub: buildup.short,
    tone: buildup.side === "bull" ? "up" : buildup.side === "bear" ? "down" : buildup.side === "flat" ? "flat" : "muted",
  };
}

/** A sector's own buildup word, or which of the two changes the server was missing when it has none. */
export function sectorStateWord(row: Sector): string {
  if (row.state !== null) return STATE_NAME[row.state];
  return row.oiChgPct === null ? "Open-interest change unknown" : "Price change unknown";
}

/** The figures beside a card's score: the index's own move, its open-interest change, and its share of the market's OI. */
export function sectorFigures(row: Sector): string {
  const parts = [`${signedPct(row.priceChgPct)} index`, `${signedPct(row.oiChgPct)} OI`];
  if (row.oiSharePct !== null && row.oiSharePct !== undefined) parts.push(`${row.oiSharePct.toFixed(1)}% of OI`);
  return parts.join(" · ");
}

/** A sector's own coverage, in the server's counts: how many listed constituents the score could read. */
export function sectorCoverage(row: Sector): string {
  return `${row.scored} of ${row.members} listed scored`;
}

/** Prod's plan refusal, dataset refusal or network failure — as one sentence the screen can print. */
export function sectorRotationReason(error: unknown, fallback = "Sector rotation could not be read."): string {
  const details = (error as { details?: unknown } | null)?.details;
  if (details && typeof details === "object") {
    for (const key of ["detail", "message"] as const) {
      const text = (details as Record<string, unknown>)[key];
      if (typeof text === "string" && text.trim()) return text.trim();
    }
  }
  const message = (error as Error | null)?.message;
  return message && !/^HTTP \d{3}/.test(message) ? message : fallback;
}
