/**
 * Speculative prefetch utilities for mobile app
 *
 * Prefetches data on touch-down (pressIn) before the navigation route mounts,
 * giving sub-second, instant transition performance like leading broker apps.
 */

import { queryClient } from "@/utils/queryClient";
import { getApiClient } from "@/utils/apiClient";
import { queryKeys, type OptionChainData, type UnderlyingList } from "@nraialgo/shared/api";

const client = getApiClient();

export function prefetchOptionChain(underlying = "NIFTY") {
  queryClient.prefetchQuery({
    queryKey: queryKeys.optionChain.chain(underlying, "", 30),
    queryFn: () => client.get<OptionChainData>("/v1/option-chain", { params: { underlying, window: 30 } }),
    staleTime: 5000,
  }).catch(() => {});
  
  queryClient.prefetchQuery({
    queryKey: queryKeys.optionChain.underlyings(),
    queryFn: () => client.get<UnderlyingList>("/v1/option-chain/underlyings"),
    staleTime: 60 * 60 * 1000,
  }).catch(() => {});
}

export function prefetchPortfolio() {
  queryClient.prefetchQuery({
    queryKey: queryKeys.positions.open(),
    queryFn: () => client.get("/v1/broker-auth/icici/account"),
    staleTime: 10 * 1000,
  }).catch(() => {});
}

export function prefetchOrders() {
  queryClient.prefetchQuery({
    queryKey: queryKeys.orders.intents(),
    queryFn: () => client.get("/v1/orders"),
    staleTime: 5 * 1000,
  }).catch(() => {});
  queryClient.prefetchQuery({
    queryKey: queryKeys.orders.gtt(),
    queryFn: () => client.get("/v1/orders/gtt"),
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
    queryKey: queryKeys.scanner.automations(),
    queryFn: () => client.get("/v1/scanner-automations"),
    staleTime: 10 * 1000,
  }).catch(() => {});
}
