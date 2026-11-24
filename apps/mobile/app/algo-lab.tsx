/**
 * Algo Lab — the owner's live algos on one screen: what is running now, and a gated press that starts a
 * saved strategy live.
 *
 * Live only. This screen has no paper path and cannot place anything the trader has not deliberately
 * acknowledged: a start needs the broker gates open (live-readiness), an explicit "I reviewed these rules
 * for real broker orders" checkbox, and one final press. Every number shown is prod's own — the runs are
 * the engine's ledger (/v1/algo-lab/engine), the strategies are /v1/strategy-drafts, the broker state is
 * the same readiness the web running-algos desk reads. Where prod refuses a live start it says why, in its
 * own words, rather than leaving a button that silently does nothing.
 */

import React, { useMemo, useState } from "react";
import { ActivityIndicator, Modal, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { newClientId } from "@nraialgo/shared/hooks";
import type { ManagedRun, StrategyDraftSummary } from "@nraialgo/shared/api";
import { useApi } from "@/hooks/useApi";
import { useTheme } from "@/components/ThemeProvider";

type TabId = "running" | "strategies";

/** A run the engine has not finished managing. Only these get a stop. */
const isOpen = (run: ManagedRun) => !["closed", "cancelled", "completed", "withdrawn"].includes(run.status);

/** Which colour a status is painted in, so an entry, an exit and a review-needed run never look alike. */
const statusTone = (run: ManagedRun): "live" | "pending" | "review" | "done" => {
  if (run.health?.state === "review" || run.status === "attention" || run.status === "unresolved") return "review";
  if (["entry-pending", "exit-pending"].includes(run.status) || run.status === "armed") return "pending";
  if (isOpen(run)) return "live";
  return "done";
};

const ruleTemplate = (draft: StrategyDraftSummary) => draft.strategySetup?.template ?? "saved strategy";

export default function AlgoLabScreen() {
  const { useManagedRuns, useStrategyDrafts, useLiveReadiness, useStartLiveCopy, useCloseRun } = useApi();
  const { resolvedTheme } = useTheme();
  const [activeTab, setActiveTab] = useState<TabId>("running");

  const [startFor, setStartFor] = useState<StrategyDraftSummary | null>(null);
  const [ack, setAck] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState<ManagedRun | null>(null);

  const runs = useManagedRuns({ enabled: activeTab === "running" });
  const drafts = useStrategyDrafts({ enabled: activeTab === "strategies" });
  const readiness = useLiveReadiness({ enabled: activeTab === "strategies" });
  const startLive = useStartLiveCopy();
  const closeRun = useCloseRun();

  const colors = useMemo(() => resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#64748b", border: "#334155", brand: "#38bdf8", buy: "#22c55e", sell: "#ef4444", warn: "#f59e0b" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", brand: "#0284c7", buy: "#16a34a", sell: "#dc2626", warn: "#b45309" }, [resolvedTheme]);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
    title: { fontSize: 24, fontWeight: "700", color: colors.text },
    subtitle: { fontSize: 12, color: colors.muted, marginTop: 2 },
    tabs: { flexDirection: "row", gap: 6, marginHorizontal: 16, marginTop: 12 },
    tab: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
    tabOn: { borderColor: colors.brand, backgroundColor: `${colors.brand}22` },
    tabText: { fontSize: 14, fontWeight: "700", color: colors.muted },
    tabTextOn: { color: colors.text },
    body: { padding: 16, gap: 12 },
    card: { backgroundColor: colors.card, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: colors.border, gap: 6 },
    rowHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
    name: { fontSize: 15, fontWeight: "700", color: colors.text, flexShrink: 1 },
    meta: { fontSize: 12, color: colors.muted },
    badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, overflow: "hidden" },
    badgeText: { fontSize: 11, fontWeight: "700" },
    detail: { fontSize: 12, color: colors.text, marginTop: 2 },
    error: { fontSize: 12, color: colors.sell, marginTop: 2 },
    metricRow: { flexDirection: "row", gap: 16, marginTop: 2 },
    metricValue: { fontSize: 15, fontWeight: "700", color: colors.text },
    metricLabel: { fontSize: 11, color: colors.muted, textTransform: "uppercase" },
    button: { height: 46, borderRadius: 10, backgroundColor: colors.sell, alignItems: "center", justifyContent: "center", marginTop: 4 },
    buttonGhost: { height: 38, borderRadius: 8, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
    buttonOff: { opacity: 0.4 },
    buttonText: { fontSize: 14, fontWeight: "700", color: "#ffffff" },
    buttonGhostText: { fontSize: 13, fontWeight: "600", color: colors.text },
    empty: { alignItems: "center", paddingVertical: 32, gap: 8 },
    emptyTitle: { fontSize: 16, fontWeight: "600", color: colors.text },
    emptyDesc: { fontSize: 13, color: colors.muted, textAlign: "center", lineHeight: 19, paddingHorizontal: 12 },
    retry: { alignSelf: "center", paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8, borderWidth: 1, borderColor: colors.brand, marginTop: 4 },
    retryText: { fontSize: 13, fontWeight: "600", color: colors.brand },
    scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
    sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 18, gap: 12, maxHeight: "88%" },
    sheetHead: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 10 },
    sheetTitle: { fontSize: 18, fontWeight: "700", color: colors.text, flexShrink: 1 },
    sheetNote: { fontSize: 13, color: colors.muted, lineHeight: 19 },
    field: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
    fieldLabel: { fontSize: 12, color: colors.muted },
    fieldText: { fontSize: 13, fontWeight: "600", color: colors.text, flexShrink: 1, textAlign: "right" },
    gate: { flexDirection: "row", alignItems: "center", gap: 8, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
    gateText: { fontSize: 12.5, color: colors.text, flex: 1 },
    ackRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
    ackBox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: ack ? colors.sell : colors.border, backgroundColor: ack ? colors.sell : "transparent", alignItems: "center", justifyContent: "center", marginTop: 1 },
    ackText: { fontSize: 13, color: colors.text, flex: 1, lineHeight: 19 },
    startBtn: { backgroundColor: colors.sell },
  }), [colors, ack]);

  const badgeColor = (tone: "live" | "pending" | "review" | "done") =>
    tone === "live" ? colors.buy : tone === "pending" ? colors.warn : tone === "review" ? colors.sell : colors.muted;

  const toneLabel: Record<string, string> = {
    live: "running", pending: "pending", review: "needs review", done: "closed",
  };

  const tabs: { id: TabId; label: string; icon: "radio-button-on-outline" | "list-outline" }[] = [
    { id: "running", label: "Running", icon: "radio-button-on-outline" },
    { id: "strategies", label: "My strategies", icon: "list-outline" },
  ];

  const openStart = (draft: StrategyDraftSummary) => {
    setStartFor(draft);
    setAck(false);
    setStartError(null);
    setNotice(null);
    if (!readiness.data) void readiness.refetch();
  };

  const submitStart = async () => {
    const draft = startFor;
    const ready = readiness.data;
    if (!draft || !ack || !ready?.available || ready.executionReady === false || !ready.provider || !ready.accountId) return;
    setStartError(null);
    try {
      const result = await startLive.mutateAsync({
        copyId: draft.id,
        body: {
          requestId: newClientId(),
          draftVersion: draft.updatedAt,
          mode: "live",
          provider: ready.provider,
          accountId: ready.accountId,
          acknowledge: true,
        },
      });
      setNotice(result.queued
        ? `Armed for the next market open. ${draft.name} picks its strikes from these saved rules when the market opens and sends the entry to ${ready.provider}.`
        : result.status === "open"
          ? `Live run opened with its saved rules. Track it under Running.`
          : `Live start accepted · ${result.status}. Acceptance is not a confirmed fill.`);
      setStartFor(null);
      void runs.refetch();
    } catch (cause) {
      setStartError(cause instanceof Error ? cause.message : "The live start could not be confirmed.");
    }
  };

  const confirmClose = async () => {
    const run = confirmStop;
    if (!run) return;
    setConfirmStop(null);
    setNotice(null);
    try {
      await closeRun.mutateAsync(run.id);
      setNotice(`Stop requested for ${run.name}. A pending adjustment is cancelled and every remaining leg closes on fresh quotes.`);
      void runs.refetch();
    } catch (cause) {
      setNotice(cause instanceof Error ? `Stop failed: ${cause.message}` : "The stop could not be confirmed.");
    }
  };

  const renderRun = (run: ManagedRun) => {
    const tone = statusTone(run);
    const pnl = run.pnl === null || run.pnl === undefined ? null : Number(run.pnl);
    return (
      <View key={run.id} style={styles.card}>
        <View style={styles.rowHead}>
          <Text style={styles.name} numberOfLines={1}>{run.name}</Text>
          <View style={[styles.badge, { backgroundColor: `${badgeColor(tone)}22` }]}>
            <Text style={[styles.badgeText, { color: badgeColor(tone) }]}>{toneLabel[tone]}</Text>
          </View>
        </View>
        <Text style={styles.meta}>{`${run.status}${run.provider ? ` · ${run.provider}` : ""}${run.management_mode ? ` · ${run.management_mode}` : ""}`}</Text>
        {run.health?.detail ? <Text style={styles.detail}>{run.health.label ? `${run.health.label}: ${run.health.detail}` : run.health.detail}</Text> : null}
        {run.last_error ? <Text style={styles.error}>{run.last_error}</Text> : null}
        <View style={styles.metricRow}>
          <View>
            <Text style={[styles.metricValue, { color: pnl === null ? colors.muted : pnl >= 0 ? colors.buy : colors.sell }]}>
              {pnl === null ? "—" : `${pnl >= 0 ? "+" : "-"}₹${Math.abs(pnl).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`}
            </Text>
            <Text style={styles.metricLabel}>P&L{run.mark_quality === "stale" ? " · stale mark" : ""}</Text>
          </View>
          <View>
            <Text style={styles.metricValue}>{run.positions?.length ?? 0}</Text>
            <Text style={styles.metricLabel}>Legs</Text>
          </View>
          {run.expires_at ? (
            <View>
              <Text style={styles.metricValue}>{run.expires_at.slice(0, 10)}</Text>
              <Text style={styles.metricLabel}>Authority expires</Text>
            </View>
          ) : null}
        </View>
        {isOpen(run) ? (
          <TouchableOpacity style={[styles.buttonGhost, { borderColor: colors.sell }]} onPress={() => setConfirmStop(run)} accessibilityRole="button" accessibilityLabel={`Stop and close ${run.name}`}>
            <Text style={[styles.buttonGhostText, { color: colors.sell }]}>Stop and close</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  };

  const renderRunning = () => {
    if (runs.isLoading && !runs.data) {
      return <View style={styles.empty}><ActivityIndicator color={colors.brand} /><Text style={styles.emptyDesc}>Reading the engine's live runs</Text></View>;
    }
    if (runs.isError) {
      return (
        <View style={styles.empty}>
          <Ionicons name="cloud-offline-outline" size={40} color={colors.muted} />
          <Text style={styles.emptyTitle}>Running algos could not be read</Text>
          <Text style={styles.emptyDesc}>{runs.error?.message ?? "The server did not answer."}</Text>
          <TouchableOpacity style={styles.retry} onPress={() => runs.refetch()}><Text style={styles.retryText}>Try again</Text></TouchableOpacity>
        </View>
      );
    }
    const live = (runs.data?.runs ?? []).filter(run => run.mode === "live");
    if (!live.length) {
      return (
        <View style={styles.empty}>
          <Ionicons name="radio-button-off-outline" size={40} color={colors.muted} />
          <Text style={styles.emptyTitle}>No live algos running</Text>
          <Text style={styles.emptyDesc}>Nothing is live right now. Start a saved strategy from "My strategies".</Text>
        </View>
      );
    }
    return (
      <>
        {live.map(renderRun)}
      </>
    );
  };

  const renderStrategies = () => {
    if (drafts.isLoading && !drafts.data) {
      return <View style={styles.empty}><ActivityIndicator color={colors.brand} /><Text style={styles.emptyDesc}>Reading your saved strategies</Text></View>;
    }
    if (drafts.isError) {
      return (
        <View style={styles.empty}>
          <Ionicons name="cloud-offline-outline" size={40} color={colors.muted} />
          <Text style={styles.emptyTitle}>Strategies could not be read</Text>
          <Text style={styles.emptyDesc}>{drafts.error?.message ?? "The server did not answer."}</Text>
          <TouchableOpacity style={styles.retry} onPress={() => drafts.refetch()}><Text style={styles.retryText}>Try again</Text></TouchableOpacity>
        </View>
      );
    }
    const copies = (drafts.data?.drafts ?? []).filter(draft => !!draft.strategySetup);
    if (!copies.length) {
      return (
        <View style={styles.empty}>
          <Ionicons name="albums-outline" size={40} color={colors.muted} />
          <Text style={styles.emptyTitle}>No saved strategies to start</Text>
          <Text style={styles.emptyDesc}>Save a strategy copy on the web desk first; this screen starts saved copies live, it does not build new rules.</Text>
        </View>
      );
    }
    return (
      <>
        {copies.map(draft => (
          <View key={draft.id} style={styles.card}>
            <View style={styles.rowHead}>
              <Text style={styles.name} numberOfLines={1}>{draft.name}</Text>
              <Text style={styles.meta}>{draft.underlying}</Text>
            </View>
            <Text style={styles.meta}>{`${ruleTemplate(draft)} · ${draft.legCount} legs · saved ${draft.updatedAt.slice(0, 10)}`}</Text>
            <TouchableOpacity style={styles.button} onPress={() => openStart(draft)} accessibilityRole="button" accessibilityLabel={`Start ${draft.name} live`}>
              <Text style={styles.buttonText}>Start live</Text>
            </TouchableOpacity>
          </View>
        ))}
      </>
    );
  };

  const startSheet = startFor ? (() => {
    const ready = readiness.data;
    const gateOpen = !!ready?.available && ready?.executionReady !== false && !!ready?.provider && !!ready?.accountId;
    const reason = ready?.reason ?? (ready ? "Broker ready." : "Checking broker readiness…");
    return (
      <Modal visible animationType="slide" onRequestClose={() => setStartFor(null)}>
        <View style={styles.scrim}>
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>Start live</Text>
              <TouchableOpacity onPress={() => setStartFor(null)} hitSlop={10} accessibilityLabel="Cancel the live start">
                <Ionicons name="close" size={24} color={colors.muted} />
              </TouchableOpacity>
            </View>

            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Strategy</Text>
              <Text style={styles.fieldText}>{startFor.name}</Text>
            </View>
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Underlying · template</Text>
              <Text style={styles.fieldText}>{`${startFor.underlying} · ${ruleTemplate(startFor)}`}</Text>
            </View>
            <Text style={styles.sheetNote}>
              Live picks its strikes from these saved rules at the moment it starts, on the strategy's saved expiry. Current prices, funds, margin and broker readiness are re-checked by the server when you start.
            </Text>

            <View style={styles.gate}>
              <Ionicons name={gateOpen ? "shield-checkmark" : "alert-circle"} size={18} color={gateOpen ? colors.buy : colors.warn} />
              <Text style={styles.gateText}>{ready?.available && ready.provider ? `${ready.provider} · account ${ready.accountId}` : reason}</Text>
            </View>
            <TouchableOpacity style={styles.retry} onPress={() => readiness.refetch()}><Text style={styles.retryText}>Refresh broker readiness</Text></TouchableOpacity>

            <TouchableOpacity style={styles.ackRow} onPress={() => setAck(value => !value)} accessibilityRole="checkbox" accessibilityState={{ checked: ack }}>
              <View style={styles.ackBox}>{ack ? <Ionicons name="checkmark" size={15} color="#ffffff" /> : null}</View>
              <Text style={styles.ackText}>I reviewed these saved rules and authorize real broker orders from this strategy.</Text>
            </TouchableOpacity>

            {startError ? <Text style={styles.error}>{startError}</Text> : null}

            <TouchableOpacity
              style={[styles.button, styles.startBtn, (!gateOpen || !ack || startLive.isPending) && styles.buttonOff]}
              disabled={!gateOpen || !ack || startLive.isPending}
              onPress={() => void submitStart()}
              accessibilityRole="button"
              accessibilityLabel="Start the live algo"
            >
              {startLive.isPending ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.buttonText}>Start Live Algo</Text>}
            </TouchableOpacity>
            {!gateOpen && <Text style={styles.sheetNote}>Start is disabled until the broker gates are open.</Text>}
          </View>
        </View>
      </Modal>
    );
  })() : null;

  const stopSheet = confirmStop ? (
    <Modal visible animationType="fade" transparent onRequestClose={() => setConfirmStop(null)}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <View style={[styles.card, { width: "100%", maxWidth: 380 }]}>
          <Text style={styles.sheetTitle}>Stop and close?</Text>
          <Text style={styles.sheetNote}>
            This stops {confirmStop.name} and closes every remaining leg on fresh quotes. A pending adjustment is cancelled and its replacement is never ordered.
          </Text>
          <View style={{ flexDirection: "row", gap: 10, marginTop: 6 }}>
            <TouchableOpacity style={[styles.buttonGhost, { flex: 1 }]} onPress={() => setConfirmStop(null)}>
              <Text style={styles.buttonGhostText}>Keep running</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.button, { flex: 1, marginTop: 0 }]} onPress={() => void confirmClose()}>
              <Text style={styles.buttonText}>Confirm stop</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  ) : null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Algo Lab</Text>
          <Text style={styles.subtitle}>Live algos and one-press live starts</Text>
        </View>
      </View>

      <View style={styles.tabs}>
        {tabs.map(tab => (
          <TouchableOpacity
            key={tab.id}
            style={[styles.tab, activeTab === tab.id && styles.tabOn]}
            onPress={() => setActiveTab(tab.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === tab.id }}
          >
            <Ionicons name={tab.icon} size={16} color={activeTab === tab.id ? colors.text : colors.muted} />
            <Text style={[styles.tabText, activeTab === tab.id && styles.tabTextOn]}>{tab.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={activeTab === "running" ? runs.isRefetching : drafts.isRefetching} onRefresh={() => void (activeTab === "running" ? runs.refetch() : drafts.refetch())} tintColor={colors.brand} />}
      >
        {notice ? (
          <TouchableOpacity style={[styles.card, { borderColor: colors.brand }]} onPress={() => setNotice(null)}>
            <Text style={styles.detail}>{notice}</Text>
            <Text style={styles.meta}>Tap to dismiss</Text>
          </TouchableOpacity>
        ) : null}
        {activeTab === "running" ? renderRunning() : renderStrategies()}
      </ScrollView>

      {startSheet}
      {stopSheet}
    </View>
  );
}
