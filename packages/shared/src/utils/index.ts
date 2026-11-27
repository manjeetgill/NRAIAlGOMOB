/**
 * Pure TypeScript Utilities - Shared between web and mobile
 *
 * No React dependencies, no platform-specific code
 * All functions are pure and testable
 */

// ===== DATE/TIME =====
export const IST_OFFSET = 19_800_000; // UTC+5:30 in ms
export const DAY_MS = 86_400_000;

export function toIST(date: Date | string | number): Date {
  const d = date instanceof Date ? date : new Date(date);
  return new Date(d.getTime() + IST_OFFSET);
}

export function fromIST(date: Date): Date {
  return new Date(date.getTime() - IST_OFFSET);
}

export function formatIST(date: Date | string | number, options?: Intl.DateTimeFormatOptions): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "short",
    timeStyle: "medium",
    ...options,
  });
}

export function formatISTDate(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
}

export function formatISTTime(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function isTodayIST(date: Date | string | number): boolean {
  const d = date instanceof Date ? date : new Date(date);
  const today = new Date();
  return formatISTDate(d) === formatISTDate(today);
}

export function startOfDayIST(date: Date = new Date()): Date {
  const ist = toIST(date);
  ist.setHours(0, 0, 0, 0);
  return fromIST(ist);
}

export function endOfDayIST(date: Date = new Date()): Date {
  const ist = toIST(date);
  ist.setHours(23, 59, 59, 999);
  return fromIST(ist);
}

export function addDaysIST(date: Date, days: number): Date {
  const ist = toIST(date);
  ist.setDate(ist.getDate() + days);
  return fromIST(ist);
}

export function addMonthsIST(date: Date, months: number): Date {
  const ist = toIST(date);
  ist.setMonth(ist.getMonth() + months);
  return fromIST(ist);
}

export function monthsBackIST(months: number, from: Date = new Date()): string {
  const d = addMonthsIST(from, -months);
  return formatISTDate(d);
}

export function parseISODate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

export function parseISTDateTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const str = String(value).trim();
  if (!str) return null;

  // Handle time-only strings (e.g., "14:30:00")
  if (/^\d{2}:\d{2}(?::\d{2})?$/.test(str)) {
    const today = formatISTDate(new Date());
    return new Date(`${today}T${str}+05:30`);
  }

  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

// ===== NUMBER FORMATTING =====
export function formatNumber(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatRupees(value: number | null | undefined, options?: { signed?: boolean; decimals?: number }): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const { signed = false, decimals = 2 } = options ?? {};
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const sign = signed ? (value > 0 ? "+" : value < 0 ? "−" : "") : value < 0 ? "−" : "";
  return `${sign}₹${formatted}`;
}

export function formatPercent(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(decimals)}%`;
}

export function formatQuantity(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-IN");
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ===== STRING =====
export function truncate(str: string, length: number, suffix = "…"): string {
  if (str.length <= length) return str;
  return str.slice(0, length - suffix.length) + suffix;
}

export function slugify(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

export function titleCase(str: string): string {
  return str
    .toLowerCase()
    .split(" ")
    .map(capitalize)
    .join(" ");
}

// ===== OBJECT/ARRAY =====
export function groupBy<T, K extends string | number | symbol>(
  array: T[],
  key: (item: T) => K
): Record<K, T[]> {
  return array.reduce((acc, item) => {
    const k = key(item);
    (acc[k] = acc[k] || []).push(item);
    return acc;
  }, {} as Record<K, T[]>);
}

export function keyBy<T, K extends string | number | symbol>(
  array: T[],
  key: (item: T) => K
): Record<K, T> {
  return array.reduce((acc, item) => {
    acc[key(item)] = item;
    return acc;
  }, {} as Record<K, T>);
}

export function unique<T>(array: T[], key?: (item: T) => unknown): T[] {
  if (!key) return [...new Set(array)];
  const seen = new Set<unknown>();
  return array.filter(item => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function sortBy<T>(array: T[], key: (item: T) => number | string, direction: "asc" | "desc" = "asc"): T[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...array].sort((a, b) => {
    const aVal = key(a);
    const bVal = key(b);
    if (aVal < bVal) return -1 * multiplier;
    if (aVal > bVal) return 1 * multiplier;
    return 0;
  });
}

export function chunk<T>(array: T[], size: number): T[][] {
  if (size <= 0) return [];
  const result: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

export function flatten<T>(arrays: T[][]): T[] {
  return arrays.reduce((acc, arr) => acc.concat(arr), []);
}

// ===== ASYNC =====
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function retry<T>(
  fn: () => Promise<T>,
  options: { retries: number; delay: number; backoff?: number; onError?: (error: Error, attempt: number) => void } = { retries: 3, delay: 1000 }
): Promise<T> {
  const { retries, delay, backoff = 2, onError } = options;
  return fn().catch(err => {
    if (retries <= 0) throw err;
    onError?.(err, retries);
    return sleep(delay).then(() => retry(fn, { retries: retries - 1, delay: delay * backoff, backoff, onError }));
  });
}

export function timeout<T>(promise: Promise<T>, ms: number, message = "Operation timed out"): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

// ===== STORAGE =====
export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
}

// Web implementation (localStorage)
export function createWebStorage(): StorageAdapter {
  // React Native defines `window`, so that is not a usable web test; localStorage itself is.
  const ls = typeof localStorage !== "undefined" ? localStorage : null;
  if (!ls) {
    return {
      getItem: () => Promise.resolve(null),
      setItem: () => Promise.resolve(),
      removeItem: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    };
  }
  return {
    getItem: key => Promise.resolve(ls.getItem(key)),
    setItem: (key, value) => { ls.setItem(key, value); return Promise.resolve(); },
    removeItem: key => { ls.removeItem(key); return Promise.resolve(); },
    clear: () => { ls.clear(); return Promise.resolve(); },
  };
}

// ===== ERROR HANDLING =====
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number = 500,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }

  static fromApiError(error: unknown): AppError {
    if (error instanceof AppError) return error;
    if (error instanceof Error && "status" in error) {
      const apiError = error as { status: number; code?: string; details?: unknown };
      return new AppError(error.message, apiError.code ?? "API_ERROR", apiError.status, apiError.details);
    }
    return new AppError(error instanceof Error ? error.message : "Unknown error", "UNKNOWN");
  }
}

export function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError && error.message.includes("network");
}

export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.message.includes("timeout"));
}

export function isAuthError(error: unknown): boolean {
  if (error instanceof AppError) return error.status === 401;
  if (error instanceof Error && "status" in error) return (error as { status: number }).status === 401;
  return false;
}

// ===== DEVICE/ENV =====
export function isWeb(): boolean {
  return typeof globalThis !== "undefined" && typeof (globalThis as any).window !== "undefined";
}

export function isMobile(): boolean {
  if (!isWeb()) return true; // React Native
  const win = (globalThis as any).window;
  const nav = win?.navigator;
  return nav ? /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(nav.userAgent) : false;
}

export function getPlatform(): "web" | "ios" | "android" | "unknown" {
  if (!isWeb()) {
    // In React Native, Platform.OS would be used
    return "unknown";
  }
  const win = (globalThis as any).window;
  const nav = win?.navigator;
  const ua = nav?.userAgent ?? "";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "web";
}

// ===== SESSION COOKIES =====
/**
 * React Native folds several `Set-Cookie` headers into one comma-joined string. A cookie's own expiry comma
 * is followed by a weekday, never by `name=`, so that lookahead is the only safe split point.
 */
export function splitSetCookies(values: string[]): string[] {
  return values.flatMap((value) => value.split(/,\s*(?=[A-Za-z0-9!#$%&'*+.^_`|~-]+=)/));
}

/**
 * The `name=value` pairs worth replaying to the server, and nothing else — a CDN or analytics cookie that
 * rides along with the response is not this app's identity. An emptied cookie is a sign-out, so a blank
 * value discards the whole set rather than leaving a stale session behind.
 */
export function keptCookiePairs(values: string[], keep: string[]): string[] {
  const pairs: string[] = [];
  for (const segment of splitSetCookies(values)) {
    const pair = segment.split(";")[0].trim();
    const name = pair.split("=")[0];
    if (!keep.includes(name)) continue;
    if (!pair.slice(name.length + 1)) return [];
    pairs.push(pair);
  }
  return pairs;
}

// ===== EXPORTS =====
export const DateUtils = {
  toIST,
  fromIST,
  formatIST,
  formatISTDate,
  formatISTTime,
  isTodayIST,
  startOfDayIST,
  endOfDayIST,
  addDaysIST,
  addMonthsIST,
  monthsBackIST,
  parseISODate,
  parseISTDateTime,
};

export const NumberUtils = {
  formatNumber,
  formatRupees,
  formatPercent,
  formatQuantity,
  roundTo,
  clamp,
};

export const StringUtils = {
  truncate,
  slugify,
  capitalize,
  titleCase,
};

export const ArrayUtils = {
  groupBy,
  keyBy,
  unique,
  sortBy,
  chunk,
  flatten,
};

export const AsyncUtils = {
  sleep,
  retry,
  timeout,
  debounce,
  throttle,
};

export const StorageUtils = {
  createWebStorage,
};

export const ErrorUtils = {
  AppError,
  isNetworkError,
  isTimeoutError,
  isAuthError,
};

export const DeviceUtils = {
  isWeb,
  isMobile,
  getPlatform,
};