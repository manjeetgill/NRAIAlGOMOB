/**
 * Memory Budget Monitor (Dev Mode Only)
 *
 * Warns when JS heap usage exceeds a safe threshold during development.
 * Production builds skip this entirely — the check is gated on __DEV__.
 */

import { Alert } from "react-native";

const MEMORY_BUDGET_MB = 200;
const CHECK_INTERVAL_MS = 30_000;

const getMemoryUsageMB = (): number => {
  if (__DEV__ && typeof performance !== "undefined" && "memory" in performance) {
    // @ts-ignore — performance.memory is Chrome/Hermes dev-only
    const mem = performance.memory as { usedJSHeapSize?: number };
    if (mem.usedJSHeapSize) {
      return Math.round(mem.usedJSHeapSize / 1024 / 1024);
    }
  }
  return 0;
};

let monitorStarted = false;

export function startMemoryMonitor(): void {
  if (!__DEV__ || monitorStarted) return;
  monitorStarted = true;

  setInterval(() => {
    const mb = getMemoryUsageMB();
    if (mb > MEMORY_BUDGET_MB) {
      console.warn(`[Memory] Usage ${mb} MB exceeds budget ${MEMORY_BUDGET_MB} MB`);
      Alert.alert(
        "Memory Warning",
        `App is using ${mb} MB of memory (budget: ${MEMORY_BUDGET_MB} MB). Consider restarting the app.`,
        [{ text: "OK" }]
      );
    }
  }, CHECK_INTERVAL_MS);
}
