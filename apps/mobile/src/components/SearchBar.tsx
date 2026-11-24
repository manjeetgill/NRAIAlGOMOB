/**
 * The pill that opens the universal search, mounted once above the router so it is on every screen.
 *
 * It is a button and not an input because the typing belongs to its own screen: a field here would
 * compete with the search box the Watchlist already keeps for adding to the list it has open, and one
 * of the two would quietly stop working.
 */

import React, { useMemo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/components/ThemeProvider";

export default function SearchBar() {
  const router = useRouter();
  const pathname = usePathname();
  const { resolvedTheme } = useTheme();

  const colors = useMemo(() => resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#94a3b8", border: "#334155", brand: "#38bdf8" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", brand: "#0284c7" },
  [resolvedTheme]);

  const styles = useMemo(() => StyleSheet.create({
    row: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6, backgroundColor: colors.bg },
    pill: {
      flexDirection: "row", alignItems: "center", gap: 8, height: 36, paddingHorizontal: 10,
      borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card,
    },
    label: { flex: 1, fontSize: 13, color: colors.muted },
  }), [colors]);

  return (
    <View style={styles.row}>
      <TouchableOpacity
        style={styles.pill}
        activeOpacity={0.7}
        onPress={() => router.push(`/search?tab=${encodeURIComponent(pathname)}`)}
        accessibilityRole="button"
        accessibilityLabel="Search all listed stocks"
      >
        <Ionicons name="search" size={16} color={colors.muted} />
        <Text style={styles.label}>Search all listed stocks</Text>
        <Ionicons name="chevron-forward" size={15} color={colors.muted} />
      </TouchableOpacity>
    </View>
  );
}
