import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";

/**
 * Whether this screen is the one on top. Tab screens stay mounted after the first visit, and
 * React Query keeps a mounted query's refetchInterval running even while its tab is hidden
 * (freezeOnBlur stops rendering, not timers). Passing `subscribed: focused` stops a hidden
 * tab's polling; the query refreshes once when the tab comes back (25 Nov 2026: every tab the
 * owner had opened kept polling the server at the same time).
 */
export function useScreenFocused(): boolean {
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  return focused;
}
