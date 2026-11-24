import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

/**
 * A speculative prefetch fills the cache the screen is about to read, so it is only a speed-up while it
 * writes the same shape the screen's own hook writes. Prod answers `/v1/broker-auth/icici/account` and
 * `/v1/orders` with an envelope that the hooks unpack into rows; caching the envelope under the rows' key
 * hands the screen an object where it expects an array, and the Portfolio table dies on its first
 * `.filter` instead of showing a book. These cases keep the two reads in step.
 */

const prefetch = readFileSync(resolve("apps/mobile/src/utils/prefetch.ts"), "utf8");
const hooks = readFileSync(resolve("packages/shared/src/api/hooks.ts"), "utf8");

/** The one read sitting under a prefetched key, up to the freshness the screen will inherit. */
const readFor = (key: string) => {
  const at = prefetch.indexOf(`queryKey: ${key},`);
  expect(at, `prefetch.ts has no read for ${key}`).toBeGreaterThan(-1);
  return prefetch.slice(at, prefetch.indexOf("staleTime", at));
};

it("warms the positions the Portfolio renders, not the account body it unpacks", () => {
  const account = 'iciciOpenPositions(await client.get<IciciAccountPayload>("/v1/broker-auth/icici/account"))';
  expect(hooks).toContain(account);
  expect(readFor("queryKeys.positions.open()")).toContain(account);
});

it("unwraps the order envelopes the same way the hooks do", () => {
  expect(hooks).toContain("return response.gtts;");
  expect(readFor("queryKeys.orders.gtt()")).toContain('("/v1/orders/gtt")).gtts');
  expect(hooks).toContain("return response.intents;");
  expect(readFor("queryKeys.orders.intents()")).toContain('("/v1/orders")).intents');
});

it("never caches a bare envelope under a key whose rows are read as a list", () => {
  expect(prefetch).not.toMatch(/queryFn: \(\) => client\.get\("\/v1\/(broker-auth\/icici\/account|orders\/gtt|orders)"\)/);
});
