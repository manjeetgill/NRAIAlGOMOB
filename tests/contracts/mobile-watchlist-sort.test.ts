import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { nextSort, sortRows, type SortKey, type SortState } from "../../packages/shared/src/api/table-sort.ts";

/**
 * The watchlist orders its rows by the figures printed on them.
 *
 * Two things are decided here rather than assumed. A row nobody priced sorts last in both directions, because a
 * symbol prod has not read yet must not push one it has off the screen - and equal figures keep the order prod
 * sent, so a ticking list never shuffles two identical prices between one repaint and the next. The screen reads
 * are the same rows the trader sees, including the prices the phone remembered, so the ordering is checked
 * against the painted figures, not the ones that came off the wire.
 */

interface Row {
  symbol: string;
  ltp: number | null;
  changePct: number | null;
}

const KEYS: SortKey<Row>[] = [
  { key: "price", label: "Price ₹", numeric: true, value: (row) => row.ltp },
  { key: "change", label: "Change", numeric: true, value: (row) => row.changePct },
];

const SAVED: Row[] = [
  { symbol: "ADANIENT", ltp: 2660.00, changePct: 1.24 },
  { symbol: "BAJAJ-AUTO", ltp: 10850.00, changePct: -0.31 },
  { symbol: "ITC", ltp: 281.50, changePct: 0.82 },
  { symbol: "UNPRICED", ltp: null, changePct: null },
];

const order = (sort: SortState | null): string[] => sortRows(SAVED, KEYS, sort).map((row) => row.symbol);

it("puts the dearest symbol first on the first tap on price", () => {
  expect(order({ key: "price", descending: true })).toEqual(["BAJAJ-AUTO", "ADANIENT", "ITC", "UNPRICED"]);
});

it("turns the same column around without lifting the unpriced row to the top", () => {
  expect(order({ key: "price", descending: false })).toEqual(["ITC", "ADANIENT", "BAJAJ-AUTO", "UNPRICED"]);
});

it("sorts the day's percentage by the same rules", () => {
  expect(order({ key: "change", descending: true })).toEqual(["ADANIENT", "ITC", "BAJAJ-AUTO", "UNPRICED"]);
  expect(order({ key: "change", descending: false })).toEqual(["BAJAJ-AUTO", "ITC", "ADANIENT", "UNPRICED"]);
});

it("leaves the list in the order it is saved in while nothing is sorted", () => {
  expect(order(null)).toEqual(["ADANIENT", "BAJAJ-AUTO", "ITC", "UNPRICED"]);
});

it("keeps the saved order between two rows the column cannot separate", () => {
  const tied: Row[] = [
    { symbol: "ONE", ltp: 500, changePct: 1 },
    { symbol: "TWO", ltp: 500, changePct: 1 },
    { symbol: "THREE", ltp: 500, changePct: 1 },
  ];
  for (const descending of [true, false]) {
    expect(sortRows(tied, KEYS, { key: "price", descending }).map((row) => row.symbol))
      .toEqual(["ONE", "TWO", "THREE"]);
  }
});

it("orders a copy of the list, never the rows themselves", () => {
  const sorted = sortRows(SAVED, KEYS, { key: "price", descending: true });
  expect(sorted[0]).toBe(SAVED[1]);
  expect(SAVED.map((row) => row.symbol)).toEqual(["ADANIENT", "BAJAJ-AUTO", "ITC", "UNPRICED"]);
});

it("still sorts a table column, which carries a width on top of the same three fields", () => {
  const columns = [
    { key: "symbol", label: "Symbol", width: 84, value: (row: Row) => row.symbol },
    { key: "price", label: "Price ₹", width: 62, numeric: true, value: (row: Row) => row.ltp },
  ];
  expect(nextSort(columns[1], null)).toEqual({ key: "price", descending: true });
  expect(nextSort(columns[0], null)).toEqual({ key: "symbol", descending: false });
  expect(sortRows(SAVED, columns, { key: "symbol", descending: false }).map((row) => row.symbol))
    .toEqual(["ADANIENT", "BAJAJ-AUTO", "ITC", "UNPRICED"]);
});

const screen = readFileSync(resolve(__dirname, "../../apps/mobile/app/(tabs)/watchlist.tsx"), "utf8");

it("heads the list with the two figures it sorts by, each label over its own column", () => {
  expect(screen).toContain('{ key: "price", label: "Price ₹", numeric: true, value: (row) => row.ltp }');
  expect(screen).toContain('{ key: "change", label: "Change", numeric: true, value: (row) => row.changePct }');
  expect(screen).toContain("accessibilityLabel={`Sort by ${key.label}`}");
  // The row's price block is `minWidth: 86`; the heading cell has to take the same width or the label
  // sits over a figure that is not its own.
  expect(screen).toMatch(/right: \{ alignItems: "flex-end", minWidth: 86 }/);
  expect(screen).toMatch(/headCell: \{ minWidth: 86/);
  expect(screen).toMatch(/headLabel: \{ flex: 2\.1/);
});

it("orders the rows it actually painted, so a remembered price counts", () => {
  expect(screen).toContain("const orderedRows = useMemo(() => sortRows(shownRows, SORT_KEYS, sort), [shownRows, sort]);");
  expect(screen).toContain("data={orderedRows}");
  expect(screen).not.toContain("data={shownRows}");
});

it("gives the third tap back the order the owner saved, which the book table has no reason to do", () => {
  expect(screen).toContain("return current.descending ? { key: key.key, descending: false } : null;");
  expect(screen).toContain("if (!current || current.key !== key.key) return { key: key.key, descending: true };");
});

it("keeps the list's own machinery outside the sort", () => {
  // Paging, the saved-order copy, the ticket and the drag gate all still address the same rows.
  expect(screen).toContain("{`Page ${page + 1} of ${pages}`}");
  expect(screen).toContain("onScrollBeginDrag={pauseQuoteDispatch}");
  expect(screen).toContain("{ticket.visible ? <BuySheet");
  expect(screen).toContain("keyExtractor={item => `${item.exchange}:${item.symbol}`}");
});
