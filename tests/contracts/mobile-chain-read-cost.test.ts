import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { chainRequest, queryKeys, todayIST } from "../../packages/shared/src/api/hooks.ts";

/**
 * A chain read is the heaviest thing this app asks the broker for: the server selects the strikes and then
 * pulls every contract in the band, which is measured in seconds apiece in prod. Two things follow, and both
 * live in how the cache entry is named rather than in any one screen.
 *
 * The warm-up on a tab press has to land on the entry the desk is about to read, which means the underlying
 * and the expiry it guesses must be the ones the desk remembers — and the all-expiries ladder must not be
 * re-paid for every time an alert brings the app back to the front.
 */

const root = resolve(__dirname, "../..");
const hooks = readFileSync(resolve(root, "packages/shared/src/api/hooks.ts"), "utf8");
const index = readFileSync(resolve(root, "packages/shared/src/api/index.ts"), "utf8");
const prefetch = readFileSync(resolve(root, "apps/mobile/src/utils/prefetch.ts"), "utf8");
const memory = readFileSync(resolve(root, "apps/mobile/src/utils/chainSelection.ts"), "utf8");
const screen = readFileSync(resolve(root, "apps/mobile/app/(tabs)/option-chain.tsx"), "utf8");

describe("one helper builds the chain read", () => {
  it("sends a live ISO expiry and drops one that has settled", () => {
    const live = String(Number(todayIST().slice(0, 4)) + 2) + todayIST().slice(4);
    expect(chainRequest("NIFTY", live).asked).toBe(live);
    expect(chainRequest("NIFTY", live).params).toMatchObject({ expiry: live });
    // The server rejects the whole read for a settled date, and the broker has no ladder left to answer it
    // with, so an empty expiry — "the nearest one you have" — is the only honest ask.
    expect(chainRequest("NIFTY", "2020-01-03")).toEqual({
      asked: "",
      queryKey: ["option-chain", "chain", "NIFTY", "auto", 30],
      params: { underlying: "NIFTY", window: 30, rate: 0, dividend: 0 },
    });
    expect(chainRequest("NIFTY", "front").asked).toBe("");
  });

  it("caches under a key that carries the window it asked for", () => {
    const { queryKey } = chainRequest("BANKNIFTY", "");
    expect(queryKey).toEqual(queryKeys.optionChain.chain("BANKNIFTY", "", 30));
    // A full-ladder entry is not the same contract read as a 30-strike one, so it must not be filed beside it.
    expect(queryKeys.optionChain.chain("BANKNIFTY", "", 400)).not.toEqual(queryKey);
  });

  it("is the only place the desk's read is spelled", () => {
    expect(index).toContain("chainRequest,");
    expect(hooks).toContain("const { asked, queryKey, params } = chainRequest(underlying, expiry);");
    expect(prefetch).toContain("const request = chainRequest(underlying, expiry);");
    // A key built by hand beside the helper is a key that drifts from it, which is what made the warm-up
    // spend a broker read on a contract the desk never opened.
    expect(prefetch).not.toMatch(/queryKeys\.optionChain\.chain\(/);
    expect(hooks).not.toContain("chain(underlying, asked, 30)");
  });
});

describe("the warm-up reads the contract the desk opens on", () => {
  it("takes the remembered contract rather than a hardcoded index", () => {
    expect(prefetch).toContain("readChainSelection()");
    expect(prefetch).toContain("useTradingStore.getState().optionChain");
    expect(prefetch).not.toContain('"NIFTY"');
  });

  it("keeps the device memory in one module the screen and the warm-up both read", () => {
    expect(memory).toContain('export const CHAIN_SELECTION_KEY = "nraialgo.chain-selection"');
    expect(screen).toContain('import { readChainSelection, rememberChainSelection } from "@/utils/chainSelection"');
    // Two parsers over one key is how a warm-up ends up asking for a date the desk will not open.
    expect(screen).not.toContain("nraialgo.chain-selection");
    expect(memory).toMatch(/expiry < todayIST\(\)\) return null/);
  });
});

describe("the all-expiries ladder stops re-paying for the same read", () => {
  /** The ladder's own options, between its declaration and the next hook. */
  const ladder = hooks.slice(hooks.indexOf("const useOptionChains"), hooks.indexOf("const useChainUnderlyings"));
  const single = hooks.slice(hooks.indexOf("const useOptionChain ="), hooks.indexOf("const useOptionChains"));

  it("holds a ladder read for five minutes and declines the app-wide refetches", () => {
    expect(hooks).toMatch(/const LADDER_STALE_MS = 5 \* 60 \* 1000;/);
    expect(ladder).toContain("staleTime: LADDER_STALE_MS");
    expect(ladder).toContain("refetchOnWindowFocus: false");
    expect(ladder).toContain("refetchOnReconnect: false");
    expect(ladder).toContain("window: FULL_WINDOW");
  });

  it("leaves the expiry on screen polling on its own", () => {
    // The desk the trader is looking at stays live; only the dates above and below it go quiet, so the cost
    // of the switch is a read age per section, not a stale price with nothing saying so.
    // 5 s without the price socket; 30 s only on the chain tab, whose visible strikes tick from the socket.
    expect(single).toContain("if (state.data.marketOpen === false) return CLOSED_CHAIN_POLL_MS;");
    expect(single).toContain("return quoteStreamCarries(streamed?.()) ? 30 * 1000 : 5 * 1000;");
    expect(ladder).not.toContain("refetchInterval");
  });

  it("no longer claims the ladder shares the single-expiry key", () => {
    expect(hooks).not.toContain("each cached under the same key a single-expiry read uses");
  });
});
