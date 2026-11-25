/**
 * The contract the chain desk last showed, in one place.
 *
 * Both the screen and the prefetch need the same answer. The screen resumes on it so a launch costs one
 * broker read instead of a guessed one, and the prefetch has to warm the exact cache entry that read will
 * ask for — the key is built from the underlying and the expiry, so a memory the two derive differently is
 * a read spent on a contract nobody opened and a desk that still starts cold.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { todayIST } from "@nraialgo/shared/api";

export const CHAIN_SELECTION_KEY = "nraialgo.chain-selection";

export interface ChainSelection {
  underlying: string;
  expiry: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date that has already settled is dropped rather than resumed: the broker has no ladder left to answer it
 * with, and the desk's own read refuses it, so remembering it only guarantees the first failure.
 */
export function parseChainSelection(raw: string | null): ChainSelection | null {
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as { underlying?: unknown; expiry?: unknown };
    const underlying = typeof saved.underlying === "string" ? saved.underlying : "";
    const expiry = typeof saved.expiry === "string" ? saved.expiry : "";
    if (!underlying || !ISO_DATE.test(expiry) || expiry < todayIST()) return null;
    return { underlying, expiry };
  } catch {
    return null;
  }
}

/** What the desk will ask for when it next opens, or nothing when the device has no usable memory. */
export function readChainSelection(): Promise<ChainSelection | null> {
  return AsyncStorage.getItem(CHAIN_SELECTION_KEY)
    .then(parseChainSelection)
    .catch(() => null);
}

/** Written from the chain that arrived, not from the ask, so a date the server corrected is never
 *  remembered as the one that was wanted. */
export function rememberChainSelection(selection: ChainSelection): void {
  AsyncStorage.setItem(CHAIN_SELECTION_KEY, JSON.stringify(selection)).catch(() => {});
}
