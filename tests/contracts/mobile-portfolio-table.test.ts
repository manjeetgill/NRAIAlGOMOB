import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
  nextSort,
  sortRows,
  type SortColumn,
  type SortState,
} from "../../packages/shared/src/api/table-sort.ts";

/**
 * The Portfolio book is a table now, and a table's whole job is the order it puts rows in. These cases pin the
 * two rules the owner reads the screen by: a tap turns the chosen column around rather than resetting the table,
 * and a row the broker never priced goes to the bottom whichever way the column is pointed - it is never dropped
 * and never allowed to pose as a zero.
 */

interface Row {
  symbol: string;
  pnl: number | null;
}

const columns: SortColumn<Row>[] = [
  { key: "symbol", label: "Symbol", width: 84, value: (row) => row.symbol },
  { key: "pnl", label: "Unrealized", width: 52, numeric: true, value: (row) => row.pnl },
];

const rows: Row[] = [
  { symbol: "ITC", pnl: 180.5 },
  { symbol: "nifty", pnl: null },
  { symbol: "TATASTEEL", pnl: -4_200 },
  { symbol: "ADANI", pnl: 0 },
  { symbol: "RELIANCE", pnl: 12_345.67 },
];

it("starts a money column at its biggest number and a name column at A", () => {
  expect(nextSort(columns[1], null)).toEqual({ key: "pnl", descending: true });
  expect(nextSort(columns[0], null)).toEqual({ key: "symbol", descending: false });
});

it("turns the same column around instead of restarting the table", () => {
  expect(nextSort(columns[1], { key: "pnl", descending: true })).toEqual({ key: "pnl", descending: false });
  expect(nextSort(columns[1], { key: "symbol", descending: false })).toEqual({ key: "pnl", descending: true });
});

it("sorts a column by its numbers, not by the text it is printed as", () => {
  const high = sortRows(rows, columns, { key: "pnl", descending: true }).map((row) => row.symbol);
  expect(high).toEqual(["RELIANCE", "ITC", "ADANI", "TATASTEEL", "nifty"]);
  expect(sortRows(rows, columns, { key: "pnl", descending: false }).map((row) => row.symbol))
    .toEqual(["TATASTEEL", "ADANI", "ITC", "RELIANCE", "nifty"]);
});

it("puts an unpriced row last in both directions, because a missing figure is not the smallest one", () => {
  expect(sortRows(rows, columns, { key: "pnl", descending: true })[4].pnl).toBeNull();
  expect(sortRows(rows, columns, { key: "pnl", descending: false })[4].pnl).toBeNull();
});

it("sorts names without the machine's locale, so NIFTY never lands between two capitals", () => {
  expect(sortRows(rows, columns, { key: "symbol", descending: false }).map((row) => row.symbol))
    .toEqual(["ADANI", "ITC", "nifty", "RELIANCE", "TATASTEEL"]);
});

it("keeps equal figures in the order the broker sent them", () => {
  const tied: Row[] = [
    { symbol: "A", pnl: 10 },
    { symbol: "B", pnl: null },
    { symbol: "C", pnl: 10 },
    { symbol: "D", pnl: null },
  ];
  const sorted = sortRows(tied, columns, { key: "pnl", descending: true });
  expect(sorted.map((row) => row.symbol)).toEqual(["A", "C", "B", "D"]);
});

it("leaves the broker's own order alone until a column is tapped", () => {
  expect(sortRows(rows, columns, null).map((row) => row.symbol)).toEqual(rows.map((row) => row.symbol));
});

// The screen is where a table either keeps the book or loses figures on the way.
const screen = readFileSync(resolve("apps/mobile/app/(tabs)/portfolio.tsx"), "utf8");

it("sorts each tab on its own state, so sorting positions never reorders holdings", () => {
  expect(screen).toContain("sortRows(positions, POSITION_COLUMNS, positionSort)");
  expect(screen).toContain("sortRows(holdings, HOLDING_COLUMNS, holdingSort)");
  expect(screen).toContain("setPositionSort(nextSort(column, positionSort))");
  expect(screen).toContain("setHoldingSort(nextSort(column, holdingSort))");
});

it("still shows every figure the cards carried", () => {
  for (const field of [
    "item.quantity", "item.entryPrice", "item.markPrice", "item.unrealizedPnl", "pnlPercent(item)",
    "item.name", "item.averagePrice", "item.currentPrice", "item.marketValue", "item.changePercent",
    "item.todayPnl", "item.side",
  ]) {
    expect(screen, field).toContain(field);
  }
  // The account each row trades under survived the card: once above the list, since every row of one
  // broker response carries the same one and a column of repeats would only cost width.
  expect(screen).toContain("${row.broker} ${row.account}");
  expect(screen).toContain("savedHoldings.map((row) => row.accountId)");
});

it("leaves a cell blank when the broker sent no figure, so the row stays narrow", () => {
  expect(screen).not.toContain('const NO_COST');
  expect(screen).not.toContain('const NO_PRICE');
  expect(screen).not.toContain('const NO_PNL');
  expect(screen).not.toContain('const NO_CHANGE');
  expect(screen).not.toMatch(/text: "-"/);
});

it("keeps the stream's own price marked apart from the broker's saved one", () => {
  expect(screen).toContain("item.live ? styles.streamValue : undefined");
});

it("draws the heading and its figures from one column list, so a label never sits over the wrong column", () => {
  const table = readFileSync(resolve("apps/mobile/src/components/SortableTable.tsx"), "utf8");
  expect(table).toContain("const widths = scaleWidths(columns, PADDING);");
  expect(table).toContain("widths[index]");
  expect(table).toContain("widths[columnIndex]");
  expect(table).toContain("onPress={() => onSort(column)}");
});

it("states the order the table is in above the rows, where it stays after the heading scrolls by", () => {
  expect(screen).toContain("sortLine(POSITION_COLUMNS, positionSort)");
  expect(screen).toContain("sortLine(HOLDING_COLUMNS, holdingSort)");
});
