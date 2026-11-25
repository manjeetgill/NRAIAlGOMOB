/**
 * Deep Linking - Mobile
 *
 * Handles incoming deep links for navigation
 * Supports both universal links (https://myalgodesk.in) and custom scheme (nraialgo://)
 */

import { useEffect } from "react";
import { Linking, Platform } from "react-native";
import { useRouter } from "expo-router";
import { useAuthStore } from "@nraialgo/shared/stores";

export interface DeepLinkRoute {
  path: string;
  params?: Record<string, string>;
}

const DEEP_LINK_PREFIXES = {
  universal: "https://myalgodesk.in",
  custom: "nraialgo://",
};

const ROUTE_MAP: Record<string, (params: Record<string, string>) => string> = {
  // The link a message or a notification carries is prod's own path, so it stays /positions even
  // though the screen it opens is now the two-tab Portfolio.
  "/positions": () => "/(tabs)/portfolio",
  "/watchlist": () => "/(tabs)/watchlist",
  "/orders": () => "/(tabs)/orders",
  "/option-chain": (params) => `/(tabs)/option-chain${params.symbol ? `?symbol=${params.symbol}` : ""}${params.expiry ? `&expiry=${params.expiry}` : ""}`,
  // The per-stock Overview: the link carries the venue so the screen opens on the exchange it was read from.
  "/stock": (params) => `/stock?exchange=${encodeURIComponent(params.exchange ?? "NSE")}&symbol=${encodeURIComponent(params.symbol ?? "")}`,
  // The chart desk is a top-level screen; the link predates it and must not point at a route that no longer exists.
  "/terminal": () => "/terminal-charts",
  "/basket": (params) => `/basket/${params.id}`,
  "/order": (params) => `/order/${params.id}`,
  "/login": () => "/login",
  "/settings": () => "/(tabs)/more",
};

export function parseDeepLink(url: string): DeepLinkRoute | null {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    const params: Record<string, string> = {};

    urlObj.searchParams.forEach((value, key) => {
      params[key] = value;
    });

    // Handle custom scheme paths (nraialgo://path)
    if (url.startsWith(DEEP_LINK_PREFIXES.custom)) {
      const customPath = url.replace(DEEP_LINK_PREFIXES.custom, "");
      const [pathPart, searchPart] = customPath.split("?");
      if (searchPart) {
        new URLSearchParams(searchPart).forEach((value, key) => {
          params[key] = value;
        });
      }
      return { path: `/${pathPart}`, params };
    }

    return { path, params };
  } catch {
    return null;
  }
}

export function resolveDeepLink(route: DeepLinkRoute): string | null {
  const handler = ROUTE_MAP[route.path];
  if (handler) {
    return handler(route.params || {});
  }
  // Try prefix matching
  for (const [pattern, handler] of Object.entries(ROUTE_MAP)) {
    if (route.path.startsWith(pattern)) {
      return handler(route.params || {});
    }
  }
  return null;
}

export function useDeepLinking() {
  const router = useRouter();
  const { isAuthenticated } = useAuthStore();

  useEffect(() => {
    // Handle app opened from deep link
    const handleInitialUrl = async () => {
      const initialUrl = await Linking.getInitialURL();
      if (initialUrl) {
        const route = parseDeepLink(initialUrl);
        if (route) {
          const targetPath = resolveDeepLink(route);
          if (targetPath) {
            // Delay navigation until router is ready
            setTimeout(() => {
              router.push(targetPath as any);
            }, 100);
          }
        }
      }
    };

    handleInitialUrl();

    // Handle incoming links while app is running
    const subscription = Linking.addEventListener("url", ({ url }) => {
      const route = parseDeepLink(url);
      if (route) {
        const targetPath = resolveDeepLink(route);
        if (targetPath) {
          router.push(targetPath as any);
        }
      }
    });

    return () => {
      subscription.remove();
    };
  }, [router, isAuthenticated]);

  return { parseDeepLink, resolveDeepLink };
}

// Helper to open deep links externally
export function openDeepLink(path: string, params?: Record<string, string>): Promise<void> {
  const queryString = params ? `?${new URLSearchParams(params).toString()}` : "";
  const url = `${DEEP_LINK_PREFIXES.custom}${path}${queryString}`;
  return Linking.openURL(url);
}

export function openUniversalLink(path: string, params?: Record<string, string>): Promise<void> {
  const queryString = params ? `?${new URLSearchParams(params).toString()}` : "";
  const url = `${DEEP_LINK_PREFIXES.universal}${path}${queryString}`;
  return Linking.openURL(url);
}