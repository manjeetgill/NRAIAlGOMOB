import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A hidden tab passes `subscribed: false`, which detaches its observer and lets TanStack collect the query
 * after its gcTime (5 min by default). A tab left hidden longer would come back to a loader instead of its
 * last-known rows, so every tab query that unsubscribes while hidden keeps its data for the session.
 */
const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("hidden tabs keep their last-known data", () => {
  for (const path of ["apps/mobile/app/(tabs)/watchlist.tsx", "apps/mobile/app/(tabs)/option-chain.tsx",
    "apps/mobile/app/(tabs)/portfolio.tsx", "apps/mobile/app/(tabs)/orders.tsx"]) {
    it(path, () => {
      const source = read(path);
      const subscribed = source.match(/subscribed: focused[^}\n]*/g) ?? [];
      expect(subscribed.length).toBeGreaterThan(0);
      for (const use of subscribed) expect(use).toContain("gcTime: Infinity");
    });
  }

  it("gates every stream-slowed poll on the screen's own ids, not the app-global flag", () => {
    const hooks = read("packages/shared/src/api/hooks.ts");
    expect(hooks).not.toContain("quoteStreamConnected(");
    for (const gate of ["quoteStreamCarrying(basketStreamIds(", "quoteStreamCarrying(watchlistStreamIds(",
      "quoteStreamCarrying(chainStreamIds(", "quoteStreamCarrying(indexStreamIds("]) expect(hooks).toContain(gate);
  });
});
