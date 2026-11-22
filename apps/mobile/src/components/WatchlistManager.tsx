/**
 * Watchlist Manager - select, rename and create the user's own lists
 *
 * Prod has no route that deletes a list, so this sheet does not offer one; an empty list is
 * removed by taking the symbols out of it.
 */

import React, { useState } from "react";
import { Alert, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { WatchlistInfo } from "@nraialgo/shared/api";
import { useTheme } from "./ThemeProvider";
import { useApi } from "@/hooks/useApi";

interface WatchlistManagerProps {
  visible: boolean;
  onClose: () => void;
  lists: WatchlistInfo[];
  maxLists: number;
  activeList: number;
  onSelect: (number: number) => void;
  onCreate: () => void;
}

export function WatchlistManager({ visible, onClose, lists, maxLists, activeList, onSelect, onCreate }: WatchlistManagerProps) {
  const { useRenameWatchlist } = useApi();
  const { resolvedTheme } = useTheme();
  const rename = useRenameWatchlist();
  const [editing, setEditing] = useState<number | null>(null);
  const [name, setName] = useState("");

  const colors = resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#94a3b8", border: "#334155", brand: "#38bdf8", danger: "#ef4444" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", brand: "#0284c7", danger: "#ef4444" };

  const styles = StyleSheet.create({
    overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
    sheet: { backgroundColor: colors.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 24, maxHeight: "80%" },
    handle: { width: 40, height: 4, backgroundColor: colors.muted, borderRadius: 2, alignSelf: "center", marginTop: 12, marginBottom: 8 },
    header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
    title: { fontSize: 18, fontWeight: "700", color: colors.text },
    row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
    rowActive: { backgroundColor: "rgba(56,189,248,0.08)" },
    name: { fontSize: 15, fontWeight: "500", color: colors.text },
    count: { fontSize: 12, color: colors.muted, marginTop: 2 },
    badge: { backgroundColor: colors.brand, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, marginLeft: 8 },
    badgeText: { fontSize: 10, fontWeight: "700", color: "#ffffff" },
    input: {
      flex: 1, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.brand, borderRadius: 8,
      paddingHorizontal: 12, paddingVertical: 9, color: colors.text, fontSize: 15, marginRight: 8,
    },
    small: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 8 },
    smallText: { fontSize: 13, fontWeight: "700", color: "#ffffff" },
    ghost: { backgroundColor: colors.border },
    ghostText: { color: colors.text },
    content: { paddingHorizontal: 16 },
    note: { fontSize: 12, color: colors.muted, paddingTop: 12, lineHeight: 18 },
    error: { fontSize: 13, color: colors.danger, paddingTop: 10 },
  });

  const save = (number: number) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (trimmed.length > 40) {
      Alert.alert("Name too long", "Use 40 characters or fewer.");
      return;
    }
    rename.mutate(
      { list: number, name: trimmed },
      { onSuccess: () => setEditing(null), onError: error => Alert.alert("Not renamed", error.message) },
    );
  };

  if (!visible) return null;

  return (
    <Modal transparent animationType="slide" visible={visible} onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} onPress={onClose} activeOpacity={1}>
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.title}>{`Your watchlists (${lists.length} of ${maxLists})`}</Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close-outline" size={24} color={colors.muted} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.content}>
            {lists.map(info => {
              const editingThis = editing === info.number;
              return (
                <View key={info.number} style={[styles.row, info.number === activeList && styles.rowActive]}>
                  {editingThis ? (
                    <>
                      <TextInput
                        style={styles.input}
                        value={name}
                        onChangeText={setName}
                        autoFocus
                        maxLength={40}
                        autoCapitalize="words"
                        onSubmitEditing={() => save(info.number)}
                      />
                      <TouchableOpacity style={[styles.small, { backgroundColor: colors.brand }]} onPress={() => save(info.number)}>
                        <Text style={styles.smallText}>Save</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[styles.small, styles.ghost]} onPress={() => setEditing(null)}>
                        <Text style={[styles.smallText, styles.ghostText]}>Cancel</Text>
                      </TouchableOpacity>
                    </>
                  ) : (
                    <>
                      <TouchableOpacity style={{ flex: 1 }} onPress={() => onSelect(info.number)}>
                        <Text style={[styles.name, info.number === activeList && { color: colors.brand }]}>
                          {info.name || `Watchlist ${info.number}`}
                        </Text>
                        <Text style={styles.count}>{`${info.count} symbol${info.count === 1 ? "" : "s"}`}</Text>
                      </TouchableOpacity>
                      {info.number === activeList ? (
                        <View style={styles.badge}><Text style={styles.badgeText}>OPEN</Text></View>
                      ) : null}
                      <TouchableOpacity style={{ padding: 8 }} onPress={() => { setEditing(info.number); setName(info.name || `Watchlist ${info.number}`); }}>
                        <Ionicons name="create-outline" size={20} color={colors.brand} />
                      </TouchableOpacity>
                    </>
                  )}
                </View>
              );
            })}

            {rename.isPending || lists.length >= maxLists ? null : (
              <TouchableOpacity style={[styles.small, { backgroundColor: colors.brand, alignSelf: "flex-start", marginTop: 16 }]} onPress={onCreate}>
                <Text style={styles.smallText}>Add a watchlist</Text>
              </TouchableOpacity>
            )}

            <Text style={styles.note}>
              Renaming and adding are saved on myalgodesk.in, so the web app shows the same lists.
              A list cannot be deleted from the server, so to empty one, remove its symbols.
            </Text>
          </ScrollView>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}
