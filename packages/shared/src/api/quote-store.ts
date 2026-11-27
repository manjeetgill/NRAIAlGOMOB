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
  ticks: Record<string, QuoteTick>;
  applyBatch: (dirty: Map<string, QuoteTick>, connected: boolean, reason: FeedReason) => void;
  setConnection: (connected: boolean, reason: FeedReason) => void;
  clear: () => void;
}

export const useQuoteStore = create<QuoteStoreState>((set) => ({
  connected: false,
  reason: null,
  ticks: Object.create(null) as Record<string, QuoteTick>,

  applyBatch: (dirty, connected, reason) =>
    set((state) => {
      if (dirty.size === 0 && state.connected === connected && state.reason === reason) {
        return state;
      }
      const nextTicks = { ...state.ticks };
      for (const [id, tick] of dirty) {
        nextTicks[id] = tick;
      }
      return { ticks: nextTicks, connected, reason };
    }),

  setConnection: (connected, reason) =>
    set((state) =>
      state.connected === connected && state.reason === reason ? state : { connected, reason },
    ),

  clear: () => set({ ticks: Object.create(null) as Record<string, QuoteTick>, connected: false, reason: null }),
}));

/**
 * Subscribe to live ticks for a single canonical instrumentId.
 * Re-renders ONLY when this exact instrument receives a new tick or connection state changes.
 */
export function useInstrumentTick(instrumentId: string | null | undefined): QuoteTick | undefined {
  return useQuoteStore((state) => (instrumentId && state.connected ? state.ticks[instrumentId] : undefined));
}
