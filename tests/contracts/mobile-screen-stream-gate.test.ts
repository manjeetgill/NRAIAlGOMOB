import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PR #2 review follow-up. A screen may slow its REST read only when the socket is feeding THAT screen,
 * a closed F&O market must not re-read the chain every 5 s, and a hidden tab must not lose its cached
 * book to the default 5-minute garbage collection.
 */
const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const socket = read("packages/shared/src/api/websocket.ts");
const hooks = read("packages/shared/src/api/hooks.ts");

describe("polls gate on the screen's own feed", () => {
  it("asks about the screen's ids, not the app-wide flag", () => {
    expect(socket).toContain("export function quoteStreamCarries(ids: readonly string[] | null | undefined): boolean");
    expect(socket).toContain("if (!ids || ids.length === 0 || !quoteStreamConnected()) return false;");
    expect(socket).toContain("lastFreshById.set(id, lastFreshTickAt);");
    // No query polls on the app-global flag any more.
    expect(hooks).not.toContain("quoteStreamConnected()");
    expect(hooks.match(/quoteStreamCarries\(streamed\?\.\(\)\)/g)).toHaveLength(5);
  });

  it("each streaming screen hands over its own ids, and null when a row cannot stream", () => {
    const watchlist = read("apps/mobile/app/(tabs)/watchlist.tsx");
    expect(watchlist).toContain("streamedRows.current = rowIds.every((id) => !!id) ? instruments : null;");
    const desk = read("apps/mobile/src/components/BasketDesk.tsx");
    expect(desk).toContain("useBaskets(undefined, undefined, () => streamedLegs.current)");
    expect(desk).toContain('leg.instrumentId.startsWith("instrument:v1:")))');
    const chain = read("apps/mobile/app/(tabs)/option-chain.tsx");
    expect(chain).toContain("    streamedStrikes.current = ids;");
    const strip = read("apps/mobile/src/components/IndexStrip.tsx");
    expect(strip).toContain("useIndices(undefined, () => streamedIndices.current)");
  });
});

describe("hidden tabs keep their cached data", () => {
  it("overrides the 5-minute gcTime on every tab that unsubscribes when hidden", () => {
    for (const p of ["apps/mobile/app/(tabs)/watchlist.tsx", "apps/mobile/app/(tabs)/orders.tsx", "apps/mobile/app/(tabs)/portfolio.tsx", "apps/mobile/app/(tabs)/option-chain.tsx"]) {
      const screen = read(p);
      const unsubscribing = screen.match(/subscribed: focused/g)?.length ?? 0;
      const kept = screen.match(/gcTime: (Infinity|30 \* 60 \* 1000)/g)?.length ?? 0;
      expect(unsubscribing, p).toBeGreaterThan(0);
      expect(kept, p).toBe(unsubscribing);
    }
  });
});
