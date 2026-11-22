/**
 * TanStack Query Client for Mobile
 *
 * Configures the query client with mobile-appropriate defaults
 */

import { QueryClient } from "@tanstack/react-query";
import { configureApi } from "@nraialgo/shared/api";
import { getApiClient, initializeApiClient } from "./apiClient";
import { QUERY_CONFIG } from "@nraialgo/shared/constants";

// Create query client with mobile defaults
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: QUERY_CONFIG.STALE_TIME_NORMAL,
      retry: QUERY_CONFIG.RETRY_COUNT,
      retryDelay: QUERY_CONFIG.RETRY_DELAY,
      refetchOnWindowFocus: false, // Mobile doesn't have window focus in same way
      refetchOnReconnect: true,
      refetchOnMount: true,
    },
    mutations: {
      retry: 1,
      retryDelay: QUERY_CONFIG.RETRY_DELAY,
    },
  },
});

// Registered against this exact instance: the shared hooks clear the cache on logout and invalidate it
// after a send from outside React, so a client of their own left every one of those refreshes landing in
// a cache no screen reads — and the signed-out account's rows sitting in the one everybody sees.
configureApi(getApiClient(), queryClient);

// Initialize everything
export async function initializeQueryClient(): Promise<void> {
  await initializeApiClient();
}

// Export for use in components
export { queryClient as default };