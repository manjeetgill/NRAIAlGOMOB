/**
 * The book the phone has already shown, kept for the minutes prod does not answer with one.
 *
 * Prod's own saved copy is always the first fallback: a degraded account section still carries the broker's
 * last confirmed rows, and those outrank anything this app remembers. The phone's cache is for the case where
 * prod cannot serve at all — no network, a refused read, a 502 — and there the honest answer to "where is my
 * book?" is the book as it last stood, with the minute it was read, rather than a blank screen that says
 * nothing about the owner's own positions.
 *
 * The rule the tests hold this to: an answer always beats a cache, and an answer that says the list is flat
 * clears the cache instead of leaving a ghost of a trade that no longer exists.
 */

import type { StorageAdapter } from "../utils";

/** The surfaces that keep a last-fetched copy. `watchlist()` is one list, by number or built-in name. */
export const LAST_KNOWN = {
  positions: "positions",
  holdings: "holdings",
  indexStrip: "index-strip",
  watchlist: (list: number | string) => `watchlist-${list}`,
} as const;

export type LastKnownSurface = string;

export interface LastKnown<T> {
  /** When prod answered with these rows, as an ISO timestamp the phone itself recorded. */
  at: string;
  rows: T[];
}

export type RowSource = "prod" | "last-fetched" | "none";

export interface Shown<T> {
  rows: T[];
  source: RowSource;
}

/** A saved book older than this is not worth showing: the phone cannot claim a position it has not seen in a week. */
export const LAST_KNOWN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Which rows a screen shows, and where they came from.
 *
 * `answered` is whether prod's reply carried this list at all. It matters more than whether rows arrived: a
 * reply that says the list is flat is knowledge, and painting a cached book over it would invent a position.
 */
export function chooseRows<T>(incoming: readonly T[], answered: boolean, saved: LastKnown<T> | null): Shown<T> {
  if (incoming.length > 0) return { rows: incoming.slice(), source: "prod" };
  if (answered) return { rows: [], source: "none" };
  if (saved && saved.rows.length > 0) return { rows: saved.rows.slice(), source: "last-fetched" };
  return { rows: [], source: "none" };
}

const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/**
 * The age of the saved copy in the words a trader reads, or null when there is nothing usable to say.
 * A cache the screen is about to paint is never labelled with a dash or a bare "Unavailable".
 */
export function lastFetchedLine(at: string | null | undefined, now: Date = new Date()): string | null {
  if (!at) return null;
  const then = new Date(at);
  if (Number.isNaN(then.getTime())) return null;
  if (now.getTime() - then.getTime() > LAST_KNOWN_MAX_AGE_MS) return null;
  const clock = `${String(then.getHours()).padStart(2, "0")}:${String(then.getMinutes()).padStart(2, "0")}`;
  const today = dayKey(now);
  if (dayKey(then) === today) return `Last fetched at ${clock}`;
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (dayKey(then) === dayKey(yesterday)) return `Last fetched yesterday at ${clock}`;
  return `Last fetched on ${String(then.getDate()).padStart(2, "0")}/${String(then.getMonth() + 1).padStart(2, "0")} at ${clock}`;
}

/** Every key this module owns, so the app can forget them together when a session ends without touching
 *  the token or any other stored copy. */
export const LAST_KNOWN_PREFIX = "nraialgo.lastKnown.";

const key = (surface: LastKnownSurface) => `${LAST_KNOWN_PREFIX}${surface}`;

/** The saved book, or null when nothing was ever kept, the copy is unreadable, or it has aged out. */
export async function readLastKnown<T>(storage: StorageAdapter, surface: LastKnownSurface,
  now: number = Date.now()): Promise<LastKnown<T> | null> {
  let raw: string | null = null;
  try {
    raw = await storage.getItem(key(surface));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LastKnown<T> | null;
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    const at = typeof parsed?.at === "string" ? parsed.at : "";
    if (rows.length === 0 || !at) return null;
    const then = new Date(at).getTime();
    if (Number.isNaN(then) || now - then > LAST_KNOWN_MAX_AGE_MS) return null;
    return { at, rows };
  } catch {
    return null;
  }
}

/** Keeps the rows the phone has just been shown. An empty list never overwrites a saved book. */
export function writeLastKnown<T>(storage: StorageAdapter, surface: LastKnownSurface,
  rows: readonly T[], at: string = new Date().toISOString()): Promise<void> {
  if (rows.length === 0) return Promise.resolve();
  return storage.setItem(key(surface), JSON.stringify({ at, rows: rows.slice() } satisfies LastKnown<T>));
}

/** Drops the saved book, because prod has since answered that the list is flat. */
export function clearLastKnown(storage: StorageAdapter, surface: LastKnownSurface): Promise<void> {
  return storage.removeItem(key(surface));
}
