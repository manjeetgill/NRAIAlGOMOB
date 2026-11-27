import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PERIODS,
  STOCK_COLUMNS,
  buildupCell,
  buildupLine,
  buildupSplit,
  countWord,
  expiryCaution,
  isSector,
  moneyWord,
  priceWord,
  regimeLine,
  sectorBoard,
  sectorCoverage,
  sectorFigures,
  sectorRotationReason,
  sectorStateWord,
  sessionDayWord,
  smfiWord,
  stockCell,
  stocksOf,
  tierOf,
  timesWord,
  unscoredReason,
  windowOf,
  windowSpan,
  signedPct,
  type OpenWindow,
  type Sector,
  type SectorStock,
  type UnreadableSector,
} from "../../packages/shared/src/api/sector-rotation.ts";
import { nextSort, sortRows } from "../../packages/shared/src/api/table-sort.ts";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const client = read("packages/shared/src/api/hooks.ts");
const barrel = read("packages/shared/src/api/index.ts");
const screen = read("apps/mobile/app/sector-rotation.tsx");
const prefetch = read("apps/mobile/src/utils/prefetch.ts");
const more = read("apps/mobile/app/(tabs)/more.tsx");

/**
 * The sector board and the buildup inside it, on the phone.
 *
 * Prod stores an end-of-day F&O dataset and answers `GET /v1/sector-rotation` with one body holding all four
 * periods, every sector's money-flow score and each sector's constituents. These cases keep the phone a reader
 * of that body: the web desk's ranking and bands, the server's own reasons where a sector could not be scored,
 * and a dash wherever the archive has no figure rather than an invented zero.
 */

const sector = (over: Partial<Sector> = {}): Sector => ({
  key: "auto", name: "Auto", indexName: "Nifty Auto", members: 41, covered: 38,
  counts: { LBU: 8, SC: 3, LU: 5, SBU: 2, N: 20 }, stocks: 38, scored: 34, excluded: 4,
  smfi: 12.5, parts: { buildup: 40, breadth: 35, price: 25 }, breadthPct: 71,
  priceChgPct: 1.4, oiChgPct: -2.1, oiValue: 8.4e10, state: "LBU", oiSharePct: 8.4,
  ...over,
});

const stock = (over: Partial<SectorStock> = {}): SectorStock => ({
  symbol: "HEROMOTOCO", price: 1482.3, priceChgPct: 1.6, openInterest: 1.24e7, oiChgPct: -3.4,
  oiValue: 1.204e10, weekChgPct: 2.4, monthChgPct: -3.2, rvol: 1.8, deliveryPct: 62,
  lotSize: 175, corporateActionSuspected: false, state: "LBU", ...over,
});

const open = (
  sectors: (Sector | UnreadableSector)[],
  stocks: Record<string, SectorStock[]> = {},
  over: Partial<OpenWindow> = {},
): OpenWindow => ({
  available: true, baseDay: "2026-11-24", expiriesInWindow: [], sectors, stocks,
  regime: { label: "Risk-on", advancing: 12, declining: 6, adRatio: 2, oiValueCrore: 84120 },
  ...over,
});

describe("the board is the web desk's ranking, with a reason on every gap", () => {
  it("orders scored sectors by money-flow score, strongest inflow first", () => {
    const board = sectorBoard(open([sector({ key: "metal", smfi: -40 }), sector({ key: "pharma", smfi: 55 }), sector({ key: "auto", smfi: 12 })]));
    expect(board.ranked.map(row => row.key)).toEqual(["pharma", "auto", "metal"]);
    expect(board.silent).toEqual([]);
  });

  it("separates a sector the score could not be computed for and says why from its own counts", () => {
    const board = sectorBoard(open([sector({ key: "fmcg", name: "FMCG", smfi: null, covered: 0, members: 21 })]));
    expect(board.ranked).toEqual([]);
    expect(board.silent).toEqual([{
      key: "fmcg", name: "FMCG", reason: "NSE lists 21 stocks in this sector, but none has stored futures data.",
    }]);
    expect(unscoredReason(sector({ covered: 0, members: 0 }))).toBe("NSE published no constituents for this index on the stored session.");
    expect(unscoredReason(sector({ covered: 30 }))).toBe("30 futures stocks were read, but none had both a price move and open interest to score.");
  });

  it("keeps the server's sentence for a sector whose constituent list it could not read", () => {
    const board = sectorBoard(open([
      { key: "realty", name: "Realty", unavailable: "No NSE index for this sector in the stored dataset." },
      sector({ key: "auto", smfi: null, covered: 0, members: 0, name: "Auto" }),
    ]));
    expect(board.silent.map(row => row.name)).toEqual(["Auto", "Realty"]);
    expect(board.silent[1].reason).toBe("No NSE index for this sector in the stored dataset.");
    expect(isSector({ key: "realty", name: "Realty", unavailable: "x" })).toBe(false);
  });

  it("yields nothing for a period the server closed and for no body at all", () => {
    expect(sectorBoard({ available: false, reason: "only 2 sessions stored" })).toEqual({ ranked: [], silent: [] });
    expect(sectorBoard(null)).toEqual({ ranked: [], silent: [] });
    expect(stocksOf({ available: false, reason: "x" }, "auto")).toEqual([]);
    expect(stocksOf(null, null)).toEqual([]);
  });
});

describe("one body answers all four periods, so switching never reads again", () => {
  it("uses the server's own window keys and the desk's own labels", () => {
    expect(PERIODS.map(period => period.key)).toEqual(["1", "3", "5", "21"]);
    expect(PERIODS.map(period => period.label)).toEqual(["1D", "3D", "1W", "1M"]);
    expect(PERIODS.map(period => period.sessions)).toEqual([1, 3, 5, 21]);
  });

  it("finds the chosen window and reports a missing one as absent rather than empty", () => {
    const body = { asOf: "2026-11-26", windows: { "1": open([sector()]), "3": { available: false as const, reason: "too few sessions" } } };
    expect(windowOf(body, "1")?.available).toBe(true);
    expect(windowOf(body, "3")).toEqual({ available: false, reason: "too few sessions" });
    expect(windowOf(body, "21")).toBeNull();
    expect(windowOf(null, "1")).toBeNull();
  });

  it("reads the constituents under the chosen sector in the order prod sent them", () => {
    const view = open([sector()], { auto: [stock({ symbol: "MOTHER" }), stock({ symbol: "MARUTI" })] });
    expect(stocksOf(view, "auto").map(row => row.symbol)).toEqual(["MOTHER", "MARUTI"]);
    expect(stocksOf(view, "it").length).toBe(0);
  });

  it("says the span a board measures, singular for one session", () => {
    const view = open([sector()]);
    expect(windowSpan(view, "2026-11-26", "1")).toBe("End-of-day 1 session · 24 Nov 2026 to 26 Nov 2026");
    expect(windowSpan(view, "2026-11-26", "21")).toBe("End-of-day 21 sessions · 24 Nov 2026 to 26 Nov 2026");
    expect(windowSpan({ available: false, reason: "x" }, "2026-11-26", "1")).toBe("");
    expect(windowSpan(null, "2026-11-26", "1")).toBe("");
  });
});

describe("a buildup cell says what the server filed, and admits what it withheld", () => {
  it("names each state and which way it leans", () => {
    expect(buildupCell(stock({ state: "LBU" }))).toEqual({ code: "LBU", name: "Long buildup", short: "new longs", side: "bull" });
    expect(buildupCell(stock({ state: "SC" })).side).toBe("bull");
    expect(buildupCell(stock({ state: "LU" })).side).toBe("bear");
    expect(buildupCell(stock({ state: "SBU" })).side).toBe("bear");
    expect(buildupCell(stock({ state: "N" })).side).toBe("flat");
  });

  it("tells a suspected split apart from a move inside the noise floors", () => {
    const split = buildupCell(stock({ state: null, corporateActionSuspected: true }));
    expect(split.code).toBe("Split?");
    expect(split.short).toBe("probable split");
    expect(split.side).toBe("none");
    expect(split.name).toContain("25%");
    const plain = buildupCell(stock({ state: null, corporateActionSuspected: false }));
    expect(plain.code).toBe("—");
    expect(plain.short).toBe("not scored");
  });

  it("adds up the constituents into the card's one-line read", () => {
    expect(buildupSplit({ LBU: 8, SC: 3, LU: 5, SBU: 2, N: 20 })).toEqual({ bull: 11, bear: 7, flat: 20 });
    expect(buildupLine({ LBU: 8, SC: 3, LU: 5, SBU: 2, N: 20 })).toBe("11 bullish · 7 bearish · 20 neutral");
    expect(buildupLine({ LBU: 0, SC: 0, LU: 0, SBU: 0, N: 0 })).toBe("No constituent scored");
    expect(buildupLine(undefined)).toBe("No constituent scored");
  });
});

describe("the buildup heading puts bullish names on top and unscored ones last", () => {
  it("lists the constituent columns the desk shows, stock first", () => {
    expect(STOCK_COLUMNS.map(column => column.key)).toEqual(["symbol", "price", "priceChgPct", "oiChgPct", "rvol", "state"]);
    expect(STOCK_COLUMNS.every(column => column.label.length > 0 && column.width > 0)).toBe(true);
  });

  it("sorts the state column by its own bullish-to-bearish order", () => {
    const state = STOCK_COLUMNS.find(column => column.key === "state");
    const price = STOCK_COLUMNS.find(column => column.key === "price");
    // Not numeric on purpose: the first tap on a numeric column means biggest-first, which for buildup would
    // open the screen on the least interesting row.
    expect(state?.numeric).toBeUndefined();
    expect(price?.numeric).toBe(true);
    expect(nextSort(state!, null)).toEqual({ key: "state", descending: false });
    expect(nextSort(price!, null)).toEqual({ key: "price", descending: true });
  });

  it("keeps a row the server could not score out of the way either way round", () => {
    const rows = [
      stock({ symbol: "E", state: "SBU" }), stock({ symbol: "C", state: null }),
      stock({ symbol: "A", state: "LBU" }), stock({ symbol: "D", state: "N" }),
      stock({ symbol: "F", state: "LU" }), stock({ symbol: "B", state: "SC" }),
    ];
    const up = sortRows(rows, STOCK_COLUMNS, { key: "state", descending: false });
    const down = sortRows(rows, STOCK_COLUMNS, { key: "state", descending: true });
    expect(up.map(row => row.symbol)).toEqual(["A", "B", "D", "F", "E", "C"]);
    expect(down.map(row => row.symbol)).toEqual(["E", "F", "D", "B", "A", "C"]);
  });
});

describe("a figure the archive did not store stays a dash and never becomes a zero", () => {
  it("words the score and the percentages with their sign", () => {
    expect(smfiWord(null)).toBe("—");
    expect(smfiWord(34.2)).toBe("+34.2");
    expect(smfiWord(-6.14)).toBe("-6.1");
    expect(smfiWord(0)).toBe("0.0");
    expect(signedPct(null)).toBe("—");
    expect(signedPct(1.6)).toBe("+1.6%");
    expect(signedPct(-2.34)).toBe("-2.3%");
    // A move that rounds away reads as flat, not as a negative figure the server never reported.
    expect(signedPct(-0.04)).toBe("0.0%");
  });

  it("words money, counts, prices and ratios at a scale a trader can read", () => {
    expect(priceWord(1482.3)).toBe("₹1,482.30");
    expect(priceWord(null)).toBe("—");
    expect(moneyWord(8.4e10)).toBe("₹8,400 Cr");
    expect(moneyWord(1.8e5)).toBe("₹1.8 L");
    expect(moneyWord(9400)).toBe("₹9,400");
    expect(moneyWord(null)).toBe("—");
    expect(countWord(1.24e7)).toBe("1.24 Cr");
    expect(countWord(9400)).toBe("9,400");
    expect(countWord(null)).toBe("—");
    expect(timesWord(1.8)).toBe("1.8×");
    expect(timesWord(null)).toBe("—");
  });

  it("reads a stored session off the string so a device clock cannot move it", () => {
    expect(sessionDayWord("2026-11-26")).toBe("26 Nov 2026");
    expect(sessionDayWord("2026-11-26T18:30:00+05:30")).toBe("26 Nov 2026");
    expect(sessionDayWord("2026-13-01")).toBe("the stored session");
    expect(sessionDayWord(null)).toBe("the stored session");
  });

  it("draws the six bands the web cards use", () => {
    expect(tierOf(null)).toBe("flat");
    expect(tierOf(7.9)).toBe("flat");
    expect(tierOf(-7.9)).toBe("flat");
    expect(tierOf(8)).toBe("mild-up");
    expect(tierOf(25)).toBe("up");
    expect(tierOf(49.9)).toBe("up");
    expect(tierOf(50)).toBe("strong-up");
    expect(tierOf(-8)).toBe("down");
    expect(tierOf(-49.9)).toBe("down");
    expect(tierOf(-50)).toBe("strong-down");
  });
});

describe("the sector card speaks from the fields prod sent", () => {
  it("lines up the moves behind a score", () => {
    expect(sectorFigures(sector())).toBe("+1.4% index · -2.1% OI · 8.4% of OI");
    expect(sectorFigures(sector({ oiSharePct: null }))).toBe("+1.4% index · -2.1% OI");
    expect(sectorCoverage(sector())).toBe("34 of 41 listed scored");
  });

  it("names the change it was missing when a sector has no buildup state", () => {
    expect(sectorStateWord(sector({ state: "LBU" }))).toBe("Long buildup");
    expect(sectorStateWord(sector({ state: null, oiChgPct: null }))).toBe("Open-interest change unknown");
    expect(sectorStateWord(sector({ state: null, oiChgPct: -2.1 }))).toBe("Price change unknown");
  });

  it("adds the market-wide regime, omitting only the figures that are absent", () => {
    expect(regimeLine(open([sector()]))).toBe("Regime: Risk-on · 12 advancing / 6 declining · 2.0x A/D · ₹84,120 Cr futures OI");
    const quiet = open([sector()], {}, { regime: { label: null, advancing: 3, declining: 0, adRatio: null, oiValueCrore: null } });
    expect(regimeLine(quiet)).toBe("Regime: not called · 3 advancing / 0 declining");
    expect(regimeLine(null)).toBe("");
  });

  it("warns once an expiry settles inside the window", () => {
    expect(expiryCaution(open([sector()]))).toBe("");
    expect(expiryCaution(open([sector()], {}, { expiriesInWindow: ["2026-11-26"] })))
      .toBe("Monthly expiry 26 Nov 2026 settles inside this window, so open interest falls on its own: read covering and unwinding with care.");
  });
});

describe("every cell the table draws comes from the shared formatter", () => {
  it("stacks the look-back that does not fit beside a figure, labelled", () => {
    expect(stockCell(stock(), "symbol")).toEqual({ text: "HEROMOTOCO", sub: "1.24 Cr sh open", tone: "muted" });
    expect(stockCell(stock(), "price")).toEqual({ text: "₹1,482.30", sub: "1W +2.4%", tone: "muted" });
    expect(stockCell(stock(), "priceChgPct")).toEqual({ text: "+1.6%", sub: "1M -3.2%", tone: "up" });
    expect(stockCell(stock(), "oiChgPct")).toEqual({ text: "-3.4%", sub: "₹1,204 Cr", tone: "down" });
    expect(stockCell(stock(), "rvol")).toEqual({ text: "1.8×", sub: "62% dly", tone: "muted" });
    expect(stockCell(stock(), "state")).toEqual({ text: "LBU", sub: "new longs", tone: "up" });
  });

  it("marks an absent delivery share and an absent state without inventing either", () => {
    expect(stockCell(stock({ deliveryPct: null }), "rvol").sub).toBe("no delivery");
    expect(stockCell(stock({ price: null, priceChgPct: null, oiChgPct: null, openInterest: null, oiValue: null, weekChgPct: null, rvol: null }), "price").text).toBe("—");
    expect(stockCell(stock({ state: null }), "state")).toEqual({ text: "—", sub: "not scored", tone: "muted" });
    expect(stockCell(stock({ state: "N" }), "state").tone).toBe("flat");
  });
});

describe("prod's own refusal reaches the trader", () => {
  it("prefers the sentence the server put in the body", () => {
    expect(sectorRotationReason({ details: { detail: "Locked on Free. This feature is not included in your plan." } }))
      .toBe("Locked on Free. This feature is not included in your plan.");
    expect(sectorRotationReason({ details: { message: "Sector rotation dataset is being rebuilt." } }))
      .toBe("Sector rotation dataset is being rebuilt.");
  });

  it("falls back to the error's message but never to a bare status line", () => {
    expect(sectorRotationReason(new Error("Request timeout"))).toBe("Request timeout");
    expect(sectorRotationReason(new Error("HTTP 503"))).toBe("Sector rotation could not be read.");
    expect(sectorRotationReason(new Error("HTTP 503"), "Nothing stored yet."))
      .toBe("Nothing stored yet.");
    expect(sectorRotationReason({ details: { detail: "   " } })).toBe("Sector rotation could not be read.");
    expect(sectorRotationReason(undefined)).toBe("Sector rotation could not be read.");
  });
});

describe("the desk reads one stored route and prints the reason it was given", () => {
  it("asks for the sector body under one key the period switch reuses", () => {
    expect(client).toContain('body: () => ["sector-rotation"] as const');
    expect(client).toContain("queryKey: queryKeys.sectorRotation.body(),");
    expect(client).toContain('client.get<SectorRotationBody>("/v1/sector-rotation")');
    expect(client).toContain("useSectorRotation,");
  });

  it("warms that same key on the press that opens the screen", () => {
    expect(prefetch).toContain("export function prefetchSectorRotation()");
    expect(prefetch).toContain("queryKey: queryKeys.sectorRotation.body(),");
    expect(prefetch).toContain('client.get<SectorRotationBody>("/v1/sector-rotation")');
    expect(prefetch).toContain("staleTime: 10 * 60 * 1000,");
    expect(more).toContain("router.push(\"/sector-rotation\")");
    expect(more).toContain("<Text style={styles.label}>Sector rotation</Text>");
    expect(more).toContain("onPressIn={prefetchSectorRotation}");
  });

  it("never asks for the intraday index route or a broker read", () => {
    expect(screen).not.toContain("sector-rotation/prices");
    expect(screen).not.toMatch(/useEquityQuote|useLiveBook|useQuoteStream|useOptionChain|\/v1\/equities/);
    expect(screen).toContain("useSectorRotation()");
    expect(screen).toContain("windowOf(body, period)");
  });

  it("prints the server's reason for a closed period, an unscored sector and a failed read", () => {
    expect(screen).toContain("{view.reason}");
    expect(screen).toContain("sectorRotationReason(read.error)");
    expect(screen).toContain("Sectors with no score");
    expect(screen).toContain("{`${row.name}: ${row.reason}`}");
    expect(screen).toContain("windowOf(body, entry.key)?.available === false");
    expect(screen).toContain("onPress={() => setPeriod(entry.key)}");
    expect(screen).not.toMatch(/disabled=\{short\}/);
  });

  it("keeps the formatting in the shared module and explains the pill once", () => {
    expect(screen).toContain("stockCell(row, column.key)");
    expect(screen).not.toContain("toLocaleString");
    expect(screen).toContain("STATE_HELP.LBU");
    expect(screen).toContain("A dash is a figure the archive did not store, never a zero.");
  });
});
