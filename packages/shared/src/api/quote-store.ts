/**
 * Granular Zustand tick store fed by the WebSocket conflation buffer.
 *
 * Each instrument's QuoteTick is stored by canonical instrumentId so individual
 * table cells, depth rows, and charts can subscribe to a single instrumentId
 * without triggering parent or sibling re-renders.
 */

import { create } from "zustand";
import type { FeedReason, QuoteTick } from "./websocket";

interface QuoteStoreState {
  connected: boolean;
  reason: FeedReason;
  states: Record<string, string>;
  ticks: Record<string, QuoteTick>;
  applyBatch: (
    dirty: Map<string, QuoteTick>,
    removed: Set<string>,
    isSnapshot: boolean,
    connected: boolean,
    reason: FeedReason,
    states?: Record<string, string>,
  ) => void;
  setConnection: (connected: boolean, reason: FeedReason, states?: Record<string, string>) => void;
  clear: () => void;
}

export const useQuoteStore = create<QuoteStoreState>((set) => ({
  connected: false,
  reason: null,
  states: {},
  ticks: Object.create(null) as Record<string, QuoteTick>,

  applyBatch: (dirty, removed, isSnapshot, connected, reason, states) =>
    set((state) => {
      if (
        !isSnapshot &&
        dirty.size === 0 &&
        removed.size === 0 &&
        state.connected === connected &&
        state.reason === reason &&
        (states === undefined || state.states === states)
      ) {
        return state;
      }
      const nextTicks = isSnapshot
        ? (Object.create(null) as Record<string, QuoteTick>)
        : { ...state.ticks };
      if (!isSnapshot) {
        for (const id of removed) {
          delete nextTicks[id];
        }
      }
      for (const [id, tick] of dirty) {
        nextTicks[id] = tick;
      }
      return {
        ticks: nextTicks,
        connected,
        reason,
        states: states ?? state.states,
      };
    }),

  setConnection: (connected, reason, states) =>
    set((state) =>
      state.connected === connected &&
      state.reason === reason &&
      (states === undefined || state.states === states)
        ? state
        : { connected, reason, states: states ?? state.states },
    ),

  clear: () =>
    set({
      ticks: Object.create(null) as Record<string, QuoteTick>,
      states: {},
      connected: false,
      reason: null,
    }),
}));

/**
 * Subscribe to live ticks for a single canonical instrumentId.
 * Re-renders ONLY when this exact instrument receives a new tick or connection state changes.
 */
export function useInstrumentTick(instrumentId: string | null | undefined): QuoteTick | undefined {
  return useQuoteStore((state) => (instrumentId && state.connected ? state.ticks[instrumentId] : undefined));
}
