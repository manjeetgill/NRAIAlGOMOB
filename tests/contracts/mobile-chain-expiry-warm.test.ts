import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHAIN_WARM_LIMIT, chainRequest, chainWarmTargets, todayIST } from "../../packages/shared/src/api/hooks.ts";

/**
 * Switching an expiry is the slowest thing this desk does: one ladder read is measured at 4.4 s average and
 * 7.3 s worst in prod, and the picker is the only way to reach another date. Two things make the tap feel
 * instant, and both have to stay true to the read the screen itself performs.
 *
 * The dates behind the picker warm a few at a time on the lane that also places orders, and the frame the
 * server paints while a cold read finishes says its own age instead of looking live beside a live dot.
 */

const root = resolve(__dirname, "../..");
const hooks = readFileSync(resolve(root, "packages/shared/src/api/hooks.ts"), "utf8");
const index = readFileSync(resolve(root, "packages/shared/src/api/index.ts"), "utf8");
const prefetch = readFileSync(resolve(root, "apps/mobile/src/utils/prefetch.ts"), "utf8");
const screen = readFileSync(resolve(root, "apps/mobile/app/(tabs)/option-chain.tsx"), "utf8");

/** Dates a live ladder would be listed for: the front weekly and the month-end behind it. */
function ladder(offsets: number[]): string[] {
  const today = new Date(`${todayIST()}T00:00:00Z`);
  return offsets.map(days => {
    const at = new Date(today);
    at.setUTCDate(at.getUTCDate() + 7 * days);
    return at.toISOString().slice(0, 10);
  });
}

describe("the dates behind the picker are chosen before any read is asked for", () => {
  it("warms the listed dates a tap would land on, nearest first", () => {
    const [front, next, third, last] = ladder([0, 1, 2, 3]);
    expect(chainWarmTargets("NIFTY", [front, next, third, last], front)).toEqual(
      [next, third, last].map(expiry => chainRequest("NIFTY", expiry)),
    );
  });

  it("skips the ladder already on the screen", () => {
    const [front, next] = ladder([0, 1]);
    // Reading the date on screen twice is the cost of the warm-up with none of its benefit: the desk has
    // that entry cached or in flight already.
    expect(chainWarmTargets("NIFTY", [front, next], front)).toEqual([chainRequest("NIFTY", next)]);
    expect(chainWarmTargets("NIFTY", [front], front)).toEqual([]);
  });

  it("stops at the few dates a trader taps and never asks for the whole ladder", () => {
    const days = ladder([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const warm = chainWarmTargets("NIFTY", days, days[0]);
    expect(warm).toHaveLength(CHAIN_WARM_LIMIT);
    expect(warm[0].params).toMatchObject({ expiry: days[1], window: 30 });
  });

  it("drops a settled or malformed date instead of warming the front expiry twice", () => {
    // `chainRequest` turns a settled date into "whatever your nearest one is", which is the read already on
    // screen — so a queue that kept it would pay for the same ladder twice and buy nothing ahead.
    const [next] = ladder([1]);
    expect(chainWarmTargets("NIFTY", ["2001-01-01", "front", "", next], next)).toEqual([]);
  });

  it("builds every warmed read with the desk's own key", () => {
    const [front, next] = ladder([0, 1]);
    expect(chainWarmTargets("NIFTY", [front, next], front)[0].queryKey).toEqual(chainRequest("NIFTY", next).queryKey);
    expect(index).toContain("chainWarmTargets,");
  });
});

describe("the warm-up spends the broker lane the way the desk needs it", () => {
  /** The body of the runner, between its declaration and the next export. */
  const runner = prefetch.slice(prefetch.indexOf("export function prefetchChainExpiries"), prefetch.indexOf("export function prefetchPortfolio"));

  it("asks one date at a time, so three taps never open three ladders at once", () => {
    expect(runner).toContain("for (const request of targets) {");
    expect(runner).toContain("await queryClient.prefetchQuery(");
    expect(runner).not.toContain("Promise.all");
  });

  it("writes the same key and params the hook reads", () => {
    expect(runner).toContain("queryKey: request.queryKey");
    expect(runner).toContain('client.get<OptionChainData>("/v1/option-chain", { params: request.params })');
    // A hand-built key beside the helper is a key that drifts from it, which is what made a warm-up read a
    // contract the desk then asked for again.
    expect(runner).not.toMatch(/queryKeys\.optionChain\.chain\(/);
  });

  it("leaves a date the desk can already answer and abandons a picker the trader closed", () => {
    expect(runner).toContain("queryClient.getQueryState(request.queryKey)");
    expect(runner).toContain("Date.now() - state.dataUpdatedAt < CHAIN_WARM_FRESH_MS");
    expect(runner).toContain("const run = ++chainWarmRun;");
    expect(runner).toContain("if (run !== chainWarmRun) return;");
  });

  it("stops at the first refusal instead of retrying a lane that is saying no", () => {
    expect(runner).toMatch(/catch \{\s*return;/);
    expect(runner).not.toContain(".catch(() => {})");
  });
});

describe("a painted frame says so", () => {
  it("keeps the server's own markers on the chain payload", () => {
    const payload = hooks.slice(hooks.indexOf("export interface OptionChainData"), hooks.indexOf("export interface SpotQuote"));
    expect(payload).toContain("displaySnapshot?: boolean;");
    expect(payload).toContain("refreshing?: boolean;");
  });

  it("prints the age of the frame the server kept, and whether a read is still coming", () => {
    expect(screen).toContain("chain.displaySnapshot && chain.marketOpen ?");
    expect(screen).toContain("frameAge(chain)");
    expect(screen).toContain('"live chain still loading"');
    expect(screen).toContain('"the live read is not answering"');
    // The age comes from the frame's own observation time, not from a made-up word.
    expect(screen).toMatch(/const at = Date\.parse\(chain\.spot\?\.at \?\? chain\.asOf \?\? ""\);/);
    expect(screen).toContain("return Number.isFinite(at) ? readAge(at)");
  });

  it("starts the warm-up on the way into the picker, not on every date the trader passes", () => {
    expect(screen).toContain('import { prefetchChainExpiries } from "@/utils/prefetch"');
    // One call site, inside the press that opens the list, ahead of the state change that shows it. Held out
    // of a render-path effect on purpose: the chain object is replaced on every poll, and a warm per paint
    // would be a ladder read per poll on the order lane.
    const call = screen.indexOf("prefetchChainExpiries(underlying");
    expect(call).toBeGreaterThan(0);
    expect(screen.split("prefetchChainExpiries").length - 1).toBe(2);
    expect(screen.slice(call, call + 80)).toContain("chain.expiries");
    expect(screen.slice(call, call + 80)).toContain("chain.expiry");
    expect(screen.indexOf("setExpiryOpen(open => !open)", call)).toBeGreaterThan(call);
  });
});
