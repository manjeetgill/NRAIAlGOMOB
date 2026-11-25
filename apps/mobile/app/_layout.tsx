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
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import IndexStrip from "@/components/IndexStrip";
import SearchBar from "@/components/SearchBar";
import { ThemeProvider, useTheme } from "@/components/ThemeProvider";
import { queryClient, initializeQueryClient } from "@/utils/queryClient";
import { useAuthStore } from "@nraialgo/shared/stores";
import { initializeApiClient, hydrateCachedUser } from "@/utils/apiClient";
import * as SplashScreen from "expo-splash-screen";
import { useDeepLinking } from "@/utils/deepLinking";

// Prevent splash screen from auto-hiding
SplashScreen.preventAutoHideAsync();

/**
 * The one chrome every route shares: the index strip sits above the router slot, so the market reading is
 * on the chain, the basket builder and the positions desk alike rather than only on the Watchlist tab. The
 * sign-in screen is the single exception - it has no session to read quotes with.
 *
 * Under the strip is the universal search. It is here rather than on one tab because a trader who wants a
 * stock should not have to know which screen holds the box - and the search screen itself leaves it out,
 * so the app never shows two fields for the same job.
 */
function Shell() {
  const { resolvedTheme } = useTheme();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const bg = resolvedTheme === "dark" ? "#0f172a" : "#f8fafc";
  return (
    <View style={{ flex: 1, backgroundColor: bg, paddingTop: insets.top }}>
      {pathname !== "/login" ? <IndexStrip /> : null}
      {pathname !== "/login" && pathname !== "/search" ? <SearchBar /> : null}
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
        // Hydrate cached user shell from AsyncStorage (~5ms) so cold boot never blocks on network
        await Promise.all([
          hydrateCachedUser(),
          initializeQueryClient(),
        ]);
      } catch (error) {
        console.error("Failed to initialize app:", error);
      } finally {
        setLoading(false);
        setInitialized(true);
        SplashScreen.hideAsync();
        // Revalidate session cookie in background
        void initializeApiClient();
      }
    }

    init();
  }, [setLoading]);

  if (!initialized) {
    return null; // Splash screen shows while initializing
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <Shell />
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}