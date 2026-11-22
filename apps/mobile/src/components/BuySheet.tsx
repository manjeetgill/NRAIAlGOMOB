/**
 * Buy ticket sheet - the popup the watchlist opens on a symbol
 *
 * It holds only what the owner asked for: quantity, price, then the ask and the bid under them,
 * and the button that sends. Bid and ask come from prod's own single-symbol read, the same one
 * the web's stock dialog uses, so a figure here is never a guess or a stale chain row.
 */

import React, { useState } from "react";
import { Modal, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { useOrderTicket } from "@nraialgo/shared/hooks";
import { formatNumber, formatQuantity } from "@nraialgo/shared/utils";
import { useApi } from "@/hooks/useApi";
import { useTheme } from "./ThemeProvider";

interface BuySheetProps {
  ticket: ReturnType<typeof useOrderTicket>;
  /** Present only when the pressed row sits in one of the owner's lists, so the list can be edited
   *  from the same popup that trades it. */
  onRemove?: () => void;
  isRemoving?: boolean;
}

export function BuySheet({ ticket, onRemove, isRemoving = false }: BuySheetProps) {
  const { useEquityQuote } = useApi();
  const { resolvedTheme } = useTheme();
  const { localState, setLocalState, isSubmitting, validationError, config } = ticket;

  // An option's two-way price is the ladder's own, carried in on the press; the single-symbol read is
  // a shares endpoint and has nothing to say about an NFO contract - prod answers it with a refusal.
  const fromChain = !!config?.book;
  const { data: quote } = useEquityQuote(localState.exchange, localState.symbol, !fromChain);
  const ask = fromChain ? config?.book?.ask ?? null : quote?.ask ?? null;
  const bid = fromChain ? config?.book?.bid ?? null : quote?.bid ?? null;
  // The price the press arrived with, kept apart from the editable limit field so "last" never comes
  // to mean whatever the trader has typed into the ticket so far.
  const lastTouch = fromChain ? config?.price ?? null : quote?.ltp ?? null;

  // Seeded once at mount: the sheet only exists while a ticket is open, so a new press always
  // starts from the ticket's own values rather than from a previous symbol's half-typed text.
  const [quantity, setQuantity] = useState(String(localState.quantity || 1));
  const [price, setPrice] = useState(localState.price > 0 ? localState.price.toFixed(2) : "");

  const colors = resolvedTheme === "dark"
    ? { bg: "#0f172a", card: "#1e293b", text: "#f1f5f9", muted: "#94a3b8", border: "#334155", brand: "#38bdf8", danger: "#ef4444", buy: "#16a34a", sell: "#dc2626" }
    : { bg: "#f8fafc", card: "#ffffff", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", brand: "#0284c7", danger: "#ef4444", buy: "#16a34a", sell: "#dc2626" };

  const styles = StyleSheet.create({
    overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
    sheet: { backgroundColor: colors.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 24, maxHeight: "80%" },
    handle: { width: 40, height: 4, backgroundColor: colors.muted, borderRadius: 2, alignSelf: "center", marginTop: 12, marginBottom: 8 },
    header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
    symbol: { fontSize: 18, fontWeight: "700", color: colors.text },
    meta: { fontSize: 12, color: colors.muted, marginTop: 2 },
    fields: { flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingTop: 16 },
    field: { flex: 1 },
    label: { fontSize: 12, fontWeight: "600", color: colors.muted, marginBottom: 6 },
    input: {
      backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 8,
      paddingHorizontal: 12, paddingVertical: 10, color: colors.text, fontSize: 16,
    },
    book: { flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingTop: 16 },
    toggle: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingTop: 14 },
    togglePart: {
      flex: 1, paddingVertical: 11, borderRadius: 8, borderWidth: 1, borderColor: colors.border,
      alignItems: "center", backgroundColor: colors.card,
    },
    toggleBuy: { backgroundColor: colors.buy, borderColor: colors.buy },
    toggleSell: { backgroundColor: colors.sell, borderColor: colors.sell },
    toggleText: { fontSize: 14, fontWeight: "700", color: colors.muted },
    toggleTextOn: { color: "#ffffff" },
    side: { flex: 1, backgroundColor: colors.card, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12 },
    sideName: { fontSize: 12, fontWeight: "700", color: colors.muted, marginBottom: 4 },
    figure: { fontSize: 17, fontWeight: "700", color: colors.text },
    size: { fontSize: 12, color: colors.muted, marginTop: 2 },
    note: { fontSize: 12, color: colors.muted, paddingHorizontal: 16, paddingTop: 14, lineHeight: 18 },
    error: { fontSize: 13, color: colors.danger, paddingHorizontal: 16, paddingTop: 12 },
    submit: { marginHorizontal: 16, marginTop: 18, borderRadius: 10, paddingVertical: 15, alignItems: "center" },
    submitText: { fontSize: 16, fontWeight: "700", color: "#ffffff" },
    remove: { marginHorizontal: 16, marginTop: 10, paddingVertical: 10, alignItems: "center" },
    removeText: { fontSize: 13, fontWeight: "600", color: colors.danger },
  });

  const buying = localState.side === "BUY";
  const touch = (value: number | null | undefined) => (typeof value === "number" && value > 0 ? formatNumber(value) : "none");
  const size = (value: number | null | undefined) => (typeof value === "number" && value > 0 ? `${formatQuantity(value)} sh` : "no size");
  // Prod omits a side of the book it has no evidence for and names the reason, so a figure that is
  // not there is explained by the server's own words rather than left as a blank to interpret.
  const missing = !bid || !ask;
  const quiet = missing
    ? fromChain
      ? "The chain has no two-way price for this contract yet, so nothing is filled in for you."
      : quote?.depthMessage ?? "The broker has not sent this side of the book yet."
    : null;

  const write = (patch: Partial<typeof localState>) => setLocalState(previous => ({ ...previous, ...patch }));

  return (
    <Modal transparent animationType="slide" visible={ticket.visible} onRequestClose={ticket.close}>
      <TouchableOpacity style={styles.overlay} onPress={ticket.close} activeOpacity={1}>
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View>
              <Text style={styles.symbol}>{config?.label ?? localState.symbol}</Text>
              <Text style={styles.meta}>
                {`${localState.exchange}${quote?.name && quote.name !== localState.symbol ? ` · ${quote.name}` : ""}` +
                  (lastTouch ? ` · last ${formatNumber(lastTouch)}${!fromChain && quote?.at ? ` on ${quote.at.slice(0, 10)}` : ""}` : "")}
              </Text>
            </View>
            <TouchableOpacity
              onPress={ticket.close}
              hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Ionicons name="close-outline" size={24} color={colors.muted} />
            </TouchableOpacity>
          </View>

          {/* The side is chosen here, not on the row that was pressed, so one press can go either way. */}
          <View style={styles.toggle}>
            {(["BUY", "SELL"] as const).map(value => {
              const on = localState.side === value;
              return (
                <TouchableOpacity
                  key={value}
                  style={[styles.togglePart, on && (value === "BUY" ? styles.toggleBuy : styles.toggleSell)]}
                  onPress={() => write({ side: value })}
                >
                  <Text style={[styles.toggleText, on && styles.toggleTextOn]}>{value}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={styles.fields}>
            <View style={styles.field}>
              <Text style={styles.label}>Quantity</Text>
              <TextInput
                style={styles.input}
                value={quantity}
                onChangeText={value => {
                  setQuantity(value);
                  const parsed = Number(value);
                  write({ quantity: Number.isInteger(parsed) && parsed > 0 ? parsed : 0 });
                }}
                keyboardType="number-pad"
                placeholder="0"
                placeholderTextColor={colors.muted}
              />
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>Price</Text>
              <TextInput
                style={styles.input}
                value={price}
                onChangeText={value => {
                  setPrice(value);
                  const parsed = Number(value);
                  write({ price: Number.isFinite(parsed) && parsed > 0 ? parsed : 0, orderType: "LIMIT" });
                }}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor={colors.muted}
              />
            </View>
          </View>

          <View style={styles.book}>
            <View style={styles.side}>
              <Text style={styles.sideName}>Ask</Text>
              <Text style={styles.figure}>{touch(ask)}</Text>
              {fromChain ? null : <Text style={styles.size}>{size(quote?.askQuantity)}</Text>}
            </View>
            <View style={styles.side}>
              <Text style={styles.sideName}>Bid</Text>
              <Text style={styles.figure}>{touch(bid)}</Text>
              {fromChain ? null : <Text style={styles.size}>{size(quote?.bidQuantity)}</Text>}
            </View>
          </View>

          {quiet ? <Text style={styles.note}>{quiet}</Text> : null}
          {validationError ? <Text style={styles.error}>{validationError}</Text> : null}

          <TouchableOpacity
            style={[styles.submit, { backgroundColor: buying ? colors.buy : colors.sell }]}
            onPress={ticket.submit}
            disabled={isSubmitting}
          >
            <Text style={styles.submitText}>{isSubmitting ? "Sending..." : "Place order"}</Text>
          </TouchableOpacity>

          {onRemove ? (
            <TouchableOpacity style={styles.remove} onPress={onRemove} disabled={isRemoving}>
              <Text style={styles.removeText}>{isRemoving ? "Removing..." : "Remove from list"}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </TouchableOpacity>
    </Modal>
  );
}
