/**
 * The copy of a list this phone already painted, kept for the minutes prod does not answer with one.
 *
 * Prod's own saved snapshot is always first: a degraded account section still carries the broker's last
 * confirmed rows, and those come back as ordinary data. What this hook adds is the case where prod cannot
 * serve at all — no network, a refused read, a 502 — where the honest answer to "where is my book?" is the
 * book as this phone last saw it, with the minute it saw it, instead of a blank screen.
 *
 * The rule, held by tests/contracts/mobile-last-known.test.ts: an answer always beats a cache. Rows that
 * arrived are written through; a reply that says the list is flat clears the copy, so a closed position
 * can never come back as a ghost.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  chooseRows,
  clearLastKnown,
  lastFetchedLine,
  LAST_KNOWN_PREFIX,
  readLastKnown,
  writeLastKnown,
  type LastKnown,
  type LastKnownSurface,
  type RowSource,
} from "@nraialgo/shared/api";

/** What was painted last, held in memory too so re-opening a screen in the same session shows the list on
 *  its first render instead of one async read later. `undefined` means this session has not looked yet. */
const mirror = new Map<LastKnownSurface, LastKnown<unknown> | null>();

export interface LastKnownView<T> {
  /** The rows to render: prod's if it sent any, otherwise the copy this phone last saw. */
  rows: T[];
  source: RowSource;
  /** "Last fetched at 10:42" while a saved copy is on screen, null while prod's own rows are. */
  line: string | null;
}

export function useLastKnown<T>(surface: LastKnownSurface, incoming: readonly T[], answered: boolean): LastKnownView<T> {
  const [saved, setSaved] = useState<LastKnown<T> | null>(
    () => (mirror.get(surface) ?? null) as LastKnown<T> | null,
  );
  // Screens rebuild their row array on every render, so the array's identity, not its length, is what
  // marks a list this hook has not saved yet.
  const seen = useRef<{ surface: LastKnownSurface; rows: readonly T[]; answered: boolean } | null>(null);

  // The copy for this surface, from memory when this session has painted it and from disk when it has not.
  useEffect(() => {
    if (mirror.has(surface)) {
      setSaved((mirror.get(surface) ?? null) as LastKnown<T> | null);
      return;
    }
    let live = true;
    readLastKnown<T>(AsyncStorage, surface).then((copy) => {
      mirror.set(surface, copy as LastKnown<unknown> | null);
      if (live && copy) setSaved(copy);
    });
    return () => { live = false; };
  }, [surface]);

  useEffect(() => {
    const prior = seen.current;
    if (prior && prior.surface === surface && prior.rows === incoming && prior.answered === answered) return;
    seen.current = { surface, rows: incoming, answered };
    if (incoming.length > 0) {
      const copy = { at: new Date().toISOString(), rows: incoming.slice() } as LastKnown<T>;
      setSaved(copy);
      mirror.set(surface, copy as LastKnown<unknown>);
      writeLastKnown(AsyncStorage, surface, copy.rows, copy.at).catch(() => {});
    } else if (answered && mirror.get(surface)) {
      setSaved(null);
      mirror.set(surface, null);
      clearLastKnown(AsyncStorage, surface).catch(() => {});
    }
  }, [surface, incoming, answered]);

  const shown = useMemo(() => chooseRows(incoming, answered, saved), [incoming, answered, saved]);
  return useMemo(() => ({
    rows: shown.rows,
    source: shown.source,
    line: shown.source === "last-fetched" ? lastFetchedLine(saved?.at) : null,
  }), [shown, saved]);
}

/**
 * Forget every saved list, because the session that produced them has ended.
 *
 * A remembered book belongs to one workspace: left on the phone, the next sign-in would open onto another
 * trader's positions before prod had answered once. Only these keys go, so the token and every other cache
 * a screen owns stay where they are.
 */
export function forgetLastKnown(): void {
  mirror.clear();
  AsyncStorage.getAllKeys().then((keys) => {
    const owned = keys.filter((entry) => entry.startsWith(LAST_KNOWN_PREFIX));
    if (owned.length > 0) AsyncStorage.multiRemove(owned).catch(() => {});
  }).catch(() => {});
}
