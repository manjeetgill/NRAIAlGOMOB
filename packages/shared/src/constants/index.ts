/**
 * Constants - Shared enums, config, feature flags
 *
 * Single source of truth for all constant values
 */

// ===== API =====
export const API = {
  BASE_URL: "https://myalgodesk.in",
  WS_URL: "wss://myalgodesk.in",
  TIMEOUT: 30_000,
  WS_RECONNECT_DELAY: 2000,
  WS_MAX_RECONNECT_ATTEMPTS: 10,
} as const;

export const ENDPOINTS = {
  // Auth
  AUTH_ME: "/v1/auth/me",
  AUTH_LOGIN: "/v1/auth/login",
  AUTH_LOGOUT: "/v1/auth/logout",
  AUTH_REFRESH: "/v1/auth/refresh",
  AUTH_BROKERS: "/v1/auth/brokers",

  // Baskets
  BASKETS: "/v1/baskets",
  BASKET_DETAIL: (id: string) => `/v1/baskets/${id}`,
  BASKET_EXIT_LEG: (id: string) => `/v1/baskets/${id}/legs/exit`,
  BASKET_RECORD_EXIT: (id: string) => `/v1/baskets/${id}/legs/exit-price`,
  BASKET_REMOVE_LEG: (id: string) => `/v1/baskets/${id}/legs/remove`,
  BASKET_BACKFILL: "/v1/baskets/backfill-exits",
  BASKET_DELETE: (id: string) => `/v1/baskets/${id}`,

  // Positions
  POSITIONS_OPEN: "/v1/positions/open",
  POSITIONS_CLOSED: "/v1/positions/closed",

  // Watchlist
  WATCHLIST: "/v1/watchlist",
  WATCHLIST_SNAPSHOT: "/v1/watchlist/snapshot",
  WATCHLIST_RADAR: "/v1/watchlist/radar",

  // Option Chain
  OPTION_CHAIN: "/v1/option-chain",
  OPTION_EXPIRIES: "/v1/option-chain/expiries",
  STRATEGY_ANALYSIS: "/v1/strategy-analysis",

  // Orders
  ORDERS: "/v1/orders",

  // Market Data
  QUOTES: "/v1/quotes",
  INDICES: "/v1/indices",
  DEPTH: (symbol: string) => `/v1/depth/${symbol}`,
  CHARTS_INTRADAY: "/v1/charts/intraday",

  // Scanner
  AUTOMATIONS: "/v1/scanner-automations",
  LIVE_TRADES: "/v1/scanner-automations/live-trades",

  // Algo Lab
  ALGO_FLEET: "/v1/algo-lab/fleet",
  ALGO_DRAFTS: "/v1/algo-lab/drafts",

  // History
  HISTORY: "/v1/history",

  // WebSocket
  QUOTES_STREAM: "/v1/quotes/stream",
} as const;

// ===== BROKERS =====
export const BROKERS = {
  ICICI: "icici",
  ZERODHA: "zerodha",
  KOTAK: "kotak",
} as const;

export type BrokerProvider = (typeof BROKERS)[keyof typeof BROKERS];

export const BROKER_LABELS: Record<BrokerProvider, string> = {
  [BROKERS.ICICI]: "ICICI Direct",
  [BROKERS.ZERODHA]: "Zerodha",
  [BROKERS.KOTAK]: "Kotak Securities",
};

export const BROKER_SEGMENTS = {
  NSE: "NSE",
  NFO: "NFO",
  BSE: "BSE",
  BFO: "BFO",
  MCX: "MCX",
  CDS: "CDS",
} as const;

export type Exchange = (typeof BROKER_SEGMENTS)[keyof typeof BROKER_SEGMENTS];

// ===== PRODUCT TYPES =====
export const PRODUCT_TYPES = {
  CNC: "CNC",        // Cash and Carry (Delivery)
  MIS: "MIS",        // Margin Intraday Square-off
  NRML: "NRML",      // Normal (Overnight F&O)
  CO: "CO",          // Cover Order
  BO: "BO",          // Bracket Order
  MTF: "MTF",        // Margin Trading Facility
} as const;

export type ProductType = (typeof PRODUCT_TYPES)[keyof typeof PRODUCT_TYPES];

export const ORDER_TYPES = {
  MARKET: "MARKET",
  LIMIT: "LIMIT",
  SL: "SL",          // Stop Loss Limit
  SL_M: "SL-M",      // Stop Loss Market
} as const;

export type OrderType = (typeof ORDER_TYPES)[keyof typeof ORDER_TYPES];

export const ORDER_VALIDITY = {
  DAY: "DAY",
  IOC: "IOC",
  GTT: "GTT",
} as const;

export type OrderValidity = (typeof ORDER_VALIDITY)[keyof typeof ORDER_VALIDITY];

export const ORDER_SIDES = {
  BUY: "BUY",
  SELL: "SELL",
} as const;

export type OrderSide = (typeof ORDER_SIDES)[keyof typeof ORDER_SIDES];

// ===== OPTION CHAIN =====
export const OPTION_RIGHTS = {
  CE: "CE",
  PE: "PE",
  CALL: "CALL",
  PUT: "PUT",
} as const;

export type OptionRight = (typeof OPTION_RIGHTS)[keyof typeof OPTION_RIGHTS];

export const INDEX_NAMES = {
  NIFTY: "NIFTY 50",
  BANKNIFTY: "NIFTY BANK",
  FINNIFTY: "NIFTY FIN SERVICE",
  MIDCPNIFTY: "NIFTY MIDCAP SELECT",
} as const;

export type IndexName = (typeof INDEX_NAMES)[keyof typeof INDEX_NAMES];

export const CHART_INTERVALS = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "1d": "1d",
  "1w": "1w",
} as const;

export type ChartInterval = (typeof CHART_INTERVALS)[keyof typeof CHART_INTERVALS];

export const CHART_STUDIES = {
  VWAP: "VWAP",
  EMA_9: "EMA 9",
  EMA_20: "EMA 20",
  EMA_50: "EMA 50",
  RSI: "RSI",
  MACD: "MACD",
  BOLLINGER: "Bollinger Bands",
  SUPER_TREND: "SuperTrend",
} as const;

export type ChartStudy = (typeof CHART_STUDIES)[keyof typeof CHART_STUDIES];

// ===== BASKET KINDS =====
export const BASKET_KINDS = {
  AUTOMATED: "automated",
  PAPER: "paper",
  MANUAL: "manual",
  NAMED: "named",
} as const;

export type BasketKind = (typeof BASKET_KINDS)[keyof typeof BASKET_KINDS];

export const BASKET_STATUS = {
  OPEN: "open",
  CLOSED: "closed",
  WORKING: "working",
} as const;

export type BasketStatus = (typeof BASKET_STATUS)[keyof typeof BASKET_STATUS];

// ===== TIME PRESETS =====
export const TIME_PRESETS = {
  TODAY: "today",
  "7D": "7d",
  "30D": "30d",
  "3M": "3m",
  "6M": "6m",
  "1Y": "1y",
  ALL: "all",
} as const;

export type TimePreset = (typeof TIME_PRESETS)[keyof typeof TIME_PRESETS];

export const PRESET_LABELS: Record<TimePreset, string> = {
  [TIME_PRESETS.TODAY]: "Today",
  [TIME_PRESETS["7D"]]: "Last 7 days",
  [TIME_PRESETS["30D"]]: "Last 30 days",
  [TIME_PRESETS["3M"]]: "Last 3 months",
  [TIME_PRESETS["6M"]]: "Last 6 months",
  [TIME_PRESETS["1Y"]]: "Last year",
  [TIME_PRESETS.ALL]: "All time",
};

export const PRESET_DAYS: Record<TimePreset, number | null> = {
  [TIME_PRESETS.TODAY]: 0,
  [TIME_PRESETS["7D"]]: 6,
  [TIME_PRESETS["30D"]]: 29,
  [TIME_PRESETS["3M"]]: null,
  [TIME_PRESETS["6M"]]: null,
  [TIME_PRESETS["1Y"]]: null,
  [TIME_PRESETS.ALL]: null,
};

export const PRESET_MONTHS: Record<TimePreset, number | null> = {
  [TIME_PRESETS.TODAY]: null,
  [TIME_PRESETS["7D"]]: null,
  [TIME_PRESETS["30D"]]: null,
  [TIME_PRESETS["3M"]]: 3,
  [TIME_PRESETS["6M"]]: 6,
  [TIME_PRESETS["1Y"]]: 12,
  [TIME_PRESETS.ALL]: null,
};

// ===== QUERY CONFIG =====
export const QUERY_CONFIG = {
  // Stale times (ms)
  STALE_TIME_REALTIME: 1_000,      // 1s - live quotes
  STALE_TIME_FAST: 3_000,          // 3s - positions, depth
  STALE_TIME_NORMAL: 5_000,        // 5s - baskets, radar
  STALE_TIME_SLOW: 30_000,         // 30s - watchlists, expiries
  STALE_TIME_STATIC: 60_000,       // 1m - indices, automations

  // Refetch intervals (ms)
  REFETCH_REALTIME: 1_000,
  REFETCH_FAST: 3_000,
  REFETCH_NORMAL: 10_000,
  REFETCH_SLOW: 30_000,
  REFETCH_NEVER: false,

  // Retry
  RETRY_COUNT: 3,
  RETRY_DELAY: 1000,
} as const;

// ===== PAGINATION =====
export const PAGINATION = {
  DEFAULT_LIMIT: 50,
  MAX_LIMIT: 200,
  ORDERS_LIMIT: 2000,
} as const;

// ===== STORAGE KEYS =====
export const STORAGE_KEYS = {
  AUTH_TOKEN: "nraialgo.auth.token",
  REFRESH_TOKEN: "nraialgo.auth.refresh",
  USER: "nraialgo.auth.user",
  THEME: "nraialgo.ui.theme",
  WATCHLISTS: "nraialgo.watchlists",
  RECENT_SYMBOLS: "nraialgo.recent.symbols",
  ORDER_TICKET: "nraialgo.trading.orderTicket",
  OPTION_CHAIN: "nraialgo.trading.optionChain",
  CHART: "nraialgo.trading.chart",
} as const;

// ===== FEATURE FLAGS =====
export const FEATURES = {
  ENABLE_PAPER_TRADING: true,
  ENABLE_BACKFILL: true,
  ENABLE_MANUAL_EXIT_PRICE: true,
  ENABLE_RADAR: true,
  ENABLE_ALGO_LAB: true,
  ENABLE_TERMINAL_CHARTS: true,
  ENABLE_PUSH_NOTIFICATIONS: false, // Requires native setup
  ENABLE_BIOMETRIC_AUTH: false,     // Requires native setup
  ENABLE_OFFLINE_QUEUE: false,      // Future
} as const;

// ===== ERROR CODES =====
export const ERROR_CODES = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  BROKER_ERROR: "BROKER_ERROR",
  BROKER_QUOTA: "BROKER_QUOTA",
  BROKER_SESSION_EXPIRED: "BROKER_SESSION_EXPIRED",
  NETWORK_ERROR: "NETWORK_ERROR",
  TIMEOUT: "TIMEOUT",
  UNKNOWN: "UNKNOWN",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// ===== MARKET HOURS =====
export const MARKET_HOURS = {
  PRE_OPEN_START: "09:00",
  OPEN: "09:15",
  CLOSE: "15:30",
  POST_CLOSE_END: "16:00",
  TIMEZONE: "Asia/Kolkata",
} as const;

export function isMarketOpen(now: Date = new Date()): boolean {
  const ist = new Date(now.toLocaleString("en-US", { timeZone: MARKET_HOURS.TIMEZONE }));
  const day = ist.getDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return false;

  const hours = ist.getHours();
  const minutes = ist.getMinutes();
  const time = hours * 60 + minutes;

  const openTime = 9 * 60 + 15;  // 09:15
  const closeTime = 15 * 60 + 30; // 15:30

  return time >= openTime && time <= closeTime;
}

export function isPreOpen(now: Date = new Date()): boolean {
  const ist = new Date(now.toLocaleString("en-US", { timeZone: MARKET_HOURS.TIMEZONE }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;

  const hours = ist.getHours();
  const minutes = ist.getMinutes();
  const time = hours * 60 + minutes;

  const preOpenStart = 9 * 60; // 09:00
  const openTime = 9 * 60 + 15; // 09:15

  return time >= preOpenStart && time < openTime;
}

// ===== VALIDATION =====
export const VALIDATION = {
  SYMBOL_MAX_LENGTH: 40,
  SYMBOL_PATTERN: /^[A-Z0-9&_. -]{1,40}$/,
  QUANTITY_MAX: 10_000_000,
  PRICE_MAX: 100_000,
  PRICE_MIN: 0.01,
  LOT_SIZE_MIN: 1,
  STRIKE_MIN: 1,
  EXPIRY_FORMAT: /^\d{4}-\d{2}-\d{2}$/,
} as const;

// ===== EXPORTS =====
export const Constants = {
  API,
  ENDPOINTS,
  BROKERS,
  BROKER_LABELS,
  BROKER_SEGMENTS,
  PRODUCT_TYPES,
  ORDER_TYPES,
  ORDER_VALIDITY,
  ORDER_SIDES,
  OPTION_RIGHTS,
  INDEX_NAMES,
  CHART_INTERVALS,
  CHART_STUDIES,
  BASKET_KINDS,
  BASKET_STATUS,
  TIME_PRESETS,
  PRESET_LABELS,
  PRESET_DAYS,
  PRESET_MONTHS,
  QUERY_CONFIG,
  PAGINATION,
  STORAGE_KEYS,
  FEATURES,
  ERROR_CODES,
  MARKET_HOURS,
  VALIDATION,
} as const;