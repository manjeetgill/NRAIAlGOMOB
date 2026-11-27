/**
 * Sector Rotation screen - which sectors money is moving into, and what the stocks inside one are doing.
 *
 * One read of prod's stored end-of-day dataset (`GET /v1/sector-rotation`) carries the whole screen: the four
 * periods, every sector's score, and each sector's constituents with their buildup state. Switching 1D → 1M is
 * a lookup in the body already held, so it costs no network and no broker read - which is the only reason this
 * desk is affordable on a phone that also places orders.
 *
 * Two panes, because 19 sectors and 40 stocks do not share a phone screen. The board ranks sectors by their
 * money-flow score; a tap opens that sector's constituents, most-bullish buildup first, and the back arrow
 * beside its name returns to the board with the same period still chosen.
 *
 * Nothing here is a sentence the app invented about the data. A sector with no score is listed with the reason
 * its own counts give (or the server's, when the constituent list could not be read), a period with too few
 * stored sessions shows the server's sentence for why, and every figure the archive did not supply stays a dash
 * rather than becoming a zero. The web desk is the reference: same route, same fields, same bands.
 */

import React, { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Dimensions, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useCanGoBack, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  PERIODS,
  STOCK_COLUMNS,
  STATE_HELP,
  TIER_NAME,
  buildupLine,
  buildupSplit,
  expiryCaution,
  nextSort,
  regimeLine,
  sectorBoard,
  sectorCoverage,
  sectorFigures,
  sectorRotationReason,
  sectorStateWord,
  sessionDayWord,
  smfiWord,
  sortRows,
  stockCell,
  stocksOf,
  tierOf,
  windowOf,
  windowSpan,
  type CellTone,
  type PeriodKey,
  type Sector,
  type SectorStock,
  type SortState,
  type Tier,
} from "@nraialgo/shared/api";
import { useApi } from "@/hooks/useApi";
import { useTheme } from "@/components/ThemeProvider";

/** The screen's own gutter and side padding. The stock column is the one that gives way on a narrow phone. */
const GUTTER = 3;
const SIDE = 12;

/** The six SMFI bands as text colour: brightest green to deepest red, the same ladder the web cards use. */
const TIER_TEXT: Record<Tier, { light: string; dark: string }> = {
  "strong-up": { light: "#14532d", dark: "#4ade80" },
  up: { light: "#15803d", dark: "#22c55e" },
  "mild-up": { light: "#16a34a", dark: "#86efac" },
  flat: { light: "#64748b", dark: "#94a3b8" },
  down: { light: "#dc2626", dark: "#f87171" },
  "strong-down": { light: "#7f1d1d", dark: "#ef4444" },
};

interface Palette {
  bg: string; card: string; chip: string; text: string; muted: string; border: string;
  accent: string; onAccent: string; bull: string; bear: string; flat: string;
}

const TONE_KEYS: Record<CellTone, keyof Palette> = {
  up: "bull", down: "bear", flat: "text", muted: "muted",
};

export default function SectorRotationScreen() {
  const { useSectorRotation } = useApi();
  const { resolvedTheme } = useTheme();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const read = useSectorRotation();

  const [period, setPeriod] = useState<PeriodKey>("1");
  const [chosen, setChosen] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState | null>({ key: "state", descending: false });
  const [notesOpen, setNotesOpen] = useState(false);

  const dark = resolvedTheme === "dark";
  const colors = useMemo<Palette>(() => (dark
    ? { bg: "#0f172a", card: "#1e293b", chip: "#0f172a", text: "#f1f5f9", muted: "#94a3b8", border: "#334155",
        accent: "#38bdf8", onAccent: "#0f172a", bull: "#22c55e", bear: "#ef4444", flat: "#475569" }
    : { bg: "#f8fafc", card: "#ffffff", chip: "#f1f5f9", text: "#0f172a", muted: "#64748b", border: "#e2e8f0",
        accent: "#0284c7", onAccent: "#ffffff", bull: "#16a34a", bear: "#dc2626", flat: "#cbd5e1" }), [dark]);

  const styles = useMemo(() => StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },
    body: { padding: SIDE, paddingBottom: 40 },
    header: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 10 },
    title: { fontSize: 20, fontWeight: "700", color: colors.text },
    stamp: { fontSize: 11.5, color: colors.muted, marginTop: 2, lineHeight: 16 },
    chips: { flexDirection: "row", gap: 6, marginBottom: 10 },
    chip: { paddingHorizontal: 13, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.chip },
    chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    chipText: { fontSize: 13, fontWeight: "600", color: colors.muted },
    chipTextOn: { color: colors.onAccent },
    band: { borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, padding: 10, marginBottom: 10 },
    bandText: { fontSize: 12.5, color: colors.text, lineHeight: 18 },
    caution: { fontSize: 11.5, color: colors.muted, lineHeight: 17, marginBottom: 10 },
    section: { fontSize: 11, fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase", color: colors.muted, marginTop: 4, marginBottom: 8 },
    card: { borderRadius: 12, borderWidth: 1, backgroundColor: colors.card, padding: 12, marginBottom: 8 },
    cardHead: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 10 },
    cardName: { fontSize: 15.5, fontWeight: "700", color: colors.text, flexShrink: 1 },
    cardSub: { fontSize: 11.5, color: colors.muted, marginTop: 2 },
    cardScore: { fontSize: 15.5, fontWeight: "800", textAlign: "right" },
    cardState: { fontSize: 11, color: colors.muted, marginTop: 2, textAlign: "right" },
    splitBar: { flexDirection: "row", height: 5, borderRadius: 3, overflow: "hidden", marginTop: 9 },
    scoreBar: { height: 3, borderRadius: 2, marginTop: 4, overflow: "hidden" },
    silent: { fontSize: 12, color: colors.muted, lineHeight: 18, marginBottom: 8 },
    tableHead: { flexDirection: "row", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
    headCell: { paddingRight: GUTTER },
    headText: { fontSize: 10, fontWeight: "700", color: colors.muted, lineHeight: 13 },
    headTextOn: { color: colors.accent },
    row: { flexDirection: "row", paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: colors.border },
    symbol: { fontSize: 12.5, fontWeight: "700", color: colors.text },
    value: { fontSize: 12, fontWeight: "600", color: colors.text },
    pill: { alignSelf: "flex-end", borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1 },
    pillText: { fontSize: 11, fontWeight: "800" },
    sub: { fontSize: 10, color: colors.muted, marginTop: 1 },
    legend: { fontSize: 11, color: colors.muted, lineHeight: 17, marginTop: 8 },
    noteToggle: { fontSize: 12.5, fontWeight: "600", color: colors.accent, marginTop: 14, marginBottom: 2 },
    note: { fontSize: 11.5, color: colors.muted, lineHeight: 17, marginTop: 5 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingBottom: 80 },
    centerText: { fontSize: 13.5, color: colors.muted, textAlign: "center", paddingHorizontal: 24, lineHeight: 20 },
  }), [colors]);

  const body = read.data ?? null;
  const view = windowOf(body, period);
  const { ranked, silent } = sectorBoard(view);
  // A sector chosen under one period that the next period cannot score drops back to the board, where its
  // reason is printed, rather than staying open over an empty table.
  const selected = chosen ? ranked.find(row => row.key === chosen) ?? null : null;
  const stocks = stocksOf(view, selected?.key ?? null);
  const listed = sortRows(stocks, STOCK_COLUMNS, sort);
  const periodLabel = PERIODS.find(entry => entry.key === period)?.label ?? period;
  const toneColour = (tone: CellTone) => colors[TONE_KEYS[tone]];
  const tierColour = (tier: Tier) => (dark ? TIER_TEXT[tier].dark : TIER_TEXT[tier].light);

  const widths = useMemo(() => {
    const room = Dimensions.get("window").width - SIDE * 2 - STOCK_COLUMNS[0].width;
    const fixed = STOCK_COLUMNS.slice(1).reduce((sum, column) => sum + column.width, 0) + GUTTER * (STOCK_COLUMNS.length - 1);
    const scale = fixed > room ? Math.max(0.7, room / fixed) : 1;
    return STOCK_COLUMNS.map((column, index) => (index === 0 ? column.width : Math.floor(column.width * scale)));
  }, []);

  const onSort = useCallback((key: string) => {
    const column = STOCK_COLUMNS.find(entry => entry.key === key);
    if (column) setSort(current => nextSort(column, current));
  }, []);

  const back = () => (canGoBack ? router.back() : router.replace("/(tabs)/more"));
  const refresh = <RefreshControl refreshing={read.isFetching} onRefresh={() => void read.refetch()} tintColor={colors.accent} />;

  if (!body) {
    // Nothing to show yet, or nothing there will ever be: both are said, because a board that is simply absent
    // reads the same as a market with nothing in it.
    return (
      <View style={styles.screen}>
        <View style={[styles.body, { flex: 1 }]}>
          <View style={styles.header}>
            {read.isLoading ? null : (
              <TouchableOpacity onPress={back} accessibilityRole="button" accessibilityLabel="Go back">
                <Ionicons name="chevron-back" size={24} color={colors.muted} />
              </TouchableOpacity>
            )}
            <Text style={styles.title}>Sector rotation</Text>
          </View>
          {read.isLoading ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.centerText}>Reading the stored sector dataset from myalgodesk.in…</Text>
            </View>
          ) : (
            <View style={styles.band}>
              <Text style={styles.bandText}>
                {read.isError ? sectorRotationReason(read.error) : "The server answered with no dataset."}
              </Text>
              <Text style={[styles.caution, { marginTop: 6, marginBottom: 0 }]}>
                This desk only reads what myalgodesk.in has archived, so it recovers on its own. Pull down to try
                the read again.
              </Text>
            </View>
          )}
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.body}
      refreshControl={refresh}
    >
      <View style={styles.header}>
        {selected ? (
          <TouchableOpacity
            onPress={() => setChosen(null)}
            accessibilityRole="button"
            accessibilityLabel="Back to all sectors"
          >
            <Ionicons name="chevron-back" size={24} color={colors.accent} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={back} accessibilityRole="button" accessibilityLabel="Go back">
            <Ionicons name="chevron-back" size={24} color={colors.muted} />
          </TouchableOpacity>
        )}
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{selected ? selected.name : "Sector rotation"}</Text>
          <Text style={styles.stamp}>
            {`${windowSpan(view, body.asOf, period) || `End-of-day · as of ${sessionDayWord(body.asOf)}`}${view?.available === true ? " · F&O stocks only" : ""}`}
          </Text>
        </View>
      </View>

      <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel="Period">
        {PERIODS.map((entry) => {
          const on = entry.key === period;
          // A period the archive cannot cover yet stays pressable: its own reason is what the screen then
          // prints, which tells the trader more than a chip that looks broken.
          const short = windowOf(body, entry.key)?.available === false;
          return (
            <TouchableOpacity
              key={entry.key}
              style={[styles.chip, on && styles.chipOn]}
              onPress={() => setPeriod(entry.key)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`Last ${entry.sessions} session${entry.sessions === 1 ? "" : "s"}`}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn, !on && short && { opacity: 0.45 }]}>
                {entry.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {view && view.available === false ? (
        <View style={styles.band}>
          <Text style={styles.bandText}>{`${periodLabel} buildup needs more stored F&O sessions.`}</Text>
          <Text style={[styles.caution, { marginTop: 6, marginBottom: 0 }]}>{view.reason}</Text>
        </View>
      ) : null}

      {view?.available === true ? (
        <>
          <View style={styles.band}>
            <Text style={styles.bandText}>{regimeLine(view)}</Text>
          </View>
          {expiryCaution(view) ? <Text style={styles.caution}>{expiryCaution(view)}</Text> : null}
        </>
      ) : null}

      {selected ? (
        <>
          <View style={[styles.card, { borderColor: tierColour(tierOf(selected.smfi)) }]}>
            <View style={styles.cardHead}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardName}>{`${selected.name} · ${periodLabel}`}</Text>
                <Text style={styles.cardSub}>{sectorFigures(selected)}</Text>
                <Text style={styles.cardSub}>{sectorCoverage(selected)}</Text>
                <Text style={styles.cardSub}>{buildupLine(selected.counts)}</Text>
              </View>
              <View>
                <Text style={[styles.cardScore, { color: tierColour(tierOf(selected.smfi)) }]}>
                  {smfiWord(selected.smfi)}
                </Text>
                <Text style={styles.cardState}>{TIER_NAME[tierOf(selected.smfi)]}</Text>
              </View>
            </View>
          </View>

          <Text style={styles.section}>{`Stocks in ${selected.name} (${stocks.length})`}</Text>
          {stocks.length === 0 ? (
            <Text style={styles.silent}>The stored dataset has no futures stock for this sector in this window.</Text>
          ) : (
            <>
              <View style={styles.tableHead}>
                {STOCK_COLUMNS.map((column, index) => (
                  <TouchableOpacity
                    key={column.key}
                    style={[styles.headCell, index === 0 ? { flex: 1, minWidth: widths[0] } : { width: widths[index] }]}
                    onPress={() => onSort(column.key)}
                    accessibilityRole="button"
                    accessibilityLabel={`Sort by ${column.label}`}
                  >
                    <Text
                      style={[styles.headText, column.numeric && { textAlign: "right" }, sort?.key === column.key && styles.headTextOn]}
                      numberOfLines={2}
                    >
                      {`${column.label}${sort?.key === column.key ? (sort.descending ? " ▼" : " ▲") : ""}`}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              {listed.map((row, index) => (
                <StockRow key={`${row.symbol}-${index}`} row={row} styles={styles} widths={widths} toneColour={toneColour} />
              ))}
              <Text style={styles.legend}>
                {`Buildup: LBU ${STATE_HELP.LBU} · SC ${STATE_HELP.SC} · LU ${STATE_HELP.LU} · SBU ${STATE_HELP.SBU} · N ${STATE_HELP.N}.`}
              </Text>
              <Text style={styles.legend}>
                {`The small line under a figure is the look-back that does not fit beside it: 1-week and 1-month change, open-interest value in rupees, delivery share. A dash is a figure the archive did not store, never a zero.`}
              </Text>
              {selected.excluded > 0 ? (
                <Text style={styles.legend}>
                  {`${selected.excluded} of the ${selected.covered} futures stocks are left out of the sector's score: no direction, no open interest, or a move past 25% that looks like a split or bonus.`}
                </Text>
              ) : null}
            </>
          )}
        </>
      ) : (
        <>
          <Text style={styles.section}>{`Sector board · ${periodLabel} money flow`}</Text>
          {ranked.length === 0 ? (
            <Text style={styles.silent}>No sector in the stored dataset could be scored for this period. The reasons are listed below.</Text>
          ) : (
            ranked.map((row) => (
              <SectorCard
                key={row.key}
                row={row}
                colors={colors}
                styles={styles}
                colour={tierColour(tierOf(row.smfi))}
                onPress={() => setChosen(row.key)}
              />
            ))
          )}
          {silent.length > 0 ? (
            <>
              <Text style={[styles.section, { marginTop: 14 }]}>Sectors with no score</Text>
              {silent.map((row) => (
                <Text key={row.key} style={styles.silent}>{`${row.name}: ${row.reason}`}</Text>
              ))}
            </>
          ) : null}
        </>
      )}

      {body.notes && body.notes.length > 0 ? (
        <>
          <TouchableOpacity
            style={styles.noteToggle}
            onPress={() => setNotesOpen(open => !open)}
            accessibilityRole="button"
            accessibilityLabel="How these numbers are built"
            accessibilityState={{ expanded: notesOpen }}
          >
            <Text style={styles.noteToggle}>
              {notesOpen ? "Hide how these numbers are built" : `How these numbers are built (${body.notes.length})`}
            </Text>
          </TouchableOpacity>
          {notesOpen
            ? body.notes.map((note, index) => (
              <Text key={`${index}-${note.slice(0, 12)}`} style={styles.note}>{`· ${note}`}</Text>
            ))
            : null}
        </>
      ) : null}
    </ScrollView>
  );
}

/** One sector: its score and band, the buildup split of its constituents, and the moves behind the score. */
function SectorCard({ row, colors, styles, colour, onPress }: {
  row: Sector;
  colors: Palette;
  styles: ReturnType<typeof StyleSheet.create>;
  colour: string;
  onPress: () => void;
}) {
  const { bull, bear, flat } = buildupSplit(row.counts);
  const total = bull + bear + flat;
  const strength = row.smfi === null ? 0 : Math.min(1, Math.abs(row.smfi) / 100);
  return (
    <TouchableOpacity
      style={[styles.card, { borderColor: colour }]}
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={`${row.name}: score ${smfiWord(row.smfi)}, ${TIER_NAME[tierOf(row.smfi)]}, ${buildupLine(row.counts)}. Opens the stocks inside it.`}
    >
      <View style={styles.cardHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardName}>{row.name}</Text>
          <Text style={styles.cardSub}>{buildupLine(row.counts)}</Text>
          <Text style={styles.cardSub}>{`${sectorFigures(row)} · ${sectorCoverage(row)}`}</Text>
        </View>
        <View>
          <Text style={[styles.cardScore, { color: colour }]}>{smfiWord(row.smfi)}</Text>
          <Text style={styles.cardState}>{sectorStateWord(row)}</Text>
        </View>
      </View>
      {/* The wide bar is the constituents, not the score: a sector can lean one way across ten names and still
          score mildly because its total open interest barely moved. Both figures are on the card for that reason,
          and the thin bar under the wide one is the score itself, -100 to +100. */}
      <View style={styles.splitBar}>
        {total > 0 ? (
          <>
            <View style={{ width: `${(bull / total) * 100}%`, backgroundColor: colors.bull }} />
            <View style={{ width: `${(flat / total) * 100}%`, backgroundColor: colors.flat }} />
            <View style={{ width: `${(bear / total) * 100}%`, backgroundColor: colors.bear }} />
          </>
        ) : (
          <View style={{ flex: 1, backgroundColor: colors.flat, opacity: 0.4 }} />
        )}
      </View>
      <View style={[styles.scoreBar, { backgroundColor: colors.flat, opacity: 0.35 }]}>
        <View style={{ width: `${strength * 100}%`, height: 3, backgroundColor: colour }} />
      </View>
    </TouchableOpacity>
  );
}

/** One constituent. Every figure, and the small line under it, comes from the shared cell formatter. */
function StockRow({ row, styles, widths, toneColour }: {
  row: SectorStock;
  styles: ReturnType<typeof StyleSheet.create>;
  widths: number[];
  toneColour: (tone: CellTone) => string;
}) {
  return (
    <View style={styles.row}>
      {STOCK_COLUMNS.map((column, index) => {
        const cell = stockCell(row, column.key);
        const first = index === 0;
        // A neutral buildup is drawn in the quiet colour, not the "no figure" one, but it must not read as a
        // direction either: "N" is the server's own neutral, so it takes the muted ink of a label.
        const pill = column.key === "state" ? toneColour(cell.tone === "flat" ? "muted" : cell.tone) : "";
        return (
          <View
            key={column.key}
            style={first
              ? { flex: 1, minWidth: widths[0], paddingRight: GUTTER }
              : { width: widths[index], paddingRight: GUTTER }}
          >
            {column.key === "state" ? (
              <View style={[styles.pill, { backgroundColor: `${pill}22` }]}>
                <Text style={[styles.pillText, { color: pill }]}>{cell.text}</Text>
              </View>
            ) : (
              <Text
                style={[first ? styles.symbol : styles.value, !first && { textAlign: "right" }, { color: toneColour(cell.tone) }]}
                numberOfLines={first ? 2 : 1}
              >
                {cell.text}
              </Text>
            )}
            <Text style={[styles.sub, first ? null : { textAlign: "right" }]} numberOfLines={1}>
              {cell.sub}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
