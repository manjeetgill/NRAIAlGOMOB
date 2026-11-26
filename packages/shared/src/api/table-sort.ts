/**
 * Sorting the rows of a table by one of its columns.
 *
 * A broker table is not a spreadsheet: most of its cells are figures the server either reported or did not, and
 * "did not" is not zero. So a column reads a value of text, number or null, and a null always sorts last -
 * whichever way the trader turned the column - because a row the broker never priced must not push a row it did
 * off the screen.
 */

export interface SortState {
  key: string;
  descending: boolean;
}

/**
 * What a sorter needs from a column: its name and the figure it reads per row.
 *
 * A table column carries a width as well, but the ordering rules are the same for a list that is not a table -
 * the watchlist sorts by the price on its rows without ever measuring a column.
 */
export interface SortKey<Row> {
  key: string;
  label: string;
  /** Money and quantities sort biggest first on the first tap; names sort A to Z. */
  numeric?: boolean;
  /** The value this column sorts by, or null when the server reported no such figure for the row. */
  value: (row: Row) => string | number | null;
}

/** One column of a sortable table: what it shows, and what a tap on its header sorts by. */
export interface SortColumn<Row> extends SortKey<Row> {
  /** The column's width in dp. The table's own width is the sum of these, so nothing is measured twice. */
  width: number;
}

/** The state a tap on a header leaves the table in: the same column flips, a new column starts its own way. */
export function nextSort<Row>(column: SortKey<Row>, current: SortState | null): SortState {
  if (current && current.key === column.key) return { key: column.key, descending: !current.descending };
  return { key: column.key, descending: column.numeric === true };
}

const text = (value: string | number) => String(value).toUpperCase();

/** Rows in the order the chosen column asks for. The rows themselves are never copied or rewritten. */
export function sortRows<Row>(
  rows: readonly Row[],
  columns: readonly SortKey<Row>[],
  sort: SortState | null,
): Row[] {
  const column = columns.find((entry) => entry.key === sort?.key);
  if (!column || !sort) return [...rows];
  const keyed = rows.map((row, index) => ({ row, index, value: column.value(row) }));
  keyed.sort((left, right) => {
    if (left.value === null && right.value === null) return left.index - right.index;
    if (left.value === null) return 1;
    if (right.value === null) return -1;
    const step = typeof left.value === "number" && typeof right.value === "number"
      ? left.value - right.value
      : text(left.value) < text(right.value) ? -1 : text(left.value) > text(right.value) ? 1 : 0;
    // Two rows the column cannot separate stay in the order the broker sent them, so re-sorting the same
    // list on a new tick never shuffles identical figures between two fingers.
    return (sort.descending ? -step : step) || (left.index - right.index);
  });
  return keyed.map((entry) => entry.row);
}
