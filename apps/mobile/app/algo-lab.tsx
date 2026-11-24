/**
 * Algo Lab Screen - strategy conditions, backtest entry and live exposure.
 *
 * Every figure here comes from prod: the fleet is /v1/algo-lab/fleet, the exposure is the same account
 * read the Portfolio tab uses. What this app cannot do is said out loud rather than left as a button that
 * answers nothing: no route turns these conditions into a saved strategy, runs a backtest, or stores a
 * risk limit, so those actions are disabled with the reason instead of silently doing nothing.
 */

import React, { useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { FleetItem } from "@nraialgo/shared/api";
import { formatNumber } from "@nraialgo/shared/utils";
import { queryKeys } from "@nraialgo/shared/api";
import { useApi } from "@/hooks/useApi";
import { useTheme } from "@/components/ThemeProvider";

type TabId = "builder" | "backtest" | "risk" | "fleet";
type ConditionType = "Entry" | "Exit" | "Filter";

/** One locally staged rule. It is this screen's draft, not a strategy prod has accepted. */
interface Condition {
  key: number;
  type: ConditionType;
  text: string;
}

const CYCLE: Record<ConditionType, ConditionType> = { Entry: "Exit", Exit: "Filter", Filter: "Entry" };

/** What prod has no route for from this screen, so a press cannot promise an outcome it cannot deliver. */
const UNSAVED = "Saving needs the web desk: prod has no route that turns these conditions into a strategy.";
const NO_BACKTEST = "Backtests are not run from this app. The fields are kept so the desk can take them later.";
const NO_LIMITS = "Risk limits live in the owner console. This app reads exposure; it cannot set a limit.";

const rupee = (value: number | null): string =>
  value === null ? "not priced" : `${value < 0 ? "-" : ""}₹${formatNumber(Math.abs(value))}`;

export default function AlgoLabScreen() {
  const { useFleet, useOpenPositions } = useApi();
  const { resolvedTheme } = useTheme();
  const [activeTab, setActiveTab] = useState<TabId>("builder");

  const [name, setName] = useState("");
  const [underlying, setUnderlying] = useState("");
  const [conditions, setConditions] = useState<Condition[]>([]);

  const [strategy, setStrategy] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [capital, setCapital] = useState("");

  const [maxPosition, setMaxPosition] = useState("");
  const [dailyLoss, setDailyLoss] = useState("");
  const [maxDrawdown, setMaxDrawdown] = useState("");
  const [maxOpen, setMaxOpen] = useState("");

  const { data: fleet, isLoading: fleetLoading, isError: fleetFailed, error: fleetError, refetch: refetchFleet } = useFleet({
    queryKey: queryKeys.algoLab.fleet(),
    enabled: activeTab === "fleet",
  });
  const { data: positions, isLoading: positionsLoading } = useOpenPositions({
    queryKey: queryKeys.positions.open(),
    enabled: activeTab === "risk",
  });

  const colors = useMemo(() => resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#64748b", border: "#334155", accent: "#38bdf8", inputBg: "#0f172a", up: "#22c55e", down: "#ef4444" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", accent: "#0284c7", inputBg: "#ffffff", up: "#16a34a", down: "#dc2626" }, [resolvedTheme]);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
    title: { fontSize: 24, fontWeight: "700", color: colors.text },
    tabContainer: { flexDirection: "row", backgroundColor: colors.card, marginHorizontal: 16, marginTop: 12, borderRadius: 8, padding: 4, borderWidth: 1, borderColor: colors.border },
    tabButton: { flex: 1, paddingVertical: 10, alignItems: "center", borderRadius: 6 },
    tabButtonActive: { backgroundColor: colors.accent },
    tabLabel: { fontSize: 12, fontWeight: "600", color: colors.muted },
    tabLabelActive: { color: "#ffffff" },
    content: { flexGrow: 1, padding: 16, gap: 16 },
    sectionTitle: { fontSize: 16, fontWeight: "600", color: colors.text },
    card: { backgroundColor: colors.card, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: colors.border, gap: 8 },
    label: { fontSize: 12, fontWeight: "600", color: colors.muted },
    input: {
      height: 44, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.inputBg,
      paddingHorizontal: 12, fontSize: 16, color: colors.text,
    },
    button: { height: 44, borderRadius: 8, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
    buttonText: { fontSize: 16, fontWeight: "600", color: "#ffffff" },
    buttonSecondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
    buttonSecondaryText: { color: colors.text },
    buttonOff: { opacity: 0.45 },
    note: { fontSize: 12, color: colors.muted, lineHeight: 18 },
    emptyState: { alignItems: "center", padding: 24, gap: 6 },
    emptyTitle: { fontSize: 16, fontWeight: "600", color: colors.text },
    emptyDesc: { fontSize: 14, color: colors.muted, textAlign: "center", lineHeight: 20 },
    conditionRow: {
      flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, paddingHorizontal: 8,
      backgroundColor: colors.inputBg, borderRadius: 8, borderWidth: 1, borderColor: colors.border,
    },
    conditionType: { fontSize: 12, fontWeight: "700", color: colors.accent, minWidth: 52 },
    conditionInput: { flex: 1, fontSize: 15, color: colors.text, paddingVertical: 8 },
    metric: { flex: 1, minWidth: 130, gap: 2 },
    metricValue: { fontSize: 20, fontWeight: "700", color: colors.text },
    metricLabel: { fontSize: 11, color: colors.muted, textTransform: "uppercase" },
    metricRow: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
    fleetItem: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
    fleetInfo: { flex: 1 },
    fleetName: { fontSize: 15, fontWeight: "600", color: colors.text },
    fleetMeta: { fontSize: 12, color: colors.muted, marginTop: 2 },
    fleetPnL: { fontSize: 15, fontWeight: "600" },
    retry: { alignSelf: "flex-start", paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8, borderWidth: 1, borderColor: colors.accent },
    retryText: { fontSize: 13, fontWeight: "600", color: colors.accent },
  }), [colors]);

  const tabs: { id: TabId; label: string; icon: "construct-outline" | "analytics-outline" | "shield-outline" | "layers-outline" }[] = [
    { id: "builder", label: "Builder", icon: "construct-outline" },
    { id: "backtest", label: "Backtest", icon: "analytics-outline" },
    { id: "risk", label: "Risk", icon: "shield-outline" },
    { id: "fleet", label: "Fleet", icon: "layers-outline" },
  ];

  const addCondition = () =>
    setConditions(current => [...current, { key: Date.now(), type: "Entry", text: "" }]);

  const writeCondition = (key: number, patch: Partial<Condition>) =>
    setConditions(current => current.map(condition => (condition.key === key ? { ...condition, ...patch } : condition)));

  const dropCondition = (key: number) => setConditions(current => current.filter(c => c.key !== key));

  const exposure = useMemo(() => {
    const rows = positions ?? [];
    const priced = rows.filter(row => row.markPrice !== null);
    const withPnl = rows.filter(row => row.unrealizedPnl !== null);
    return {
      count: rows.length,
      // A position the broker never marked stays admitted as unpriced instead of counting as zero.
      notional: priced.reduce((total, row) => total + Math.abs(row.quantity) * (row.markPrice as number), 0),
      pricedCount: priced.length,
      unrealized: withPnl.length ? withPnl.reduce((total, row) => total + (row.unrealizedPnl as number), 0) : null,
      pnlCount: withPnl.length,
    };
  }, [positions]);

  const deployed = useMemo(() => (fleet ?? []).reduce((total, item) => total + item.deployed, 0), [fleet]);

  const renderBuilder = () => (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>Strategy Builder</Text>
      <View style={styles.card}>
        <Text style={styles.label}>Strategy name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="My Strategy"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
        />
        <Text style={styles.label}>Underlying</Text>
        <TextInput
          style={styles.input}
          value={underlying}
          onChangeText={setUnderlying}
          placeholder="NIFTY / BANKNIFTY"
          placeholderTextColor={colors.muted}
          autoCapitalize="characters"
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Conditions</Text>
        {conditions.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="add-circle-outline" size={44} color={colors.muted} />
            <Text style={styles.emptyTitle}>No conditions added</Text>
            <Text style={styles.emptyDesc}>Tap + to add an entry, exit, or filter condition</Text>
          </View>
        ) : (
          conditions.map(condition => (
            <View key={condition.key} style={styles.conditionRow}>
              {/* The chip is the rule's own type: press it to move to the next one. */}
              <TouchableOpacity onPress={() => writeCondition(condition.key, { type: CYCLE[condition.type] })} hitSlop={8}>
                <Text style={styles.conditionType}>{condition.type}</Text>
              </TouchableOpacity>
              <TextInput
                style={styles.conditionInput}
                value={condition.text}
                onChangeText={text => writeCondition(condition.key, { text })}
                placeholder="RSI(14) < 30 AND Close > EMA(20)"
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
              />
              <TouchableOpacity onPress={() => dropCondition(condition.key)} hitSlop={10} accessibilityLabel="Remove condition">
                <Ionicons name="trash-outline" size={20} color={colors.muted} />
              </TouchableOpacity>
            </View>
          ))
        )}
        <TouchableOpacity style={[styles.button, styles.buttonSecondary]} onPress={addCondition}>
          <Text style={[styles.buttonText, styles.buttonSecondaryText]}>+ Add Condition</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        <TouchableOpacity style={[styles.button, styles.buttonOff]} disabled>
          <Text style={styles.buttonText}>Save Strategy</Text>
        </TouchableOpacity>
        <Text style={styles.note}>{UNSAVED}</Text>
      </View>
    </ScrollView>
  );

  const renderBacktest = () => (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>Backtest Configuration</Text>
      <View style={styles.card}>
        <Text style={styles.label}>Strategy</Text>
        <TextInput
          style={styles.input}
          value={strategy}
          onChangeText={setStrategy}
          placeholder="Select Strategy"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
        />
        <Text style={styles.label}>From</Text>
        <TextInput
          style={styles.input}
          value={from}
          onChangeText={setFrom}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          keyboardType="numbers-and-punctuation"
        />
        <Text style={styles.label}>To</Text>
        <TextInput
          style={styles.input}
          value={to}
          onChangeText={setTo}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          keyboardType="numbers-and-punctuation"
        />
        <Text style={styles.label}>Initial capital (₹)</Text>
        <TextInput
          style={styles.input}
          value={capital}
          onChangeText={setCapital}
          placeholder="100000"
          placeholderTextColor={colors.muted}
          keyboardType="number-pad"
        />
        <TouchableOpacity style={[styles.button, styles.buttonOff]} disabled>
          <Text style={styles.buttonText}>Run Backtest</Text>
        </TouchableOpacity>
        <Text style={styles.note}>{NO_BACKTEST}</Text>
      </View>

      <Text style={styles.sectionTitle}>Results</Text>
      <View style={styles.card}>
        <View style={styles.emptyState}>
          <Ionicons name="analytics-outline" size={44} color={colors.muted} />
          <Text style={styles.emptyTitle}>No backtest run yet</Text>
          <Text style={styles.emptyDesc}>Configure and run a backtest to see results</Text>
        </View>
      </View>
    </ScrollView>
  );

  const renderRisk = () => (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>Risk Limits</Text>
      <View style={styles.card}>
        <Text style={styles.label}>Max position size (₹)</Text>
        <TextInput
          style={styles.input}
          value={maxPosition}
          onChangeText={setMaxPosition}
          placeholder="Not set by this app"
          placeholderTextColor={colors.muted}
          keyboardType="number-pad"
        />
        <Text style={styles.label}>Daily loss limit (₹)</Text>
        <TextInput
          style={styles.input}
          value={dailyLoss}
          onChangeText={setDailyLoss}
          placeholder="Not set by this app"
          placeholderTextColor={colors.muted}
          keyboardType="number-pad"
        />
        <Text style={styles.label}>Max drawdown (%)</Text>
        <TextInput
          style={styles.input}
          value={maxDrawdown}
          onChangeText={setMaxDrawdown}
          placeholder="Not set by this app"
          placeholderTextColor={colors.muted}
          keyboardType="decimal-pad"
        />
        <Text style={styles.label}>Max open positions</Text>
        <TextInput
          style={styles.input}
          value={maxOpen}
          onChangeText={setMaxOpen}
          placeholder="Not set by this app"
          placeholderTextColor={colors.muted}
          keyboardType="number-pad"
        />
        <TouchableOpacity style={[styles.button, styles.buttonOff]} disabled>
          <Text style={styles.buttonText}>Save Limits</Text>
        </TouchableOpacity>
        <Text style={styles.note}>{NO_LIMITS}</Text>
      </View>

      <Text style={styles.sectionTitle}>Current Exposure</Text>
      <View style={styles.card}>
        {positionsLoading && !positions ? (
          <View style={styles.emptyState}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.emptyDesc}>Reading the broker's position book</Text>
          </View>
        ) : exposure.count === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="shield-outline" size={44} color={colors.muted} />
            <Text style={styles.emptyTitle}>No open positions</Text>
            <Text style={styles.emptyDesc}>Risk figures appear once the broker's book holds something.</Text>
          </View>
        ) : (
          <View style={styles.metricRow}>
            <View style={styles.metric}>
              <Text style={styles.metricValue}>{exposure.count}</Text>
              <Text style={styles.metricLabel}>Open positions</Text>
            </View>
            <View style={styles.metric}>
              <Text style={styles.metricValue}>₹{formatNumber(exposure.notional)}</Text>
              <Text style={styles.metricLabel}>Marked exposure · {exposure.pricedCount} of {exposure.count} priced</Text>
            </View>
            <View style={styles.metric}>
              <Text style={[styles.metricValue, { color: (exposure.unrealized ?? 0) >= 0 ? colors.up : colors.down }]}>
                {rupee(exposure.unrealized)}
              </Text>
              <Text style={styles.metricLabel}>
                Unrealized · {exposure.pnlCount === 0 ? "no position marked yet" : `${exposure.pnlCount} of ${exposure.count} marked`}
              </Text>
            </View>
            <View style={styles.metric}>
              <Text style={styles.metricValue}>₹{formatNumber(deployed)}</Text>
              <Text style={styles.metricLabel}>Deployed by the fleet</Text>
            </View>
          </View>
        )}
      </View>
    </ScrollView>
  );

  const renderFleet = () => (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={styles.sectionTitle}>Strategy Fleet</Text>
        <TouchableOpacity style={[styles.button, { width: 150 }]} onPress={() => setActiveTab("builder")}>
          <Text style={styles.buttonText}>+ New Strategy</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.card}>
        {fleetLoading && !fleet ? (
          <View style={styles.emptyState}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.emptyDesc}>Reading the deployed strategies</Text>
          </View>
        ) : fleetFailed ? (
          <View style={styles.emptyState}>
            <Ionicons name="cloud-offline-outline" size={44} color={colors.muted} />
            <Text style={styles.emptyTitle}>The fleet could not be read</Text>
            <Text style={styles.emptyDesc}>{fleetError?.message ?? "The server did not answer."}</Text>
            <TouchableOpacity style={styles.retry} onPress={() => refetchFleet()}>
              <Text style={styles.retryText}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : !fleet?.length ? (
          <View style={styles.emptyState}>
            <Ionicons name="layers-outline" size={44} color={colors.muted} />
            <Text style={styles.emptyTitle}>No strategies deployed</Text>
            <Text style={styles.emptyDesc}>Prod's fleet list is empty for this account.</Text>
          </View>
        ) : (
          fleet.map((item: FleetItem) => (
            <View key={item.id} style={styles.fleetItem}>
              <View style={{ width: 44, height: 44, borderRadius: 8, backgroundColor: `${colors.accent}20`, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="construct-outline" size={20} color={colors.accent} />
              </View>
              <View style={styles.fleetInfo}>
                <Text style={styles.fleetName}>{item.name}</Text>
                <Text style={styles.fleetMeta}>{`${item.strategy} · ₹${formatNumber(item.capital)} capital · ₹${formatNumber(item.deployed)} deployed`}</Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={[styles.fleetPnL, { color: item.pnl >= 0 ? colors.up : colors.down }]}>
                  {`${item.pnl >= 0 ? "+" : "-"}₹${formatNumber(Math.abs(item.pnl))}`}
                </Text>
                <Text style={{ fontSize: 11, color: colors.muted }}>{item.status}</Text>
              </View>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Algo Lab</Text>
      </View>
      <View style={styles.tabContainer}>
        {tabs.map(tab => (
          <TouchableOpacity
            key={tab.id}
            style={[styles.tabButton, activeTab === tab.id && styles.tabButtonActive]}
            onPress={() => setActiveTab(tab.id)}
          >
            <Ionicons name={tab.icon} size={18} color={activeTab === tab.id ? "#ffffff" : colors.muted} style={{ marginBottom: 2 }} />
            <Text style={[styles.tabLabel, activeTab === tab.id && styles.tabLabelActive]}>{tab.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {activeTab === "builder" && renderBuilder()}
      {activeTab === "backtest" && renderBacktest()}
      {activeTab === "risk" && renderRisk()}
      {activeTab === "fleet" && renderFleet()}
    </View>
  );
}
