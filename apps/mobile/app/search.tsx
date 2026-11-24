/**
 * Universal search - every listed NSE/BSE stock, from one box on top of the app.
 *
 * The catalogue is prod's, not a copy kept on the device: `GET /v1/equities/search` answers from the
 * security list the server itself resolved, and it is asked without the index flag, so an index name
 * never lands in a list of tradable stocks. What comes back is what is drawn - a symbol the server did
 * not return cannot be tapped here, and an empty result says so instead of padding the screen.
 *
 * A hit opens the stock's Overview, which is where its price, book and the Buy/Sell ticket live. Adding
 * to a particular list stays on the Watchlist tab, whose own box targets the list it has open.
 */

import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useCanGoBack, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { chartFailureReason } from "@nraialgo/shared/api";
import { formatNumber } from "@nraialgo/shared/utils";
import { useTheme } from "@/components/ThemeProvider";
import { useApi } from "@/hooks/useApi";

/** Below two letters the server has nothing to narrow, so the box waits instead of firing a read. */
const MIN_QUERY = 2;

export default function SearchScreen() {
  const router = useRouter();
  const { useEquitySearch } = useApi();
  const { resolvedTheme } = useTheme();

  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text), 250);
    return () => clearTimeout(timer);
  }, [text]);

  const { data, isFetching, error } = useEquitySearch(debounced);
  const query = debounced.trim().toUpperCase();

  const colors = useMemo(() => resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#94a3b8", border: "#334155", brand: "#38bdf8" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", brand: "#0284c7" },
  [resolvedTheme]);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    head: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
    box: {
      flex: 1, flexDirection: "row", alignItems: "center", gap: 8, height: 40, paddingHorizontal: 10,
      borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card,
    },
    input: { flex: 1, fontSize: 14, color: colors.text, paddingVertical: 0 },
    note: { paddingHorizontal: 14, paddingTop: 6, fontSize: 12, color: colors.muted, lineHeight: 17 },
    row: {
      flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 11,
      borderBottomWidth: 1, borderBottomColor: colors.border,
    },
    main: { flex: 1 },
    symbol: { fontSize: 14, fontWeight: "700", color: colors.text },
    name: { fontSize: 11, color: colors.muted, marginTop: 2 },
    venue: {
      paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5, borderWidth: 1, borderColor: colors.border,
      fontSize: 10, fontWeight: "700", color: colors.muted,
    },
    loading: { paddingTop: 24, alignItems: "center" },
  }), [colors]);

  const openOverview = (hit: { exchange: string; symbol: string }) => {
    router.push(`/stock?exchange=${encodeURIComponent(hit.exchange)}&symbol=${encodeURIComponent(hit.symbol)}`);
  };

  /** A link can open this screen as the first route in the stack, where there is nothing to go back to;
   *  the arrow then returns to the Watchlist instead of throwing an unhandled GO_BACK. */
  const canGoBack = useCanGoBack();
  const goBack = () => (canGoBack ? router.back() : router.replace("/(tabs)/watchlist"));

  const message = () => {
    if (error) return chartFailureReason(error, "The listed-stock catalogue could not be searched. Retry shortly.");
    if (isFetching && query.length >= MIN_QUERY) return null;
    if (query.length < MIN_QUERY) return `Type at least ${MIN_QUERY} letters of a symbol or a company name.`;
    if (data && data.results.length === 0) return `No listed stock matches “${query}”.`;
    return null;
  };

  const status = message();

  return (
    <View style={styles.container}>
      <View style={styles.head}>
        <TouchableOpacity onPress={goBack} hitSlop={12} accessibilityLabel="Go back">
          <Ionicons name="arrow-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.box}>
          <Ionicons name="search" size={16} color={colors.muted} />
          <TextInput
            style={styles.input}
            placeholder="Symbol or company name"
            placeholderTextColor={colors.muted}
            value={text}
            onChangeText={setText}
            autoCapitalize="characters"
            autoCorrect={false}
            autoFocus
          />
          {text.length > 0 ? (
            <TouchableOpacity onPress={() => setText("")} hitSlop={12} accessibilityLabel="Clear search">
              <Ionicons name="close-circle" size={18} color={colors.muted} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {status ? <Text style={styles.note}>{status}</Text> : null}

      {isFetching && query.length >= MIN_QUERY && !data ? (
        <View style={styles.loading}>
          <ActivityIndicator size="small" color={colors.brand} />
        </View>
      ) : null}

      <FlatList
        data={data?.results ?? []}
        keyExtractor={(hit) => `${hit.exchange}:${hit.symbol}`}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} onPress={() => openOverview(item)}>
            <View style={styles.main}>
              <Text style={styles.symbol}>{item.symbol}</Text>
              {item.name ? <Text style={styles.name} numberOfLines={1}>{item.name}</Text> : null}
            </View>
            <Text style={styles.venue}>{item.exchange}</Text>
          </TouchableOpacity>
        )}
        ListFooterComponent={data?.results.length ? (
          <Text style={styles.note}>
            {`Listed stocks searched: ${formatNumber(data.catalogueTotal, 0)} · source ${data.source}`}
          </Text>
        ) : null}
      />
    </View>
  );
}
