/**
 * Algo Lab detail — open one algo and see what the web desk shows: the payoff curve, its saved settings,
 * and the controls. Live only, reached by tapping a Running card or a My-strategies card.
 *
 * The data is prod's own, read the same way the web reads it. The payoff is priced by the identical
 * POST /v1/strategy-analysis the web payoff tab calls, so the curve and the max-profit / max-loss / POP /
 * break-even figures match the desk field for field. A running algo is priced from its live positions; a
 * saved strategy is previewed from its stored draft legs.
 *
 * Settings are editable exactly where the server accepts an edit: a saved strategy copy (and a running
 * algo that came from a copy, by editing that copy before starting the next one) saves through
 * PUT /v1/strategy-copies/{id} under the version it was loaded at. A live run's own rules are shown
 * read-only, because that contract is not one this app sends. Nothing places or changes a live order on
 * its own — a start needs the broker gates open, an explicit acknowledgement and one press.
 */

import React, { useMemo, useState } from "react";
import {
  ActivityIndicator, Modal, PanResponder, RefreshControl, ScrollView, StyleSheet, Text,
  TextInput, TouchableOpacity, View, useWindowDimensions,
} from "react-native";
import Svg, { Circle, Line, Path } from "react-native-svg";
import { Ionicons } from "@expo/vector-icons";
import { useCanGoBack, useLocalSearchParams, useRouter } from "expo-router";
import { newClientId } from "@nraialgo/shared/hooks";
import { curves, payoffFigures } from "@nraialgo/shared/api";
import type { ManagedRun, StrategyAnalysisLeg, StrategyDraftSummary, DraftDetail } from "@nraialgo/shared/api";
import { useApi } from "@/hooks/useApi";
import { useTheme } from "@/components/ThemeProvider";
import { useScreenFocused } from "@/hooks/useScreenFocused";

type TabId = "payoff" | "settings" | "actions";
type Source = "run" | "draft";

/** Decimal-string money to a number, or null when the server sent nothing usable. */
const num = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const rupee = (value: number | null) =>
  value === null ? "—" : `${value >= 0 ? "+" : "-"}₹${Math.abs(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

/** The common strategy knobs the web copy form edits. Absent keys are skipped; unknown keys are preserved on save. */
const EDITABLE_KEYS: [string, string][] = [
  ["lots", "Lots"],
  ["deploymentLots", "Deployment lots"],
  ["capital", "Capital (₹)"],
  ["targetProfit", "Target profit (₹)"],
  ["maxLoss", "Max loss (₹)"],
  ["wingPoints", "Wing points"],
  ["shortDistance", "Short distance (pts)"],
  ["longWidth", "Long width (pts)"],
  ["targetDelta", "Target delta"],
  ["exitTime", "Exit time (IST)"],
  ["expiry", "Expiry (YYYY-MM-DD)"],
];

const isOpen = (run: ManagedRun) => !["closed", "cancelled", "completed", "withdrawn"].includes(run.status);

export default function AlgoLabDetailScreen() {
  const {
    useManagedRuns, useDraftDetail, useOptionChain, useStrategyAnalysis,
    useLiveReadiness, useStartLiveCopy, useCloseRun, useUpdateCopy,
  } = useApi();
  const params = useLocalSearchParams<{ source?: string; id?: string; name?: string }>();
  const router = useRouter();
  // A cold start on a deep link leaves nothing behind this screen, and `back()` with no history is a press
  // that does nothing at all. The list is where this row came from, so that is where the arrow goes.
  const canGoBack = useCanGoBack();
  const goBack = () => (canGoBack ? router.back() : router.replace("/algo-lab"));
  const source: Source = params.source === "run" ? "run" : "draft";
  const id = String(params.id ?? "");
  const { resolvedTheme } = useTheme();
  const { width: screenWidth } = useWindowDimensions();

  const [activeTab, setActiveTab] = useState<TabId>("payoff");
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmStart, setConfirmStart] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string> | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [touchPx, setTouchPx] = useState<number | null>(null);

  const runs = useManagedRuns({
    enabled: source === "run",
    staleTime: 15_000,
    gcTime: 15 * 60 * 1000,
  });
  const run = source === "run" ? (runs.data?.runs ?? []).find(r => r.id === id) ?? null : null;

  // A saved strategy is edited through its copy id; a running algo is edited through the copy it started
  // from. Both resolve to one strategy-draft detail carrying legs + the editable config.
  const copyId = source === "draft" ? id : (run?.strategy_copy_id ?? "");
  const draft = useDraftDetail(copyId || null, {
    enabled: !!copyId,
    staleTime: 30_000,
    gcTime: 15 * 60 * 1000,
  });

  const title = source === "run" ? (run?.name || params.name || "Algo") : (draft.data?.name || params.name || "Strategy");
  const underlying = run?.basket?.underlying || draft.data?.underlying || "";

  // The ladder read is only asked once the underlying is known; its spot seeds the payoff x-axis.
  const legExpiry = useMemo(() => {
    const dates = (run?.positions ?? []).map(p => p.expiry)
      .concat((draft.data?.legs ?? []).map(l => l.expiry))
      .filter(Boolean);
    return dates.length ? dates.slice().sort()[0] : "";
  }, [run, draft.data]);

  const chain = useOptionChain(underlying, legExpiry, { enabled: !!underlying && activeTab === "payoff" });
  const spot = num(chain.data?.spot?.price);

  const analysisLegs = useMemo<StrategyAnalysisLeg[]>(() => {
    if (source === "run") {
      return (run?.positions ?? [])
        .filter(p => p.openQuantity > 0)
        .map(p => ({
          action: (p.action === "S" || p.action === "sell" ? "sell" : "buy") as "buy" | "sell",
          right: (p.right === "PE" || p.right === "P" ? "PE" : "CE") as "CE" | "PE",
          exchange: "NSE" as const,
          strike: String(p.strike),
          expiry: p.expiry,
          lots: p.openQuantity,
          lotSize: 1,
          price: String(p.markPrice ?? p.entryPrice ?? "0"),
          entryPrice: p.entryPrice != null ? String(p.entryPrice) : undefined,
        }));
    }
    return (draft.data?.legs ?? []).map(l => ({
      action: (l.action === "S" || l.action === "sell" ? "sell" : "buy") as "buy" | "sell",
      right: (l.right === "PE" || l.right === "P" ? "PE" : "CE") as "CE" | "PE",
      exchange: "NSE" as const,
      strike: String(l.strike),
      expiry: l.expiry,
      lots: l.lots,
      lotSize: l.lotSize ?? 1,
      price: String(l.reference?.price ?? "0"),
      ...(l.reference?.price != null ? { entryPrice: String(l.reference.price) } : {}),
      ...(l.reference?.spot != null ? { entrySpot: String(l.reference.spot) } : {}),
      ...(l.reference?.pricedAt != null ? { pricedAt: String(l.reference.pricedAt) } : {}),
    }));
  }, [source, run, draft.data]);

  const analysisBody = spot !== null && analysisLegs.length ? { spot: String(spot), rate: 0, dividend: 0, legs: analysisLegs } : null;
  const focused = useScreenFocused();
  const analysis = useStrategyAnalysis(analysisBody, { enabled: focused && !!analysisBody });

  const figures = useMemo(() => (analysis.data ? payoffFigures(analysis.data) : null), [analysis.data]);
  const curve = useMemo(() => (analysis.data ? curves(analysis.data) : null), [analysis.data]);

  const readiness = useLiveReadiness({ enabled: activeTab === "actions" && source === "draft" });
  const startLive = useStartLiveCopy();
  const closeRun = useCloseRun();
  const updateCopy = useUpdateCopy();

  const colors = useMemo(() => resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#64748b", border: "#334155", brand: "#38bdf8", buy: "#22c55e", sell: "#ef4444", warn: "#f59e0b" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", brand: "#0284c7", buy: "#16a34a", sell: "#dc2626", warn: "#b45309" }, [resolvedTheme]);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    header: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
    back: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
    title: { fontSize: 18, fontWeight: "700", color: colors.text, flexShrink: 1 },
    subtitle: { fontSize: 12, color: colors.muted, marginTop: 1 },
    tabs: { flexDirection: "row", gap: 6, marginHorizontal: 14, marginTop: 12 },
    tab: { flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, alignItems: "center" },
    tabOn: { borderColor: colors.brand, backgroundColor: `${colors.brand}22` },
    tabText: { fontSize: 14, fontWeight: "700", color: colors.muted },
    tabTextOn: { color: colors.text },
    body: { padding: 14, gap: 12 },
    card: { backgroundColor: colors.card, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: colors.border, gap: 8 },
    chartWrap: { alignItems: "center" },
    legend: { flexDirection: "row", gap: 16, flexWrap: "wrap", justifyContent: "center" },
    legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
    legendDot: { width: 10, height: 2, borderRadius: 1 },
    legendText: { fontSize: 11, color: colors.muted },
    zoomRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 14 },
    zoomBtn: { width: 30, height: 30, borderRadius: 8, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
    metrics: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    metric: { flexBasis: "47%", flexGrow: 1, backgroundColor: colors.bg, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: colors.border },
    metricLabel: { fontSize: 11, color: colors.muted, textTransform: "uppercase" },
    metricValue: { fontSize: 14, fontWeight: "700", color: colors.text, marginTop: 3 },
    sectionTitle: { fontSize: 13, fontWeight: "700", color: colors.text, marginTop: 4 },
    legRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    legSide: { width: 22, height: 22, borderRadius: 5, alignItems: "center", justifyContent: "center" },
    legSideText: { fontSize: 11, fontWeight: "800", color: "#ffffff" },
    legName: { fontSize: 13, color: colors.text, flex: 1 },
    legQty: { fontSize: 12, color: colors.muted },
    legPrice: { fontSize: 13, fontWeight: "600", color: colors.text, minWidth: 66, textAlign: "right" },
    meta: { fontSize: 12, color: colors.muted },
    note: { fontSize: 12.5, color: colors.muted, lineHeight: 19 },
    error: { fontSize: 12.5, color: colors.sell },
    fieldRow: { gap: 4 },
    fieldLabel: { fontSize: 12, color: colors.muted },
    input: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, color: colors.text, backgroundColor: colors.bg, fontSize: 14 },
    readonlyRow: { flexDirection: "row", justifyContent: "space-between", gap: 12, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
    readonlyLabel: { fontSize: 13, color: colors.muted, flex: 1 },
    readonlyValue: { fontSize: 13, fontWeight: "600", color: colors.text, flexShrink: 1, textAlign: "right" },
    button: { height: 48, borderRadius: 10, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center" },
    buttonDanger: { backgroundColor: colors.sell },
    buttonGhost: { height: 44, borderRadius: 10, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", backgroundColor: colors.card },
    buttonOff: { opacity: 0.4 },
    buttonText: { fontSize: 15, fontWeight: "700", color: "#ffffff" },
    buttonGhostText: { fontSize: 14, fontWeight: "600", color: colors.text },
    empty: { alignItems: "center", paddingVertical: 32, gap: 8 },
    emptyDesc: { fontSize: 13, color: colors.muted, textAlign: "center", lineHeight: 19, paddingHorizontal: 12 },
    scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 24 },
    ackRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
    ackBox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: ack ? colors.sell : colors.border, backgroundColor: ack ? colors.sell : "transparent", alignItems: "center", justifyContent: "center", marginTop: 1 },
    ackText: { fontSize: 13, color: colors.text, flex: 1, lineHeight: 19 },
    gate: { flexDirection: "row", alignItems: "center", gap: 8, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
    gateText: { fontSize: 12.5, color: colors.text, flex: 1 },
  }), [colors, ack]);

  const tabs: { id: TabId; label: string }[] = [
    { id: "payoff", label: "Payoff" },
    { id: "settings", label: "Settings" },
    { id: "actions", label: "Actions" },
  ];

  const chart = useMemo(() => {
    const spots = curve?.spots ?? [];
    const expiryY = curve?.expiry ?? null;
    if (!curve || spots.length < 3 || !expiryY) return null;
    const w = Math.round(screenWidth - 42);
    const h = 150; const padX = 6; const padTop = 12; const padBottom = 14;
    const fullLo = Math.min(...spots); const fullHi = Math.max(...spots);
    const center = (fullLo + fullHi) / 2; const half = (fullHi - fullLo) / 2 / zoom;
    const lo = center - half; const hi = center + half;
    const shown = spots.map((x, i) => ({ x, y: expiryY[i] })).filter(p => Number.isFinite(p.y) && p.x >= lo && p.x <= hi);
    const ys = shown.map(p => p.y).concat(curve.today ? curve.today.filter(Number.isFinite) : [], [0]);
    const yMin = Math.min(...ys); const yMax = Math.max(...ys);
    const yLo = yMax - yMin < 1 ? yMin - 1 : yMin; const yHi = yMax - yMin < 1 ? yMax + 1 : yMax;
    const px = (x: number) => padX + ((x - lo) / (hi - lo || 1)) * (w - padX * 2);
    const py = (y: number) => padTop + (1 - (y - yLo) / (yHi - yLo || 1)) * (h - padTop - padBottom);
    const line = (values: number[] | null) => {
      if (!values) return null;
      const pts = spots.map((x, i) => ({ x, y: values[i] })).filter(p => Number.isFinite(p.y) && p.x >= lo && p.x <= hi);
      return pts.length ? pts.map((p, j) => `${j === 0 ? "M" : "L"}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join("") : null;
    };
    const breakEvens = (analysis.data?.expiry?.breakevens ?? []).map(v => num(v)).filter((v): v is number => v !== null && v >= lo && v <= hi);
    const spotX = spot !== null && spot >= lo && spot <= hi ? px(spot) : null;
    const touchSpot = touchPx !== null ? lo + ((touchPx - padX) / (w - padX * 2)) * (hi - lo) : null;
    let touchValue: number | null = null;
    if (touchSpot !== null) {
      for (let i = 0; i < spots.length; i += 1) {
        const next = i + 1;
        const withinRange = spots[i] <= touchSpot && (next >= spots.length || spots[next] > touchSpot);
        if (withinRange) {
          const x0 = spots[i];
          const x1 = next < spots.length ? spots[next] : x0 + 1;
          const y0 = expiryY[i] ?? 0;
          const y1 = expiryY[next] ?? y0;
          touchValue = x1 === x0 ? y0 : y0 + ((touchSpot - x0) / (x1 - x0)) * (y1 - y0);
          break;
        }
      }
    }
    return {
      w, h, px, py, zero: py(0), lo, hi,
      expiryPath: line(expiryY), todayPath: line(curve.today),
      breakEvens, spotX, touchSpot, touchValue,
      atSpot: curve.atSpot ?? null,
      line,
    };
  }, [curve, screenWidth, zoom, touchPx, spot, analysis.data]);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: e => setTouchPx(e.nativeEvent.locationX),
    onPanResponderMove: e => setTouchPx(e.nativeEvent.locationX),
    onPanResponderRelease: () => setTouchPx(null),
    onPanResponderTerminate: () => setTouchPx(null),
  }), [chart]);

  // ---- Payoff tab ----
  const renderPayoff = () => {
    if (!analysisLegs.length) {
      return (
        <View style={styles.empty}>
          <Ionicons name="git-commit-outline" size={38} color={colors.muted} />
          <Text style={styles.emptyDesc}>No priced legs yet. This algo has no open legs to draw a payoff from.</Text>
        </View>
      );
    }
    return (
      <>
        {figures ? (
          <View style={styles.metrics}>
            <View style={styles.metric}>
              <Text style={styles.metricLabel}>Max profit</Text>
              <Text style={[styles.metricValue, { color: colors.buy }]}>{figures.maxProfit}</Text>
            </View>
            <View style={styles.metric}>
              <Text style={styles.metricLabel}>Max loss</Text>
              <Text style={[styles.metricValue, { color: colors.sell }]}>{figures.maxLoss}</Text>
            </View>
            <View style={styles.metric}>
              <Text style={styles.metricLabel}>Probability of profit</Text>
              <Text style={styles.metricValue}>{figures.pop}</Text>
            </View>
            <View style={styles.metric}>
              <Text style={styles.metricLabel}>Net</Text>
              <Text style={styles.metricValue}>{figures.net}</Text>
            </View>
          </View>
        ) : (
          <View style={styles.card}>
            {analysis.isFetching ? <ActivityIndicator color={colors.brand} /> : null}
            <Text style={styles.meta}>{analysis.isError ? analysis.error?.message ?? "The server could not price these legs." : "Pricing the payoff…"}</Text>
          </View>
        )}

        {chart ? (
          <View style={[styles.card, styles.chartWrap]}>
            <Text style={styles.meta}>{`${underlying}${spot !== null ? ` · spot ${spot.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : ""}${figures ? ` · ${figures.horizon}` : ""}`}</Text>
            <View {...panResponder.panHandlers}>
              <Svg width={chart.w} height={chart.h}>
                <Line x1={0} y1={chart.zero} x2={chart.w} y2={chart.zero} stroke={colors.border} strokeWidth={1} strokeDasharray="4 3" />
                {chart.todayPath ? <Path d={chart.todayPath} stroke={colors.muted} strokeWidth={1.5} strokeDasharray="5 3" fill="none" /> : null}
                <Path d={chart.expiryPath ?? ""} stroke={colors.brand} strokeWidth={2} fill="none" />
                {chart.breakEvens.map((be, i) => (
                  <Circle key={`be-${i}`} cx={chart.px(be)} cy={chart.zero} r={3} fill={colors.warn} />
                ))}
                {chart.spotX !== null ? (
                  <>
                    <Line x1={chart.spotX} y1={10} x2={chart.spotX} y2={chart.h - 12} stroke={colors.text} strokeWidth={0.6} opacity={0.5} />
                    {chart.atSpot !== null ? <Circle cx={chart.spotX} cy={chart.py(chart.atSpot)} r={3.5} fill={colors.text} /> : null}
                  </>
                ) : null}
                {chart.touchSpot !== null ? (
                  <Line x1={chart.px(chart.touchSpot)} y1={0} x2={chart.px(chart.touchSpot)} y2={chart.h} stroke={colors.text} strokeWidth={0.5} opacity={0.4} />
                ) : null}
              </Svg>
            </View>
            <View style={styles.legend}>
              <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: colors.brand }]} /><Text style={styles.legendText}>At expiry</Text></View>
              {curve?.today ? <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: colors.muted }]} /><Text style={styles.legendText}>T+0</Text></View> : null}
              <View style={styles.legendItem}><Circle cx={5} cy={5} r={3} fill={colors.warn} /><Text style={styles.legendText}>Break-even</Text></View>
            </View>
            {chart.touchSpot !== null ? (
              <Text style={styles.meta}>{`At ${chart.touchSpot.toLocaleString("en-IN", { maximumFractionDigits: 0 })}: ${rupee(chart.touchValue)}`}</Text>
            ) : null}
            <View style={styles.zoomRow}>
              <TouchableOpacity style={styles.zoomBtn} onPress={() => setZoom(z => Math.max(1, +(z * 1.5).toFixed(2)))} accessibilityLabel="Zoom in"><Text style={styles.buttonGhostText}>+</Text></TouchableOpacity>
              <TouchableOpacity style={styles.zoomBtn} onPress={() => { setZoom(1); setTouchPx(null); }} accessibilityLabel="Reset zoom"><Ionicons name="scan-outline" size={16} color={colors.text} /></TouchableOpacity>
              <TouchableOpacity style={styles.zoomBtn} onPress={() => setZoom(z => Math.max(1, +(z / 1.5).toFixed(2)))} accessibilityLabel="Zoom out"><Text style={styles.buttonGhostText}>−</Text></TouchableOpacity>
            </View>
          </View>
        ) : null}

        {analysis.data?.greeks?.available ? (
          <Text style={styles.meta}>{analysis.data.greeks.available ? figures?.greeks ?? "" : ""}</Text>
        ) : null}
        {figures ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Break-evens</Text>
            <Text style={styles.note}>{figures.breakEvens}</Text>
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Legs</Text>
          {(source === "run" ? (run?.positions ?? []).filter(p => p.openQuantity > 0).map(p => ({ key: p.instrumentId, side: p.action, label: `${p.right} ${p.strike} ${p.expiry}`, qty: p.openQuantity, price: num(p.markPrice ?? p.entryPrice) }))
            : (draft.data?.legs ?? []).map(l => ({ key: l.instrumentId, side: l.action, label: `${l.right} ${l.strike} ${l.expiry}`, qty: l.lots * (l.lotSize ?? 1), price: num(l.reference?.price) }))
          ).map(row => {
            const isBuy = !(row.side === "S" || row.side === "sell");
            return (
              <View key={row.key} style={styles.legRow}>
                <View style={[styles.legSide, { backgroundColor: isBuy ? colors.buy : colors.sell }]}><Text style={styles.legSideText}>{isBuy ? "B" : "S"}</Text></View>
                <Text style={styles.legName} numberOfLines={1}>{row.label}</Text>
                <Text style={styles.legQty}>{row.qty}</Text>
                <Text style={styles.legPrice}>{row.price === null ? "—" : row.price.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</Text>
              </View>
            );
          })}
          {analysis.data ? <Text style={styles.meta}>{`Priced by the same server the web desk uses · spot ${analysis.data.spot}`}</Text> : null}
        </View>
      </>
    );
  };

  // ---- Settings tab ----
  const config = (draft.data?.strategySetup?.config ?? {}) as Record<string, unknown>;
  const editable = !!copyId && !!draft.data?.strategySetup;
  const currentValues = (): Record<string, string> => {
    const base: Record<string, string> = {};
    for (const [key] of EDITABLE_KEYS) {
      if (config[key] !== undefined && config[key] !== null) base[key] = String(config[key]);
    }
    return base;
  };
  const edited = editing ?? currentValues();

  const dirty = editing !== null && Object.keys(editing).some(k => {
    const original = config[k];
    const asStr = original === null || original === undefined ? "" : String(original);
    return editing[k] !== asStr;
  });

  const saveSettings = async () => {
    if (!draft.data) return;
    setSaveError(null);
    const merged: Record<string, unknown> = { ...config };
    for (const [key, value] of Object.entries(editing ?? {})) {
      const original = config[key];
      const trimmed = value.trim();
      if (typeof original === "number" || (typeof original === "string" && original !== "" && Number.isFinite(Number(original)))) {
        merged[key] = trimmed === "" ? original : Number(trimmed);
      } else {
        merged[key] = trimmed;
      }
    }
    try {
      await updateCopy.mutateAsync({ copyId, body: { draftVersion: draft.data.updatedAt, config: merged } });
      setEditing(null);
      setNotice("Saved. The next start uses these settings; an already-open run keeps what it entered with.");
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "The save failed.";
      setSaveError(msg.includes("409") || /version|changed|conflict/i.test(msg)
        ? "This strategy changed since you opened it. Reload it before editing again."
        : msg);
      void draft.refetch();
    }
  };

  const renderSettings = () => {
    if (source === "run" && !editable) {
      return (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Managed rules (read-only)</Text>
          <Text style={styles.note}>This live run's rules can only be changed on the web desk, so nothing here can alter what the engine does next.</Text>
          {Object.entries(run?.rules ?? {}).map(([key, value]) => (
            <View key={key} style={styles.readonlyRow}>
              <Text style={styles.readonlyLabel}>{key}</Text>
              <Text style={styles.readonlyValue} numberOfLines={3}>{typeof value === "object" ? JSON.stringify(value) : String(value)}</Text>
            </View>
          ))}
          {!run ? <Text style={styles.meta}>Loading this run…</Text> : null}
        </View>
      );
    }
    if (!editable) {
      return (
        <View style={styles.empty}>
          <Ionicons name="lock-closed-outline" size={38} color={colors.muted} />
          <Text style={styles.emptyDesc}>{draft.isLoading ? "Reading the saved strategy…" : "This strategy has no editable rule set on the phone. Open it on the web desk to change its rules."}</Text>
        </View>
      );
    }
    const keys = EDITABLE_KEYS.filter(([key]) => config[key] !== undefined && config[key] !== null);
    return (
      <View style={styles.card}>
        <Text style={styles.note}>{draft.data?.strategySetup?.template ? `Template · ${draft.data.strategySetup.template}` : "Settings"} — changes save to this saved strategy and are used the next time it starts.</Text>
        {keys.map(([key, label]) => (
          <View key={key} style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>{label}</Text>
            <TextInput
              style={styles.input}
              value={edited[key] ?? ""}
              onChangeText={value => setEditing(prev => ({ ...(prev ?? currentValues()), [key]: value }))}
              keyboardType={["exitTime", "expiry"].includes(key) ? "default" : "numeric"}
              placeholderTextColor={colors.muted}
            />
          </View>
        ))}
        {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
        <TouchableOpacity
          style={[styles.button, (!dirty || updateCopy.isPending) && styles.buttonOff]}
          disabled={!dirty || updateCopy.isPending}
          onPress={() => void saveSettings()}
          accessibilityRole="button" accessibilityLabel="Save settings to this strategy"
        >
          {updateCopy.isPending ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.buttonText}>Save settings</Text>}
        </TouchableOpacity>
        <Text style={styles.meta}>Editing these does not place, change or close any live order.</Text>
      </View>
    );
  };

  // ---- Actions tab ----
  const ready = readiness.data;
  const gateOpen = !!ready?.available && ready?.executionReady !== false && !!ready?.provider && !!ready?.accountId;

  const startFromStrategy = async () => {
    const detail = draft.data;
    if (!detail || !ack || !gateOpen) return;
    setStartError(null);
    try {
      const result = await startLive.mutateAsync({
        copyId: detail.id,
        body: { requestId: newClientId(), draftVersion: detail.updatedAt, mode: "live", provider: ready!.provider!, accountId: ready!.accountId!, acknowledge: true },
      });
      setNotice(result.queued
        ? `Armed for the next market open. ${detail.name} picks its strikes from these rules when the market opens.`
        : result.status === "open" ? "Live run opened with these rules." : `Live start accepted · ${result.status}. Acceptance is not a confirmed fill.`);
    } catch (cause) {
      setStartError(cause instanceof Error ? cause.message : "The live start could not be confirmed.");
    }
  };

  const confirmClose = async () => {
    if (!run) return;
    setConfirmStop(false);
    try {
      await closeRun.mutateAsync(run.id);
      setNotice(`Stop requested for ${run.name}. A pending adjustment is cancelled and every remaining leg closes on fresh quotes.`);
      void runs.refetch();
    } catch (cause) {
      setNotice(cause instanceof Error ? `Stop failed: ${cause.message}` : "The stop could not be confirmed.");
    }
  };

  const renderActions = () => {
    const running = source === "run" && run;
    if (running) {
      return (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{`${run!.status}${run!.provider ? ` · ${run!.provider}` : ""}`}</Text>
          {run!.health?.detail ? <Text style={styles.note}>{run!.health.label ? `${run!.health.label}: ${run!.health.detail}` : run!.health.detail}</Text> : null}
          {run!.last_error ? <Text style={styles.error}>{run!.last_error}</Text> : null}
          <Text style={styles.meta}>{`P&L ${num(run!.pnl) === null ? "—" : rupee(num(run!.pnl))}${run!.mark_quality === "stale" ? " · stale mark" : ""}`}</Text>
          {isOpen(run!) ? (
            <>
              <TouchableOpacity style={[styles.buttonGhost, { borderColor: colors.sell, marginTop: 6 }]} onPress={() => setConfirmStop(true)} accessibilityRole="button" accessibilityLabel="Stop and close this algo">
                <Text style={[styles.buttonGhostText, { color: colors.sell }]}>Stop and close</Text>
              </TouchableOpacity>
              <Text style={styles.meta}>Closing sends real broker orders to flatten every leg.</Text>
            </>
          ) : <Text style={styles.meta}>This run is no longer open, so there is nothing to stop.</Text>}
        </View>
      );
    }
    // Strategy source: gated live start.
    if (!draft.data) {
      return <View style={styles.empty}>{draft.isLoading ? <ActivityIndicator color={colors.brand} /> : <Text style={styles.emptyDesc}>{draft.isError ? draft.error?.message ?? "This strategy could not be read." : "No startable strategy loaded."}</Text>}</View>;
    }
    return (
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Start this strategy live</Text>
        <Text style={styles.note}>Prices, funds, margin and broker readiness are re-checked by the server when you start. Nothing is sent until the gates are open and you confirm.</Text>
        <View style={styles.gate}>
          <Ionicons name={gateOpen ? "shield-checkmark" : "alert-circle"} size={18} color={gateOpen ? colors.buy : colors.warn} />
          <Text style={styles.gateText}>{ready?.available && ready.provider ? `${ready.provider} · account ${ready.accountId}` : (ready?.reason ?? (ready ? "Broker ready." : "Checking broker readiness…"))}</Text>
        </View>
        <TouchableOpacity style={styles.buttonGhost} onPress={() => readiness.refetch()}><Text style={styles.buttonGhostText}>Refresh broker readiness</Text></TouchableOpacity>
        <TouchableOpacity style={styles.ackRow} onPress={() => setAck(value => !value)} accessibilityRole="checkbox" accessibilityState={{ checked: ack }}>
          <View style={styles.ackBox}>{ack ? <Ionicons name="checkmark" size={15} color="#ffffff" /> : null}</View>
          <Text style={styles.ackText}>I reviewed these saved rules and authorize real broker orders from this strategy.</Text>
        </TouchableOpacity>
        {startError ? <Text style={styles.error}>{startError}</Text> : null}
        <TouchableOpacity
          style={[styles.button, styles.buttonDanger, (!gateOpen || !ack || startLive.isPending) && styles.buttonOff]}
          disabled={!gateOpen || !ack || startLive.isPending}
          onPress={() => setConfirmStart(true)}
          accessibilityRole="button" accessibilityLabel="Start the live algo"
        >
          {startLive.isPending ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.buttonText}>Start Live Algo</Text>}
        </TouchableOpacity>
        {!gateOpen && <Text style={styles.meta}>Start is disabled until the broker gates are open.</Text>}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.back} onPress={goBack} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          <Text style={styles.subtitle}>{`${underlying || "—"}${source === "run" ? " · running" : " · saved strategy"}`}</Text>
        </View>
      </View>

      <View style={styles.tabs}>
        {tabs.map(tab => (
          <TouchableOpacity key={tab.id} style={[styles.tab, activeTab === tab.id && styles.tabOn]} onPress={() => setActiveTab(tab.id)} accessibilityRole="tab" accessibilityState={{ selected: activeTab === tab.id }}>
            <Text style={[styles.tabText, activeTab === tab.id && styles.tabTextOn]}>{tab.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={activeTab === "payoff" ? chain.isRefetching : activeTab === "settings" ? draft.isRefetching : activeTab === "actions" ? readiness.isRefetching : runs.isRefetching} onRefresh={() => { setNotice(null); void (activeTab === "payoff" ? chain.refetch() : activeTab === "settings" ? draft.refetch() : activeTab === "actions" && source === "draft" ? readiness.refetch() : runs.refetch()); }} tintColor={colors.brand} />}
      >
        {notice ? (
          <TouchableOpacity style={[styles.card, { borderColor: colors.brand }]} onPress={() => setNotice(null)}>
            <Text style={styles.note}>{notice}</Text>
            <Text style={styles.meta}>Tap to dismiss</Text>
          </TouchableOpacity>
        ) : null}
        {activeTab === "payoff" ? renderPayoff() : activeTab === "settings" ? renderSettings() : renderActions()}
      </ScrollView>

      <Modal visible={confirmStop} transparent animationType="fade" onRequestClose={() => setConfirmStop(false)}>
        <View style={styles.scrim}>
          <View style={[styles.card, { maxWidth: 380, width: "100%" }]}>
            <Text style={styles.title}>Stop and close?</Text>
            <Text style={styles.note}>This stops {title} and closes every remaining leg on fresh quotes. A pending adjustment is cancelled and its replacement is never ordered.</Text>
            <View style={{ flexDirection: "row", gap: 10, marginTop: 6 }}>
              <TouchableOpacity style={[styles.buttonGhost, { flex: 1 }]} onPress={() => setConfirmStop(false)}><Text style={styles.buttonGhostText}>Keep running</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.button, styles.buttonDanger, { flex: 1 }]} onPress={() => void confirmClose()}><Text style={styles.buttonText}>Confirm stop</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={confirmStart} transparent animationType="fade" onRequestClose={() => setConfirmStart(false)}>
        <View style={styles.scrim}>
          <View style={[styles.card, { maxWidth: 380, width: "100%" }]}>
            <Text style={styles.title}>Start live algorithm?</Text>
            <Text style={styles.note}>This deploys {title} with real broker orders. Ensure you have reviewed the strategy configuration and gates are open.</Text>
            <View style={{ flexDirection: "row", gap: 10, marginTop: 6 }}>
              <TouchableOpacity style={[styles.buttonGhost, { flex: 1 }]} onPress={() => setConfirmStart(false)}><Text style={styles.buttonGhostText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.button, styles.buttonDanger, { flex: 1 }]} onPress={() => { setConfirmStart(false); void startFromStrategy(); }}><Text style={styles.buttonText}>Start live</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
