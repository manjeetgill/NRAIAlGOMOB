import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { filterRows } from "../../packages/shared/src/api/table-sort.ts";

/**
 * Searching the owner's book on the phone.
 *
 * A book of thirty-odd positions is taller than the screen, so the rows have to be narrowed where they already
 * are: this filter reads the rows the broker sent and asks prod for nothing, which is why it can run offline,
 * on a degraded account reply, and on the phone's own remembered copy of the book.
 *
 * Two of its rules are decisions rather than habits. A derivative is found by the underlying name the master
 * reads out from behind ICICI's stock code, because RELIND is RELIANCE and no prefix of that code can decide it
 * - and a row whose strike or name the server never reported contributes nothing to the match, so the word
 * "null" searches an owner's book up and finds no row.
 */

interface BookRow {
  symbol: string;
  underlying: string;
  strike: string | null;
  right: string | null;
  expiry: string | null;
  side: string;
  name: string | null;
}

const BOOK: BookRow[] = [
  { symbol: "NIFTY26DEC27000CE", underlying: "NIFTY", strike: "27000", right: "CE", expiry: "2026-12-25", side: "SELL", name: null },
  { symbol: "BANKNIFTY26DEC52000PE", underlying: "BANKNIFTY", strike: "52000", right: "PE", expiry: "2026-12-25", side: "BUY", name: null },
  { symbol: "RELIND", underlying: "RELIANCE", strike: null, right: null, expiry: null, side: "SELL", name: null },
  { symbol: "INFTEC", underlying: "INFY", strike: null, right: null, expiry: null, side: "BUY", name: "Infosys" },
];

/** What the screen hands the filter for a position row, and what it hands for a holding. */
const asPosition = (row: BookRow) => [row.symbol, row.underlying, row.strike, row.right, row.expiry, row.side];
const asHolding = (row: BookRow) => [row.symbol, row.name];
const found = (query: string) => filterRows(BOOK, query, asPosition).map((row) => row.symbol);

it("shows every row while nothing has been typed, without handing back the book itself", () => {
  for (const query of ["", "   ", "\t"]) {
    const shown = filterRows(BOOK, query, asPosition);
    expect(shown.map((row) => row.symbol)).toEqual(BOOK.map((row) => row.symbol));
    expect(shown).not.toBe(BOOK);
  }
});

it("finds a contract by its broker code in whatever case it was typed", () => {
  expect(found("NIFTY26DEC27000CE")).toEqual(["NIFTY26DEC27000CE"]);
  expect(found("nifty26dec27000ce")).toEqual(["NIFTY26DEC27000CE"]);
  // A word lands inside a longer name, so the index also brings up its bigger brother. That is what every
  // broker app's symbol box does, and it is the useful direction: nobody searching NIFTY wants an empty list
  // because the account holds only BANKNIFTY options.
  expect(found("nifty")).toEqual(["NIFTY26DEC27000CE", "BANKNIFTY26DEC52000PE"]);
});

it("reads through the broker code to the underlying behind it", () => {
  // The owner types the exchange name, not ICICI's stock code, and the code gives no clue which is which.
  expect(found("reliance")).toEqual(["RELIND"]);
});

it("narrows with each extra word instead of widening", () => {
  expect(found("26dec")).toEqual(["NIFTY26DEC27000CE", "BANKNIFTY26DEC52000PE"]);
  expect(found("26dec 52000")).toEqual(["BANKNIFTY26DEC52000PE"]);
  expect(found("buy pe")).toEqual(["BANKNIFTY26DEC52000PE"]);
});

it("keeps a figure out of the match when the server never reported one", () => {
  expect(found("null")).toEqual([]);
  expect(found("undefined")).toEqual([]);
  // A strike typed as a number still lands, because a row's own text is what is searched.
  expect(filterRows(BOOK, "27000", (row) => [row.symbol, row.strike]).map((row) => row.symbol))
    .toEqual(["NIFTY26DEC27000CE"]);
});

it("finds a holding by the company name the broker prints beside its code", () => {
  expect(filterRows(BOOK, "infosys", asHolding).map((row) => row.symbol)).toEqual(["INFTEC"]);
  // The same word over positions matches nothing: each list is searched by the parts its rows actually carry.
  expect(filterRows(BOOK, "infosys", asPosition)).toEqual([]);
});

it("answers with no rows rather than with the whole book when nothing matches", () => {
  expect(found("TATAMOTORS")).toEqual([]);
});

const screen = readFileSync(resolve(__dirname, "../../apps/mobile/app/(tabs)/portfolio.tsx"), "utf8");

it("puts one small icon beside the two headings and opens the field with the same press that closes it", () => {
  expect(screen).toMatch(/<Ionicons name=\{searching \? "close" : "search"\} size=\{17\}/);
  expect(screen).toContain('if (searching) { setSearching(false); setQuery(""); } else setSearching(true);');
});

it("filters the rows it has, so no read is issued for a word typed into a field", () => {
  expect(screen).toContain('const [query, setQuery] = useState("");');
  expect(screen).toContain("filterRows(positions, query,");
  expect(screen).toContain("filterRows(holdings, query,");
  expect(screen).toContain("sortRows(positionMatches, POSITION_COLUMNS, positionSort)");
  expect(screen).toContain("sortRows(holdingMatches, HOLDING_COLUMNS, holdingSort)");
  // Sorting happens after the narrowing, so a column tap orders what is on screen and not the rows above it.
  expect(screen).not.toContain("sortRows(positions,");
  expect(screen).not.toContain("sortRows(holdings,");
});

it("names the words and the rows searched when nothing matches, instead of a flat book", () => {
  expect(screen).toContain('No ${noun} in this book matches “${query.trim()}”.');
  expect(screen).toContain("if (positionRows.length === 0) return noMatch(\"position\", positions.length);");
  expect(screen).toContain("if (holdingRows.length === 0) return noMatch(\"holding\", holdings.length);");
  // The two states a broker really reports are still said in their own words, and only after a filtered
  // list has been ruled out, so an empty account never borrows the filter's message and vice versa.
  expect(screen).toContain("if (positions.length === 0) {");
  expect(screen).toContain("No open positions");
  expect(screen.indexOf("if (positions.length === 0) {")).toBeLessThan(screen.indexOf('return noMatch("position"'));
  expect(screen.indexOf("if (holdings.length === 0 && blocked(")).toBeLessThan(screen.indexOf('return noMatch("holding"'));
});

it("keeps the account's sums whole and says so while a filter runs", () => {
  expect(screen).toContain("const positionTotals = totals(positions);");
  expect(screen).toContain("const holdingTotals = totals(holdings);");
  expect(screen).toContain("the sums above are the whole book");
  // The field counts the tab it sits under, so its number is the number of rows below it.
  expect(screen).toContain("const shownCount = tab === \"positions\" ? positionRows.length : holdingRows.length;");
  expect(screen).toContain("${shownCount}/${bookCount}");
});
