/**
 * Real-time Quotes Hook - Mobile
 *
 * Keeps the open-position rows moving with prod's tick stream. The stream speaks canonical instrument ids, so
 * this maps the screen's symbols out and each tick back, and only a price the server published as fresh with
 * an exchange timestamp can mark a position.
 */

import { useCallback, useMemo, useRef } from "react";
import { queryClient } from "../utils/queryClient";
import {
  streamId,
  symbolFromStreamId,
  tickBarInput,
  useQuotesStream,
  type QuoteTick,
} from "@nraialgo/shared/api";
import { useAuthStore } from "@nraialgo/shared/stores";

export function useRealtimeQuotes(symbols: string[], enabled = true) {
  const { accessToken, isAuthenticated, user } = useAuthStore();
  const authenticated = isAuthenticated || !!user || !!accessToken;
  const lastQuotesRef = useRef<Map<string, QuoteTick>>(new Map());

  // Only NSE cash symbols and NSE indices are published tick by tick, so the rest never reach the socket.
  const instruments = useMemo(
    () => [...new Set(symbols.map(streamId).filter((id): id is string => !!id))],
    [symbols.join(",")],
  );

  const updateCache = useCallback((tick: QuoteTick) => {
    const symbol = symbolFromStreamId(tick.id);
    // instrument:v1:<EXCHANGE>:<SEGMENT>:<SYMBOL> — the stream only publishes NSE today, but the row has
    // to agree rather than be assumed to: the same code trades on BSE, and an NSE price painted on a BSE
    // position is a wrong number, not a fresher one.
    const exchange = tick.id.split(":")[2];
    const price = tickBarInput(tick)?.price;
    if (price === undefined) return;
    if (symbol) lastQuotesRef.current.set(symbol, tick);
    lastQuotesRef.current.set(tick.id, tick);
    if (tick.subscriptionId) lastQuotesRef.current.set(tick.subscriptionId, tick);

    // Update positions cache if symbol is in open positions. The query stores itself under the
    // broker-scoped key, so patching the bare ["positions","open"] never reached a rendered row.
    queryClient.setQueryData(["positions", "open", "all"], (old: any[]) => {
      if (!old) return old;
      return old.map((p) => {
        const symbolMatch = (symbol && p.symbol === symbol && (!exchange || p.exchange === exchange))
          || (p.symbol && tick.id.includes(`:${encodeURIComponent(p.symbol)}:`))
          || (tick.subscriptionId && p.symbol && tick.subscriptionId.includes(`|${p.symbol}|`));
        if (!symbolMatch) return p;
        return {
          ...p,
          markPrice: price,
          // Without a broker cost there is no basis to mark against, so the P&L stays unreported.
          unrealizedPnl: typeof p.entryPrice === "number"
            ? (price - p.entryPrice) * p.quantity * (p.side === "BUY" ? 1 : -1)
            : p.unrealizedPnl,
        };
      });
    });
  }, []);

  const handleError = useCallback((error: Error) => {
    console.warn("Live price stream:", error.message);
  }, []);

  const stream = useQuotesStream({
    symbols: instruments,
    enabled: enabled && authenticated,
    onMessage: updateCache,
    onError: handleError,
  });

  return {
    ...stream,
    latestQuotes: lastQuotesRef.current,
  };
}

// Hook for subscribing to quotes from multiple sources
export function useCombinedQuotes(
  watchlistSymbols: string[],
  positionSymbols: string[],
  optionChainSymbols: string[],
  enabled = true
) {
  const allSymbols = [...new Set([...watchlistSymbols, ...positionSymbols, ...optionChainSymbols])];
  return useRealtimeQuotes(allSymbols, enabled);
}
