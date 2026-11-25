/**
 * The prices this phone has seen, shared by every screen.
 *
 * One instrument id, one number, however it was found: the strip's tick, the broker's own row in the book, a
 * leg prod priced on the last ladder read. A watchlist page that arrives unpriced and a strike the exchange
 * has gone quiet on are both gaps in front of the trader, and the phone already holds the answer for one of
 * them most of the time.
 *
 * The store is module-level rather than per-screen state, because a price learned on Positions is the reason
 * a Watchlist row need not read as empty — and because the tick stream publishes dozens of times a minute.
 * Nothing here re-renders a screen when a price is learned: rows ask `seen()` while they render, so a row
 * that redraws for its own reason picks up the newest number, and a row that had no reason to stays put. The
 * one repaint this hook does fire is when the saved prices first arrive from disk, so a cold start that
 * reads a list before that promise settles still shows them.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useMemo, useReducer } from "react";
import {
  paintable,
  readQuoteMemory,
  rememberQuotes,
  writeQuoteMemory,
  type QuoteEntry,
  type QuoteMemory,
  type RememberedQuote,
} from "@nraialgo/shared/api";

let store: QuoteMemory = {};

/** The screens mounted right now, so the disk copy can ask them to paint again once it lands. */
const screens = new Set<() => void>();

let loading: Promise<void> | null = null;

function hydrate(): Promise<void> {
  return readQuoteMemory(AsyncStorage).then((saved) => {
    store = rememberQuotes(store, Object.entries(saved).map(([id, entry]) => ({
      id, price: entry.price, close: entry.close, at: entry.at,
    })));
    for (const repaint of screens) repaint();
  }).catch(() => {});
}

/** The longest a tick batch may sit unwritten. A price is worth keeping, and the stream is not worth a
 *  storage write per frame. */
const WRITE_THROTTLE_MS = 10_000;

let lastWrite = 0;
let queued: ReturnType<typeof setTimeout> | null = null;

function save(): void {
  lastWrite = Date.now();
  writeQuoteMemory(AsyncStorage, store).catch(() => {});
}

function scheduleWrite(): void {
  if (queued) return;
  const wait = WRITE_THROTTLE_MS - (Date.now() - lastWrite);
  if (wait <= 0) save();
  else queued = setTimeout(() => { queued = null; save(); }, wait);
}

export interface QuoteMemoryView {
  /** What this phone last saw for one canonical id, or null when it never priced it or the price is too old
   *  to paint — a contract's remembered premium only stands for the day it was printed. */
  seen(id: string | null | undefined): RememberedQuote | null;
  /** Offer the prices on screen to the memory. Newest wins, and a price already held costs nothing. */
  remember(entries: readonly QuoteEntry[]): void;
}

export function useQuoteMemory(): QuoteMemoryView {
  const [, repaint] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    screens.add(repaint);
    loading ??= hydrate();
    return () => { screens.delete(repaint); };
  }, [repaint]);

  const seen = useCallback((id: string | null | undefined): RememberedQuote | null => {
    if (!id) return null;
    const entry = store[id];
    return entry && paintable(id, entry) ? entry : null;
  }, []);

  const remember = useCallback((entries: readonly QuoteEntry[]) => {
    if (entries.length === 0) return;
    const next = rememberQuotes(store, entries);
    if (next === store) return;
    store = next;
    scheduleWrite();
  }, []);

  return useMemo(() => ({ seen, remember }), [seen, remember]);
}

/**
 * Forget the remembered prices, because the session that saw them has ended.
 *
 * A remembered quote belongs to one trader's instruments: left on the phone, the next sign-in would open onto
 * someone else's last prices on its first screen. The saved lists are dropped by `forgetLastKnown()` under the
 * same key prefix, and this clears the copy the screens read from until the app reloads.
 */
export function forgetQuoteMemory(): void {
  store = {};
  lastWrite = 0;
  loading = null;
  for (const repaint of screens) repaint();
}
