/**
 * Mobile API Client Configuration
 *
 * Sets up the shared API client with React Native specific token storage
 */

import { createApiClient, type ApiClient } from "@nraialgo/shared/api";
import type { User } from "@nraialgo/shared/api";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Constants } from "@nraialgo/shared/constants";
import { useAuthStore } from "@nraialgo/shared/stores";
import { forgetLastKnown } from "@/hooks/useLastKnown";

// SecureStore adapter for tokens
const secureStorage = {
  getItem: async (key: string) => {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  setItem: async (key: string, value: string) => {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch (error) {
      console.warn(`Failed to store ${key}:`, error);
    }
  },
  removeItem: async (key: string) => {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      // Ignore
    }
  },
};

// Token keys
const TOKEN_KEYS = {
  ACCESS: "nraialgo.access_token",
  REFRESH: "nraialgo.refresh_token",
};

// Create API client instance
let apiClientInstance: ApiClient | null = null;

export function getApiClient(): ApiClient {
  if (apiClientInstance) return apiClientInstance;

  const config = {
    baseUrl: Constants.API.BASE_URL,
    wsUrl: Constants.API.WS_URL,
    getToken: async () => secureStorage.getItem(TOKEN_KEYS.ACCESS),
    setToken: async (token) => {
      if (token) {
        await secureStorage.setItem(TOKEN_KEYS.ACCESS, token);
      } else {
        await secureStorage.removeItem(TOKEN_KEYS.ACCESS);
      }
      // Also update Zustand store
      useAuthStore.getState().setTokens(token, useAuthStore.getState().refreshToken);
    },
    clearToken: async () => {
      await secureStorage.removeItem(TOKEN_KEYS.ACCESS);
      await secureStorage.removeItem(TOKEN_KEYS.REFRESH);
      useAuthStore.getState().setTokens(null, null);
    },
  };

  apiClientInstance = createApiClient(config);
  return apiClientInstance;
}

// Built at import so the client exists before any screen asks for it. Registering the shared hooks needs
// the app's query client, which is the one job `utils/queryClient` does — see configureApi there.
getApiClient();

// Prove the session the way the server defines one: myalgodesk.in keeps identity in a
// session cookie, so a successful /v1/auth/me is the only evidence of being signed in.
let initInFlight: Promise<boolean> | null = null;

const CACHED_USER_KEY = "nraialgo.cached_user";

export async function hydrateCachedUser(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(CACHED_USER_KEY);
    if (!raw) return false;
    const user = JSON.parse(raw) as User;
    if (user && typeof user === "object") {
      useAuthStore.getState().setUser(user);
      return true;
    }
  } catch {
    // Ignore corrupt cache
  }
  return false;
}

export async function initializeApiClient(): Promise<boolean> {
  if (initInFlight) return initInFlight;
  initInFlight = (async () => {
    const client = getApiClient();
    try {
      const user = await client.get<User>("/v1/auth/me");
      useAuthStore.getState().setUser(user);
      AsyncStorage.setItem(CACHED_USER_KEY, JSON.stringify(user)).catch(() => {});
      return true;
    } catch {
      useAuthStore.getState().logout();
      AsyncStorage.removeItem(CACHED_USER_KEY).catch(() => {});
      // The saved book belongs to the workspace that just lost its session, not to whoever signs in next.
      forgetLastKnown();
      return false;
    } finally {
      initInFlight = null;
    }
  })();
  return initInFlight;
}