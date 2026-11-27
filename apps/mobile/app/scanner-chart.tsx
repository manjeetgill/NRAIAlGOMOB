/**
 * Scan Chart Screen - the chart behind one scanner signal
 *
 * A tap on a scanner row opens the same thing the web scanner opens: the candles that saved scan was run
 * on, drawn with the level the rule tested, the tolerance band around it, and the studies the scan stored.
 * Every number here comes from `GET /v1/technical-events/evidence` for that exact instrument, session,
 * timeframe and run, so the chart cannot drift onto candles the signal was never seen on. A level the
 * server did not file is left off the chart instead of guessed, and the screen says so.
 */

import React, { useMemo, useState, useCallback } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useCanGoBack, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { formatISTDate, formatISTTime, formatRupees } from "@nraialgo/shared/utils";
import type { ScannerEvidenceEvent } from "@nraialgo/shared/api";
import { useTheme } from "@/components/ThemeProvider";
import { useApi } from "@/hooks/useApi";
import KLineChart, { type ChartAction } from "@/components/KLineChart";
import { evidenceCandles, scanMarkers, scanOverlays, scanPanes, asMs } from "@/utils/scan-chart";

const SIGNAL_LABELS: Record<string, string> = {
  breakout: "Breakout",
  breakdown: "Breakdown",
  support_touch: "Support touch",
  resistance_touch: "Resistance touch",
  breakout_retest: "Breakout retest",
  breakdown_retest: "Breakdown retest",
  hm_rsi_supertrend_buy: "HM buy",
  hm_rsi_supertrend_sell: "HM sell",
};

const INTRADAY = new Set(["1h", "30m", "15m"]);

/** A daily scan's candle is its session; an intraday one needs the hour it closed at as well. */
function candleStamp(ms: number | null, timeframe: string): string {
  if (!ms) return "no candle time filed";
  return INTRADAY.has(timeframe) ? `${formatISTDate(ms)} ${formatISTTime(ms)}` : formatISTDate(ms);
}

/** A scan is HM when the row that was tapped, or the first event served, says so. */
const isHm = (focusKind: string, events: ScannerEvidenceEvent[]) =>
  (focusKind || events[0]?.kind || "").startsWith("hm_");

const makeStyles = (colors: { bg: string; card: string; text: string; muted: string; border: string; accent: string }) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    head: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.border },
    headMain: { flex: 1 },
    title: { fontSize: 16, fontWeight: "700", color: colors.text },
    meta: { fontSize: 11, color: colors.muted, marginTop: 2 },
    card: { backgroundColor: colors.card, margin: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: 12 },
    cardFocus: { borderColor: colors.accent },
    cardTitle: { fontSize: 12, fontWeight: "600", color: colors.text },
    cardNote: { fontSize: 11, color: colors.muted, marginTop: 2, marginBottom: 8 },
    chartControls: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 8,
      paddingTop: 8,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    controlGroup: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    controlBtn: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 8,
      paddingVertical: 5,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.bg,
    },
    controlBtnText: {
      fontSize: 11,
      fontWeight: "600",
      color: colors.text,
      marginLeft: 2,
    },
    eventHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
    badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, fontSize: 10, fontWeight: "600", backgroundColor: "rgba(56,189,248,0.15)", color: colors.accent },
    row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
    label: { fontSize: 11, color: colors.muted },
    value: { fontSize: 13, fontWeight: "500", color: colors.text },
    why: { fontSize: 11, color: colors.muted, marginTop: 6, lineHeight: 16 },
    legend: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 8 },
    centre: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40 },
    emptyText: { fontSize: 14, color: colors.muted, textAlign: "center" },
    footer: { paddingHorizontal: 12, paddingBottom: 20 },
    footerText: { fontSize: 10, color: colors.muted, textAlign: "center", lineHeight: 15 },
  });

type Styles = ReturnType<typeof makeStyles>;

function EventCard({ event, timeframe, focus, styles, colors }: {
  event: ScannerEvidenceEvent;
  timeframe: string;
  focus: boolean;
  styles: Styles;
  colors: { text: string; muted: string; buy: string; sell: string };
}) {
  const ms = asMs(event.timestamp);
  const level = typeof event.level === "number" && Number.isFinite(event.level) ? event.level : null;
  const tolerance = typeof event.tolerance === "number" && Number.isFinite(event.tolerance) ? event.tolerance : null;
  const close = typeof event.close === "number" && Number.isFinite(event.close) ? event.close : null;
  const lower = event.evidence?.lower ?? (level !== null && tolerance !== null ? level - tolerance : null);
  const upper = event.evidence?.upper ?? (level !== null && tolerance !== null ? level + tolerance : null);
  const bullish = event.kind.includes("buy") || event.kind.startsWith("breakout") || event.kind === "resistance_touch";
  const gap = level !== null && close !== null ? close - level : null;
  const ratio = typeof event.evidence?.volumeRatio === "number" && Number.isFinite(event.evidence.volumeRatio) ? event.evidence.volumeRatio : null;

  return (
    <View style={[styles.card, focus && styles.cardFocus]}>
      <View style={styles.eventHead}>
        <Text style={styles.badge}>{SIGNAL_LABELS[event.kind] ?? event.kind.replace(/_/g, " ")}</Text>
        <Text style={styles.meta}>{candleStamp(ms, timeframe)}</Text>
      </View>
      {close !== null ? (
        <View style={styles.row}>
          <Text style={styles.label}>Candle close</Text>
          <Text style={[styles.value, { color: bullish ? colors.buy : colors.sell }]}>{formatRupees(close)}</Text>
        </View>
      ) : null}
      {level !== null ? (
        <View style={styles.row}>
          <Text style={styles.label}>Rule level</Text>
          <Text style={styles.value}>{formatRupees(level)}</Text>
        </View>
      ) : null}
      {lower !== null && upper !== null ? (
        <View style={styles.row}>
          <Text style={styles.label}>Tolerance band</Text>
          <Text style={styles.value}>{`${formatRupees(lower)} – ${formatRupees(upper)}`}</Text>
        </View>
      ) : null}
      {gap !== null ? (
        <View style={styles.row}>
          <Text style={styles.label}>Close against level</Text>
          <Text style={[styles.value, { color: bullish ? colors.buy : colors.sell }]}>
            {`${gap >= 0 ? "+" : "−"}${formatRupees(Math.abs(gap))}`}
          </Text>
        </View>
      ) : null}
      {ratio !== null ? (
        <View style={styles.row}>
          <Text style={styles.label}>Volume vs prior 20</Text>
          <Text style={styles.value}>{`${ratio.toFixed(2)}×${event.evidence?.volumeStatus ? ` · ${event.evidence.volumeStatus.replace(/_/g, " ")}` : ""}`}</Text>
        </View>
      ) : null}
      {event.explanation ? <Text style={styles.why}>{event.explanation}</Text> : null}
    </View>
  );
}

export default function ScannerChartScreen() {
  const params = useLocalSearchParams<{ instrument?: string; session?: string; timeframe?: string; run_id?: string; kind?: string }>();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const { useScannerEvidence } = useApi();
  const { resolvedTheme } = useTheme();

  const instrument = String(params.instrument ?? "").trim().toUpperCase();
  const session = String(params.session ?? "").trim();
  const timeframe = String(params.timeframe ?? "").trim() || "1d";
  const runId = String(params.run_id ?? "").trim();
  const focusKind = String(params.kind ?? "").trim();

  const identity = useMemo(
    () => ({ instrument, session, timeframe, ...(runId ? { runId } : {}) }),
    [instrument, session, timeframe, runId],
  );

  const { data: evidence, isLoading, isError, error, refetch } = useScannerEvidence(identity);
  const candles = useMemo(() => evidenceCandles(evidence), [evidence]);
  const overlays = useMemo(() => scanOverlays(evidence, focusKind || undefined), [evidence, focusKind]);
  const markers = useMemo(() => scanMarkers(evidence), [evidence]);
  const panes = useMemo(() => scanPanes(evidence, focusKind || undefined), [evidence, focusKind]);

  // Chart pan & zoom controls state
  const [chartAction, setChartAction] = useState<ChartAction | null>(null);
  // While a finger is on the chart the page stops scrolling, so a sideways drag pans the candles.
  const [chartTouched, setChartTouched] = useState(false);
  const dispatchAction = useCallback((type: ChartAction["type"]) => {
    setChartAction({ type, nonce: Date.now() });
  }, []);

  const colors = useMemo(() => resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#94a3b8", border: "#334155", accent: "#38bdf8", buy: "#22c55e", sell: "#ef4444" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", accent: "#0284c7", buy: "#16a34a", sell: "#dc2626" }, [resolvedTheme]);
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const goBack = () => (canGoBack ? router.back() : router.replace("/scanner"));
  const events = evidence?.events ?? [];
  const last = candles[candles.length - 1];
  const levelLines = overlays.filter((overlay) => overlay.name === "horizontalStraightLine").length;

  if (isLoading) {
    return (
      <View style={[styles.centre, { backgroundColor: colors.bg }]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (isError) {
    const missing = (error as { status?: number } | null)?.status === 404;
    return (
      <View style={styles.container}>
        <View style={styles.head}>
          <TouchableOpacity onPress={goBack} hitSlop={10} accessibilityLabel="Go back">
            <Ionicons name="arrow-back" size={20} color={colors.text} />
          </TouchableOpacity>
          <View style={styles.headMain}>
            <Text style={styles.title}>{instrument}</Text>
            <Text style={styles.meta}>{`${session} · ${timeframe}`}</Text>
          </View>
        </View>
        <View style={styles.centre}>
          <Text style={styles.emptyText}>
            {missing
              ? "The server holds no candle history for this saved scan, so there is nothing to chart."
              : "The scan chart could not be read."}
          </Text>
          <TouchableOpacity style={{ marginTop: 16, paddingVertical: 12 }} onPress={() => void refetch()} accessibilityRole="button" accessibilityLabel="Retry the scan chart">
            <Text style={{ color: colors.accent, fontWeight: "600" }}>Tap to retry</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.head}>
        <TouchableOpacity onPress={goBack} hitSlop={10} accessibilityLabel="Go back">
          <Ionicons name="arrow-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headMain}>
          <Text style={styles.title}>{instrument}</Text>
          <Text style={styles.meta}>
            {`${session} · ${timeframe} · ${candles.length} candle${candles.length === 1 ? "" : "s"}`}
            {evidence?.source ? ` · ${evidence.source}` : ""}
          </Text>
        </View>
        {last ? (
          <View>
            <Text style={[styles.title, { textAlign: "right" }]}>{formatRupees(last.close)}</Text>
            <Text style={[styles.meta, { textAlign: "right" }]}>scan candle close</Text>
          </View>
        ) : null}
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 24 }} scrollEnabled={!chartTouched}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{`Saved ${timeframe} chart`}</Text>
          <Text style={styles.cardNote}>
            {isHm(focusKind, events)
              ? "Supertrend and the RSI crossover the scan recorded, on the candles it was run on."
              : "The rule's level, its tolerance band and the studies the scan saved."}
          </Text>
          {candles.length ? (
            <>
              <KLineChart
                data={candles}
                height={260 + panes.filter((pane) => pane.paneId !== "candle_pane").length * 90}
                overlays={overlays}
                markers={markers}
                panes={panes}
                action={chartAction}
                onTouchActive={setChartTouched}
              />
              <View style={styles.chartControls}>
                <View style={styles.controlGroup}>
                  <TouchableOpacity
                    style={styles.controlBtn}
                    onPress={() => dispatchAction("scroll_left")}
                    accessibilityRole="button"
                    accessibilityLabel="Pan left"
                  >
                    <Ionicons name="arrow-back" size={14} color={colors.text} />
                    <Text style={styles.controlBtnText}>Left</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.controlBtn}
                    onPress={() => dispatchAction("scroll_right")}
                    accessibilityRole="button"
                    accessibilityLabel="Pan right"
                  >
                    <Ionicons name="arrow-forward" size={14} color={colors.text} />
                    <Text style={styles.controlBtnText}>Right</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.controlBtn}
                    onPress={() => dispatchAction("reset")}
                    accessibilityRole="button"
                    accessibilityLabel="Reset chart position"
                  >
                    <Ionicons name="locate-outline" size={14} color={colors.text} />
                    <Text style={styles.controlBtnText}>Latest</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.controlGroup}>
                  <TouchableOpacity
                    style={styles.controlBtn}
                    onPress={() => dispatchAction("zoom_in")}
                    accessibilityRole="button"
                    accessibilityLabel="Zoom in"
                  >
                    <Ionicons name="add" size={15} color={colors.text} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.controlBtn}
                    onPress={() => dispatchAction("zoom_out")}
                    accessibilityRole="button"
                    accessibilityLabel="Zoom out"
                  >
                    <Ionicons name="remove" size={15} color={colors.text} />
                  </TouchableOpacity>
                </View>
              </View>
              {levelLines ? (
                <View style={styles.legend}>
                  <Legend swatch="#d97706" text="Rule level" color={colors.muted} />
                  <Legend swatch="#64748b" text="Tolerance band" color={colors.muted} />
                  {overlays.some((o) => o.name === "rayLine") ? <Legend swatch="#0ea5e9" text="Confirmed pivot" color={colors.muted} /> : null}
                  {overlays.some((o) => o.color === "#a855f7") ? <Legend swatch="#a855f7" text="Original break" color={colors.muted} /> : null}
                </View>
              ) : null}
            </>
          ) : (
            <Text style={styles.emptyText}>The saved scan filed no candles, so the chart has nothing to draw.</Text>
          )}
        </View>

        {candles.length && !levelLines ? (
          <View style={styles.footer}>
            <Text style={styles.footerText}>
              This account was served the candles alone — the level a rule was tested against is a research
              detail the server files only for its owner.
            </Text>
          </View>
        ) : null}

        {events.map((event, index) => (
          <EventCard
            key={`${event.kind}-${event.timestamp ?? index}`}
            event={event}
            timeframe={timeframe}
            focus={focusKind ? event.kind === focusKind : index === 0}
            styles={styles}
            colors={colors}
          />
        ))}

        <View style={styles.footer}>
          <Text style={styles.footerText}>
            {`Data through ${evidence?.session ?? session}${evidence?.signalCompletedAt ? ` · last completed candle ${candleStamp(asMs(evidence.signalCompletedAt), timeframe)}` : ""}. `
              + "Saved scan on completed candles — a research observation, not an executed trade."}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

function Legend({ swatch, text, color }: { swatch: string; text: string; color: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <View style={{ width: 14, height: 2, backgroundColor: swatch }} />
      <Text style={{ fontSize: 10, color }}>{text}</Text>
    </View>
  );
}
