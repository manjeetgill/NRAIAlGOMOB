import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

/**
 * The scanner left the bottom bar but its entry stayed under More, and the press kept opening the
 * Positions book instead. A screen that no tab declares is not a route the router can resolve: the group
 * answers with its own first screen, so a file left inside `(tabs)` is unreachable while being invisible.
 * These cases keep the scanner a plain pushed screen, the way every other Advanced row is reached.
 */

const more = readFileSync(resolve("apps/mobile/app/(tabs)/more.tsx"), "utf8");
const layout = readFileSync(resolve("apps/mobile/app/(tabs)/_layout.tsx"), "utf8");
const screen = readFileSync(resolve("apps/mobile/app/scanner.tsx"), "utf8");

it("opens the scanner as its own screen rather than a tab the bar never declares", () => {
  expect(existsSync(resolve("apps/mobile/app/scanner.tsx"))).toBe(true);
  expect(existsSync(resolve("apps/mobile/app/(tabs)/scanner.tsx"))).toBe(false);
  expect(more).toContain('router.push("/scanner")');
});

it("keeps the scanner off the bottom bar", () => {
  expect(layout).not.toContain("scanner");
});

it("warms the events the scanner lists, not the automations it never reads", () => {
  const prefetch = readFileSync(resolve("apps/mobile/src/utils/prefetch.ts"), "utf8");
  const hooks = readFileSync(resolve("packages/shared/src/api/hooks.ts"), "utf8");
  const at = prefetch.indexOf("export function prefetchScanner");
  expect(at).toBeGreaterThan(-1);
  const body = prefetch.slice(at, prefetch.indexOf("\n}", at));
  expect(body).toContain("queryKey: queryKeys.scanner.technicalEvents()");
  expect(body).toContain('client.get<TechnicalEventsResponse>("/v1/technical-events")');
  expect(hooks).toContain("queryKey: queryKeys.scanner.technicalEvents(),");
});

/**
 * `/v1/technical-events` files each rule match inside the instrument's saved result as
 * `result.events[].{kind,timestamp,close}` and never repeats the kind on the row itself. The screen used to
 * read `item.signal_type`, which the server has never sent, so the first card threw and the trader was left
 * on whatever screen was underneath.
 */
it("draws the kind from the event the server actually returns", () => {
  expect(screen).toContain("item.result?.events ?? []");
  expect(screen).toContain("kind: event.kind");
  expect(screen).toContain("close: typeof event.close === \"number\" && Number.isFinite(event.close) ? event.close : null");
  expect(screen).not.toContain("signal_type");
  expect(screen).not.toContain("result?.support");
  expect(screen).not.toContain("result?.resistance");
  /** The candle arrives as epoch milliseconds, so the raw number is never what the trader reads. */
  expect(screen).toContain("candleTime(signal.at)");
  expect(screen).not.toContain("{signal.at}");
});

it("provides stock universe selection (portfolio, fo, cash, large cap, midcap, small cap)", () => {
  expect(screen).toContain('id: "portfolio", label: "Portfolio"');
  expect(screen).toContain('id: "fo", label: "F&O"');
  expect(screen).toContain('id: "cash", label: "Cash"');
  expect(screen).toContain('id: "large_cap", label: "Large Cap"');
  expect(screen).toContain('id: "midcap", label: "Midcap"');
  expect(screen).toContain('id: "small_cap", label: "Small Cap"');
  expect(screen).toContain("universe === \"portfolio\"");
  expect(screen).toContain("styles.universeBar");
  expect(screen).toContain("styles.universeChip");
});

it("resolves universe names and ICICI codes unpriced without polling watchlists", () => {
  // Index membership is read once from the built-in lists and never polled
  expect(screen.match(/useBuiltinWatchlist\("/g)?.length).toBe(2);
  expect(screen.match(/refetchInterval: false, staleTime: 12 \* 60 \* 60 \* 1000/g)?.length).toBe(2);
  expect(screen).toContain("page.instruments");
  expect(screen).not.toContain("MIDCAP_SET");
  // Reads derivatives master unpriced once
  expect(screen).toContain("useChainUnderlyings");
  // Maps broker/ICICI contract codes (e.g. RELIND -> RELIANCE)
  expect(screen).toContain("useContractUnderlyings");
});
