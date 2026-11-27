/**
 * TanStack Query Client for Mobile
 *
 * Configures the query client with mobile-appropriate defaults
 */

import { AppState, AppStateStatus, Platform } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { focusManager, onlineManager, QueryClient } from "@tanstack/react-query";
import { configureApi, quoteStreamConnected, recoverQuoteStream } from "@nraialgo/shared/api";
import { getApiClient, initializeApiClient } from "./apiClient";
import { QUERY_CONFIG } from "@nraialgo/shared/constants";

/**
 * Two of these signals already restart React Query above; the tick stream needs the same two because a
 * phone leaves it behind: the socket waiting for a screen that has just come back is usually open and
 * carrying nothing, and a stream the server refused against a tab that has since closed is not a refusal
 * this app should still be honouring. Both retire the connection, so a screen repaints from a real feed
 * instead of one it has to guess about.
 */
let streamWasOnline = true;

// Online status manager for React Native
onlineManager.setEventListener((setOnline) => {
  return NetInfo.addEventListener((state) => {
    const connected = !!state.isConnected;
    setOnline(connected);
    if (connected && !streamWasOnline) recoverQuoteStream();
    streamWasOnline = connected;
  });
});

// AppState lifecycle manager for React Native: pause queries/polling in background
function onAppStateChange(status: AppStateStatus) {
  if (Platform.OS !== "web") {
    focusManager.setFocused(status === "active");
    if (status === "active" && !quoteStreamConnected()) {
      recoverQuoteStream();
    }
  }
}

AppState.addEventListener("change", onAppStateChange);

// Create query client with mobile defaults
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: QUERY_CONFIG.STALE_TIME_NORMAL,
      retry: QUERY_CONFIG.RETRY_COUNT,
      retryDelay: QUERY_CONFIG.RETRY_DELAY,
      refetchOnWindowFocus: true, // Tied to AppState active status via focusManager
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

// Initialize everything needed for query client (configuration is already static at import)
export async function initializeQueryClient(): Promise<void> {
  // Configured statically via configureApi(getApiClient(), queryClient)
}

// Export for use in components
export { queryClient as default };