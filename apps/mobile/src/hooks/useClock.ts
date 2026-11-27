/**
 * A clock for screens whose copy is measured against the current time.
 *
 * A broker session runs out while the trader is still looking at the screen, and a countdown that only moves
 * on a network read would keep promising "Connected" for as long as the cache stays fresh. This ticks the
 * render only - it fetches nothing.
 */

import { useEffect, useState } from "react";

export function useClock(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
