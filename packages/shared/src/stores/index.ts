/**
 * Zustand Stores - Shared state management (no React dependencies)
 *
 * These stores contain pure state and actions, no components.
 * UI layers (web/mobile) subscribe via useStore hooks.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { createWebStorage } from "../utils";
import type { StorageAdapter } from "../utils";
import type { User, BrokerStatus } from "../api";

// Leaving `storage` undefined makes zustand reach for localStorage, which does not exist in
// React Native, so the first persist write throws. createWebStorage() is localStorage on web
// and a resolved-promise no-op everywhere else.
const defaultStorage = createWebStorage();

// ===== AUTH STORE =====
export interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  brokers: BrokerStatus[];
  isAuthenticated: boolean;
  isLoading: boolean;

  // Actions
  setAuth: (data: { user: User; accessToken: string; refreshToken: string }) => void;
  setUser: (user: User | null) => void;
  setTokens: (access: string | null, refresh: string | null) => void;
  setBrokers: (brokers: BrokerStatus[]) => void;
  updateBroker: (provider: string, updates: Partial<BrokerStatus>) => void;
  logout: () => void;
  setLoading: (loading: boolean) => void;
}

export function createAuthStore(storage?: StorageAdapter) {
  return create<AuthState>()(
    persist(
      (set, get) => ({
        user: null,
        accessToken: null,
        refreshToken: null,
        brokers: [],
        isAuthenticated: false,
        isLoading: true,

        setAuth: ({ user, accessToken, refreshToken }) =>
          set({
            user,
            accessToken,
            refreshToken,
            isAuthenticated: true,
            isLoading: false,
          }),

        setUser: (user) => set({ user, isAuthenticated: !!user }),

        setTokens: (accessToken, refreshToken) =>
          set({ accessToken, refreshToken, isAuthenticated: !!accessToken }),

        setBrokers: (brokers) => set({ brokers }),

        updateBroker: (provider, updates) =>
          set(state => ({
            brokers: state.brokers.map(b =>
              b.provider === provider ? { ...b, ...updates } : b
            ),
          })),

        logout: () =>
          set({
            user: null,
            accessToken: null,
            refreshToken: null,
            brokers: [],
            isAuthenticated: false,
          }),

        setLoading: (isLoading) => set({ isLoading }),
      }),
      {
        name: "nraialgo.auth",
        storage: createJSONStorage(() => storage ?? defaultStorage),
        partialize: state => ({
          user: state.user,
          accessToken: state.accessToken,
          refreshToken: state.refreshToken,
        }),
      }
    )
  );
}

// Default store (web - uses localStorage via middleware)
export const useAuthStore = createAuthStore();

// ===== UI STORE =====
export interface UIState {
  theme: "light" | "dark" | "system";
  sidebarOpen: boolean;
  activeTab: string;
  modals: Record<string, boolean>;
  toasts: Toast[];
  loading: Record<string, boolean>;

  // Actions
  setTheme: (theme: "light" | "dark" | "system") => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setActiveTab: (tab: string) => void;
  openModal: (id: string) => void;
  closeModal: (id: string) => void;
  closeAllModals: () => void;
  addToast: (toast: Omit<Toast, "id">) => string;
  removeToast: (id: string) => void;
  setLoading: (key: string, loading: boolean) => void;
}

export interface Toast {
  id: string;
  type: "success" | "error" | "warning" | "info";
  title: string;
  message?: string;
  duration?: number;
  action?: { label: string; onPress: () => void };
}

export function createUIStore() {
  return create<UIState>()(
    persist(
      (set, get) => ({
        theme: "system",
        sidebarOpen: false,
        activeTab: "positions",
        modals: {},
        toasts: [],
        loading: {},

        setTheme: (theme) => set({ theme }),

        toggleSidebar: () => set(state => ({ sidebarOpen: !state.sidebarOpen })),

        setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),

        setActiveTab: (activeTab) => set({ activeTab }),

        openModal: (id) => set(state => ({ modals: { ...state.modals, [id]: true } })),

        closeModal: (id) => set(state => {
          const { [id]: _, ...rest } = state.modals;
          return { modals: rest };
        }),

        closeAllModals: () => set({ modals: {} }),

        addToast: (toast) => {
          const id = Math.random().toString(36).slice(2, 10);
          const newToast: Toast = { ...toast, id };
          set(state => ({ toasts: [...state.toasts, newToast] }));
          if (toast.duration !== 0) {
            setTimeout(() => get().removeToast(id), toast.duration ?? 5000);
          }
          return id;
        },

        removeToast: (id) => set(state => ({
          toasts: state.toasts.filter(t => t.id !== id),
        })),

        setLoading: (key, loading) => set(state => ({
          loading: { ...state.loading, [key]: loading },
        })),
      }),
      {
        name: "nraialgo.ui",
        storage: createJSONStorage(() => defaultStorage),
        partialize: state => ({
          theme: state.theme,
          sidebarOpen: state.sidebarOpen,
          activeTab: state.activeTab,
        }),
      }
    )
  );
}

export const useUIStore = createUIStore();

// ===== TRADING STORE =====
export interface TradingState {
  // Order ticket state
  orderTicket: {
    symbol: string;
    exchange: string;
    product: string;
    side: "BUY" | "SELL";
    quantity: number;
    orderType: "MARKET" | "LIMIT" | "SL" | "SL-M";
    price: number;
    triggerPrice: number;
    validity: "DAY" | "IOC";
    tag: string;
  };

  // Option chain filters
  optionChain: {
    underlying: string;
    expiry: string;
    strikeRange: { min: number; max: number } | null;
    showIV: boolean;
    showDelta: boolean;
    showBidAsk: boolean;
  };

  // Chart settings
  chart: {
    interval: "1m" | "5m" | "15m" | "30m" | "1h" | "1d" | "1w";
    studies: string[];
    drawings: unknown[];
  };

  // Actions
  setOrderTicketSymbol: (symbol: string, exchange?: string, product?: string) => void;
  setOrderTicketField: <K extends keyof TradingState["orderTicket"]>(field: K, value: TradingState["orderTicket"][K]) => void;
  setOrderTicketBatch: (fields: Partial<TradingState["orderTicket"]>) => void;
  resetOrderTicket: () => void;
  setOptionChainUnderlying: (underlying: string) => void;
  setOptionChainExpiry: (expiry: string) => void;
  setOptionChainFilters: (filters: Partial<TradingState["optionChain"]>) => void;
  setChartInterval: (interval: TradingState["chart"]["interval"]) => void;
  toggleChartStudy: (study: string) => void;
}

const defaultOrderTicket = {
  symbol: "",
  exchange: "NSE",
  product: "CNC",
  side: "BUY" as const,
  quantity: 1,
  orderType: "MARKET" as const,
  price: 0,
  triggerPrice: 0,
  validity: "DAY" as const,
  tag: "",
};

const defaultOptionChain = {
  underlying: "NIFTY",
  expiry: "",
  strikeRange: null as { min: number; max: number } | null,
  showIV: false,
  showDelta: false,
  showBidAsk: true,
};

const defaultChart = {
  interval: "5m" as const,
  studies: [] as string[],
  drawings: [] as unknown[],
};

export function createTradingStore() {
  return create<TradingState>()(
    persist(
      (set) => ({
        orderTicket: defaultOrderTicket,
        optionChain: defaultOptionChain,
        chart: defaultChart,

        setOrderTicketSymbol: (symbol, exchange, product) =>
          set(state => ({
            orderTicket: {
              ...state.orderTicket,
              symbol,
              exchange: exchange ?? state.orderTicket.exchange,
              product: product ?? state.orderTicket.product,
            },
          })),

        setOrderTicketField: (field, value) =>
          set(state => ({
            orderTicket: { ...state.orderTicket, [field]: value },
          })),

        setOrderTicketBatch: (fields) =>
          set(state => ({
            orderTicket: { ...state.orderTicket, ...fields },
          })),

        resetOrderTicket: () => set({ orderTicket: defaultOrderTicket }),

        setOptionChainUnderlying: (underlying) =>
          set(state => ({
            optionChain: { ...state.optionChain, underlying, expiry: "" },
          })),

        setOptionChainExpiry: (expiry) =>
          set(state => ({ optionChain: { ...state.optionChain, expiry } })),

        setOptionChainFilters: (filters) =>
          set(state => ({ optionChain: { ...state.optionChain, ...filters } })),

        setChartInterval: (interval) =>
          set(state => ({ chart: { ...state.chart, interval } })),

        toggleChartStudy: (study) =>
          set(state => ({
            chart: {
              ...state.chart,
              studies: state.chart.studies.includes(study)
                ? state.chart.studies.filter(s => s !== study)
                : [...state.chart.studies, study],
            },
          })),
      }),
      {
        name: "nraialgo.trading",
        storage: createJSONStorage(() => defaultStorage),
        partialize: state => ({
          orderTicket: state.orderTicket,
          optionChain: state.optionChain,
          chart: state.chart,
        }),
      }
    )
  );
}

export const useTradingStore = createTradingStore();

// ===== STORE REGISTRY =====
export const stores = {
  auth: useAuthStore,
  ui: useUIStore,
  trading: useTradingStore,
} as const;

export type StoreName = keyof typeof stores;

// Helper to reset all stores (on logout)
export function resetAllStores() {
  Object.values(stores).forEach(store => {
    store.getState(); // Ensure store is initialized
    // Each store's logout/reset is handled individually
  });
  useAuthStore.getState().logout();
  useTradingStore.getState().resetOrderTicket();
}