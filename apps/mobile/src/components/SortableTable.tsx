/**
 * A compact book table whose columns sort.
 *
 * Cards were honest but tall: one position took a third of the screen, so the owner could not see the book, only
 * the top of it. A table shows six times as many rows and lets a tap on a column heading bring the worst or the
 * biggest to the top. Two rules hold it together: the column widths are shared by the heading and the rows, so a
 * label always sits over its own figures, and every cell that the broker left empty is still given to the table -
 * a row with no price sorts last rather than disappearing.
 */

import React, { type ReactElement } from "react";
import { Dimensions, FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { StyleProp, TextStyle } from "react-native";
import type { SortColumn, SortState } from "@nraialgo/shared/api";

export interface TableCell {
  text: string;
  /** A quieter second line under the value: a holding's company name, a day's percentage. */
  sub?: string | null;
  style?: StyleProp<TextStyle>;
  subStyle?: StyleProp<TextStyle>;
}

export interface TableTheme {
  card: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
}

interface Props<Row> {
  rows: readonly Row[];
  columns: readonly SortColumn<Row>[];
  sort: SortState | null;
  onSort: (column: SortColumn<Row>) => void;
  /** What one row shows in one column. The table draws it; only the screen knows what it means. */
  cell: (row: Row, column: SortColumn<Row>) => TableCell;
  keyOf: (row: Row, index: number) => string;
  onRowPress?: (row: Row) => void;
  theme: TableTheme;
  refreshControl?: ReactElement;
  footer?: ReactElement;
}

const PADDING = 12;

/** The first column carries the identity, so it keeps its width and the figures give way on a narrow phone. */
function scaleWidths(columns: readonly { width: number }[], padding: number): number[] {
  const room = Dimensions.get("window").width - padding * 2 - columns[0].width;
  const fixed = columns.slice(1).reduce((sum, column) => sum + column.width, 0);
  const scale = fixed > room ? Math.max(0.72, room / fixed) : 1;
  return columns.map((column, index) => (index === 0 ? column.width : Math.floor(column.width * scale)));
}

export function SortableTable<Row>({
  rows, columns, sort, onSort, cell, keyOf, onRowPress, theme, refreshControl, footer,
}: Props<Row>) {
  const styles = StyleSheet.create({
    head: { flexDirection: "row", paddingHorizontal: PADDING, paddingVertical: 8, backgroundColor: theme.card, borderBottomWidth: 1, borderBottomColor: theme.border },
    headCell: { paddingRight: 6 },
    headText: { fontSize: 10, fontWeight: "600", color: theme.muted, lineHeight: 13 },
    headTextActive: { color: theme.accent },
    list: { padding: 12, paddingBottom: 100 },
    row: { flexDirection: "row", alignItems: "center", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: theme.border },
    cell: { paddingRight: 6 },
    value: { fontSize: 11, fontWeight: "500", color: theme.text },
    sub: { fontSize: 10, color: theme.muted },
    symbol: { fontSize: 12, fontWeight: "600", color: theme.text },
  });

  const widths = scaleWidths(columns, PADDING);

  const header = (
    <View style={styles.head}>
      {columns.map((column, index) => (
        <TouchableOpacity
          key={column.key}
          style={[styles.headCell, index === 0 ? { flex: 1, minWidth: widths[0] } : { width: widths[index] }]}
          onPress={() => onSort(column)}
          accessibilityRole="button"
          accessibilityLabel={`Sort by ${column.label}`}
        >
          <Text style={[styles.headText, !column.numeric && { textAlign: "left" }, column.numeric && { textAlign: "right" }, sort?.key === column.key && styles.headTextActive]} numberOfLines={2}>
            {column.label}
            {sort?.key === column.key ? (sort.descending ? " ▼" : " ▲") : ""}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  const renderRow = ({ item, index }: { item: Row; index: number }) => {
    const body = (
      <View style={styles.row}>
        {columns.map((column, columnIndex) => {
          const shown = cell(item, column);
          return (
            <View
              key={column.key}
              style={[styles.cell, columnIndex === 0 ? { flex: 1, minWidth: widths[0] } : { width: widths[columnIndex] }]}
            >
              <Text
                style={[columnIndex === 0 ? styles.symbol : styles.value, column.numeric && { textAlign: "right" }, shown.style]}
                numberOfLines={columnIndex === 0 ? 2 : 1}
              >
                {shown.text}
              </Text>
              {shown.sub ? (
                <Text style={[styles.sub, column.numeric && { textAlign: "right" }, shown.subStyle]} numberOfLines={1}>
                  {shown.sub}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
    );
    return onRowPress ? (
      <TouchableOpacity onPress={() => onRowPress(item)} activeOpacity={0.7} accessibilityRole="button">
        {body}
      </TouchableOpacity>
    ) : body;
  };

  return (
    <View style={{ flex: 1 }}>
      {header}
      <FlatList
        data={rows as Row[]}
        keyExtractor={keyOf}
        renderItem={renderRow}
        contentContainerStyle={styles.list}
        refreshControl={refreshControl}
        ListFooterComponent={footer}
      />
    </View>
  );
}
