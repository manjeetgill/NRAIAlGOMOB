/**
 * useApi Hook - Safe API hook accessor
 * 
 * This ensures getApi() is called inside a component, not at module level,
 * preventing "API not initialized" errors during module load.
 */

import { getApi } from "@nraialgo/shared/api";

/**
 * Returns the API hooks object from the shared package.
 * Must be called inside a React component (not at module level).
 */
export function useApi() {
  return getApi();
}

/**
 * Type-safe hook for specific API sections.
 * Usage: const { useOptionChain, useChainUnderlyings } = useApi();
 */
export function useApiHooks() {
  return getApi();
}