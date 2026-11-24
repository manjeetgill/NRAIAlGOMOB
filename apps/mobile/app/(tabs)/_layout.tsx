/**
 * Tab Navigation Layout
 *
 * Bottom tab navigator for main app sections
 */

import React from "react";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useColorScheme } from "react-native";

export default function TabLayout() {
  const colorScheme = useColorScheme();

  return (
    <Tabs
      id="tabs"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colorScheme === "dark" ? "#38bdf8" : "#0284c7",
        tabBarInactiveTintColor: colorScheme === "dark" ? "#64748b" : "#94a3b8",
        tabBarStyle: {
          backgroundColor: colorScheme === "dark" ? "#0f172a" : "#ffffff",
          borderTopWidth: 1,
          borderTopColor: colorScheme === "dark" ? "#1e293b" : "#e2e8f0",
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
        name="scanner"
        options={{
          title: "Scanner",
          tabBarIcon: ({ focused, color }) => (
            <Ionicons name={focused ? "search" : "search-outline"} size={24} color={color as string} />
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