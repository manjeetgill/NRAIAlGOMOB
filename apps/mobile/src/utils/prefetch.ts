/**
 * Speculative prefetch utilities for mobile app
 *
 * Prefetches data on touch-down (pressIn) before the navigation route mounts,
 * giving sub-second, instant transition performance like leading broker apps.
 *
 * A prefetch fills the cache the screen reads, so it has to store exactly what that screen's hook
 * stores. Prod answers `/v1/broker-auth/icici/account` and `/v1/orders` with an envelope, and the hooks
 * unpickle it into rows; caching the envelope under the rows' key hands the screen an object where it
 * expects an array, and the table dies on the first `.filter`/`data` read instead of showing a slow book.
 */

import { queryClient } from "@/utils/queryClient";
import { getApiClient } from "@/utils/apiClient";
import { readChainSelection } from "@/utils/chainSelection";
import { useTradingStore } from "@nraialgo/shared/stores";
import {
  chainRequest,
  chainWarmTargets,
  iciciOpenPositions,
  queryKeys,
  type GttOrder,
  type IciciAccountPayload,
  type OptionChainData,
  type OrderIntent,
  type TechnicalEventsResponse,
  type UnderlyingList,
} from "@nraialgo/shared/api";

const client = getApiClient();

export function prefetchOptionChain() {
  // The desk opens on the contract it remembered, not on whichever index this file was written against.
  // Warming a date the screen will not read costs a full broker chain call that the mount then repeats,
  // so the tab press buys nothing and the lane that places orders gets busier. `chainRequest` builds the
  // key and the params, which is the same pair `useOptionChain` uses — parity by construction.
  const warm = readChainSelection()
    .then((saved) => saved ?? useTradingStore.getState().optionChain)
    // A device that cannot answer its own memory still gets the defaults the screen falls back to.
    .catch(() => useTradingStore.getState().optionChain);

  void warm.then(({ underlying, expiry }) => {
    const request = chainRequest(underlying, expiry);
    return queryClient.prefetchQuery({
      queryKey: request.queryKey,
      queryFn: () => client.get<OptionChainData>("/v1/option-chain", { params: request.params }),
      staleTime: 5000,
    });
  }).catch(() => {});

  queryClient.prefetchQuery({
    queryKey: queryKeys.optionChain.underlyings(),
    queryFn: () => client.get<UnderlyingList>("/v1/option-chain/underlyings"),
    staleTime: 60 * 60 * 1000,
  }).catch(() => {});
}

/**
 * How recent a warmed ladder has to be for the tap to be served from the cache instead of asking again.
 * The desk's own hook holds a chain read for a minute, so warming anything staler than that buys nothing.
 */
const CHAIN_WARM_FRESH_MS = 60 * 1000;

/** The newest warm-up the picker asked for. Every date after it belongs to a ladder the trader walked away from. */
let chainWarmRun = 0;

/**
 * Warm the dates behind the expiry picker, a few at a time, while the trader is still reading the list.
 *
 * A cold switch is the slowest thing this desk does: prod measures 4.4 s average and 7.3 s worst for one
 * ladder read, and the picker is the only way to reach a different date, so the tap that pays for it is the
 * one this can afford to start early. Three dates, one after the other, on the lane that also places orders —
 * so the run is superseded the moment the picker is opened for another contract, skips anything the desk can
 * already answer from, and stops at the first refusal rather than retrying a lane that is saying no.
 *
 * Each entry is written under the key `chainRequest` builds, which is the one `useOptionChain` reads, so the
 * tap is a cache hit rather than a second read for the same ladder.
 */
export function prefetchChainExpiries(underlying: string, expiries: readonly string[], onScreen: string) {
  const targets = chainWarmTargets(underlying, expiries, onScreen);
  if (!targets.length) return;
  const run = ++chainWarmRun;

  void (async () => {
    for (const request of targets) {
      if (run !== chainWarmRun) return;
      const state = queryClient.getQueryState(request.queryKey);
      if (state && Date.now() - state.dataUpdatedAt < CHAIN_WARM_FRESH_MS) continue;
      try {
        await queryClient.prefetchQuery({
          queryKey: request.queryKey,
          queryFn: () => client.get<OptionChainData>("/v1/option-chain", { params: request.params }),
          staleTime: CHAIN_WARM_FRESH_MS,
        });
      } catch {
        return;
      }
    }
  })();
}

export function prefetchPortfolio() {
  queryClient.prefetchQuery({
    queryKey: queryKeys.positions.open(),
    queryFn: async () =>
      iciciOpenPositions(await client.get<IciciAccountPayload>("/v1/broker-auth/icici/account")),
    staleTime: 10 * 1000,
  }).catch(() => {});
}

export function prefetchOrders() {
  queryClient.prefetchQuery({
    queryKey: queryKeys.brokerAccount.icici(),
    queryFn: async () => {
      const account = await client.get<IciciAccountPayload>("/v1/broker-auth/icici/account");
      queryClient.setQueryData(queryKeys.positions.open(), iciciOpenPositions(account));
      return account;
    },
    staleTime: 5 * 1000,
  }).catch(() => {});
  queryClient.prefetchQuery({
    queryKey: queryKeys.orders.intents(),
    queryFn: async () => (await client.get<{ intents: OrderIntent[] }>("/v1/orders")).intents,
    staleTime: 5 * 1000,
  }).catch(() => {});
  queryClient.prefetchQuery({
    queryKey: queryKeys.orders.gtt(),
    queryFn: async () => (await client.get<{ gtts: GttOrder[] }>("/v1/orders/gtt")).gtts,
    staleTime: 10 * 1000,
  }).catch(() => {});
}

export function prefetchAlgoLab() {
  queryClient.prefetchQuery({
    queryKey: queryKeys.algoLab.engine(),
    queryFn: () => client.get("/v1/algo-lab/engine"),
    staleTime: 10 * 1000,
  }).catch(() => {});
  queryClient.prefetchQuery({
    queryKey: queryKeys.algoLab.strategyDrafts(),
    queryFn: () => client.get("/v1/strategy-drafts"),
    staleTime: 20 * 1000,
  }).catch(() => {});
}

export function prefetchScanner() {
  queryClient.prefetchQuery({
    queryKey: queryKeys.scanner.technicalEvents(),
    queryFn: () => client.get<TechnicalEventsResponse>("/v1/technical-events"),
    staleTime: 10 * 1000,
  }).catch(() => {});
}

export function prefetchWatchlist(list = 1) {
  queryClient.prefetchQuery({
    queryKey: queryKeys.watchlist.list(list),
    queryFn: () => client.get("/v1/watchlist", { params: { list } }),
    staleTime: 2 * 1000,
  }).catch(() => {});
}

export function prefetchSpreadBuilder() {
  prefetchOptionChain();
  prefetchPortfolio();
}
