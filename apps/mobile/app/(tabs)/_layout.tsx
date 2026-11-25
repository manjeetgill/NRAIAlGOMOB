/**
 * Tab Navigation Layout
 *
 * Bottom tab navigator for main app sections
 */

import React from "react";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/components/ThemeProvider";
import { prefetchPortfolio, prefetchOrders, prefetchOptionChain, prefetchWatchlist } from "@/utils/prefetch";

export default function TabLayout() {
  const { resolvedTheme } = useTheme();

  return (
    <Tabs
      id="tabs"
      screenListeners={{
        tabPress: (e) => {
          const routeName = e.target?.split("-")[0];
          requestAnimationFrame(() => {
            if (routeName === "portfolio") prefetchPortfolio();
            else if (routeName === "watchlist") prefetchWatchlist();
            else if (routeName === "orders") prefetchOrders();
            else if (routeName === "option" || routeName === "option-chain") prefetchOptionChain();
          });
        },
      }}
      screenOptions={{
        headerShown: false,
        freezeOnBlur: true,
        tabBarActiveTintColor: resolvedTheme === "dark" ? "#38bdf8" : "#0284c7",
        tabBarInactiveTintColor: resolvedTheme === "dark" ? "#64748b" : "#94a3b8",
        tabBarStyle: {
          backgroundColor: resolvedTheme === "dark" ? "#0f172a" : "#ffffff",
          borderTopWidth: 1,
          borderTopColor: resolvedTheme === "dark" ? "#1e293b" : "#e2e8f0",
          height: 60,
          paddingBottom: 8,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: "600",
        },
      }}
    >
      <Tabs.Screen
        name="portfolio"
        options={{
          title: "Portfolio",
          tabBarIcon: ({ focused, color }) => (
            <Ionicons name={focused ? "analytics" : "analytics-outline"} size={24} color={color as string} />
          ),
        }}
      />
      <Tabs.Screen
        name="watchlist"
        options={{
          title: "Watchlist",
          tabBarIcon: ({ focused, color }) => (
            <Ionicons name={focused ? "list" : "list-outline"} size={24} color={color as string} />
          ),
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: "Orders",
          tabBarIcon: ({ focused, color }) => (
            <Ionicons name={focused ? "document" : "document-outline"} size={24} color={color as string} />
          ),
        }}
      />
      <Tabs.Screen
        name="option-chain"
        options={{
          title: "Options",
          tabBarIcon: ({ focused, color }) => (
            <Ionicons name={focused ? "options" : "options-outline"} size={24} color={color as string} />
          ),
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: "More",
          tabBarIcon: ({ focused, color }) => (
            <Ionicons name={focused ? "menu" : "menu-outline"} size={24} color={color as string} />
          ),
        }}
      />
    </Tabs>
  );
}