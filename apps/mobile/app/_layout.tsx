/**
 * Root Layout - Mobile App Entry Point
 *
 * Sets up providers, navigation, and global configuration
 */

import React, { useEffect } from "react";
import { Slot, usePathname } from "expo-router";
import { View } from "react-native";
import { QueryClientProvider } from "@tanstack/react-query";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import IndexStrip from "@/components/IndexStrip";
import { ThemeProvider, useTheme } from "@/components/ThemeProvider";
import { queryClient, initializeQueryClient } from "@/utils/queryClient";
import { useAuthStore } from "@nraialgo/shared/stores";
import { initializeApiClient } from "@/utils/apiClient";
import * as SplashScreen from "expo-splash-screen";
import { useDeepLinking } from "@/utils/deepLinking";

// Prevent splash screen from auto-hiding
SplashScreen.preventAutoHideAsync();

/**
 * The one chrome every route shares: the index strip sits above the router slot, so the market reading is
 * on the chain, the basket builder and the positions desk alike rather than only on the Watchlist tab. The
 * sign-in screen is the single exception - it has no session to read quotes with.
 */
function Shell() {
  const { resolvedTheme } = useTheme();
  const pathname = usePathname();
  const bg = resolvedTheme === "dark" ? "#0f172a" : "#f8fafc";
  return (
    <View style={{ flex: 1, backgroundColor: bg }}>
      {pathname !== "/login" ? <IndexStrip /> : null}
      <View style={{ flex: 1 }}>
        <Slot />
      </View>
    </View>
  );
}

export default function RootLayout() {
  const [initialized, setInitialized] = React.useState(false);
  const { isLoading, setLoading } = useAuthStore();
  useDeepLinking(); // Initialize deep linking

  useEffect(() => {
    async function init() {
      try {
        // Initialize API client and query client
        await Promise.all([
          initializeApiClient(),
          initializeQueryClient(),
        ]);
      } catch (error) {
        console.error("Failed to initialize app:", error);
      } finally {
        setLoading(false);
        setInitialized(true);
        // Hide splash screen after initialization
        SplashScreen.hideAsync();
      }
    }

    init();
  }, [setLoading]);

  if (!initialized) {
    return null; // Splash screen shows while initializing
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Shell />
        </ThemeProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}