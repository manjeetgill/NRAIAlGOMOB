/**
 * Theme Provider for Mobile
 *
 * Handles light/dark/system theme with persistence
 */

import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { Appearance, ColorSchemeName, StyleSheet, View } from "react-native";
import { useUIStore } from "@nraialgo/shared/stores";

type Theme = "light" | "dark" | "system";

interface ThemeContextType {
  theme: Theme;
  resolvedTheme: "light" | "dark";
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { theme, setTheme: setThemeStore } = useUIStore();

  // Resolve system theme
  const resolveTheme = useCallback((theme: Theme): "light" | "dark" => {
    if (theme === "system") {
      return Appearance.getColorScheme() ?? "light";
    }
    return theme;
  }, []);

  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() => {
    const currentTheme = useUIStore.getState().theme;
    return currentTheme === "system" ? (Appearance.getColorScheme() ?? "light") : currentTheme;
  });

  // Update resolved theme when system/theme changes
  useEffect(() => {
    setResolvedTheme(resolveTheme(theme));

    const subscription = Appearance.addChangeListener(({ colorScheme }) => {
      if (theme === "system") {
        setResolvedTheme(colorScheme ?? "light");
      }
    });

    return () => subscription.remove();
  }, [theme, resolveTheme]);

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeStore(newTheme);
  }, [setThemeStore]);

  const toggleTheme = useCallback(() => {
    const themes: Theme[] = ["light", "dark", "system"];
    const currentIndex = themes.indexOf(theme);
    const nextIndex = (currentIndex + 1) % themes.length;
    setTheme(themes[nextIndex]);
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}

// Global styles that adapt to theme
export const globalStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "surface.900",
  },
  card: {
    backgroundColor: "surface.800",
    borderRadius: 12,
    padding: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2,
  },
  cardHover: {
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 4,
  },
  text: {
    color: "surface.50",
  },
  textSecondary: {
    color: "surface.400",
  },
  textMuted: {
    color: "surface.500",
  },
  border: {
    borderWidth: 1,
    borderColor: "surface.700",
  },
  input: {
    backgroundColor: "surface.900",
    borderWidth: 1,
    borderColor: "surface.700",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "surface.50",
    fontSize: 16,
  },
  button: {
    backgroundColor: "brand.600",
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: {
    color: "white",
    fontWeight: "600",
    fontSize: 16,
  },
  buttonSecondary: {
    backgroundColor: "surface.700",
  },
  buttonSecondaryText: {
    color: "surface.100",
  },
  buttonDanger: {
    backgroundColor: "danger.600",
  },
});