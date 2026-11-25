import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
  LAST_KNOWN,
  LAST_KNOWN_MAX_AGE_MS,
  LAST_KNOWN_PREFIX,
  chooseRows,
  clearLastKnown,
  lastFetchedLine,
  readLastKnown,
  writeLastKnown,
} from "../../packages/shared/src/api/last-known.ts";

/** A storage double that records what the module actually put on the phone. */
const storage = () => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: async (key: string) => map.get(key) ?? null,
    setItem: async (key: string, value: string) => { map.set(key, value); },
    removeItem: async (key: string) => { map.delete(key); },
    clear: async () => { map.clear(); },
  };
};

// Measured on the emulator 2026-11-25: prod's account route answered with rows, yet Positions and Holdings
// rendered a reason and no book, because the frame on /v1/broker-auth/account/stream was written into the
// caches as if it were the REST answer. A screen with nothing to show is the defect this file holds shut.

it("shows prod's rows whenever they arrive, even beside a saved copy", () => {
  const saved = { at: "2026-11-25T04:00:00.000Z", rows: [{ symbol: "STALE" }] };
  expect(chooseRows([{ symbol: "ITC" }], true, saved)).toEqual({ rows: [{ symbol: "ITC" }], source: "prod" });
});

it("shows the last fetched rows when prod never named the list", () => {
  const saved = { at: "2026-11-25T04:00:00.000Z", rows: [{ symbol: "ITC" }, { symbol: "RELIND" }] };
  const shown = chooseRows([], false, saved);
  expect(shown.source).toBe("last-fetched");
  expect(shown.rows.map((row) => row.symbol)).toEqual(["ITC", "RELIND"]);
});

it("trusts an answer that says the list is flat over a remembered book", () => {
  // A closed position must not survive as a ghost the trader can press.
  const saved = { at: "2026-11-25T04:00:00.000Z", rows: [{ symbol: "ITC" }] };
  expect(chooseRows([], true, saved)).toEqual({ rows: [], source: "none" });
});

it("has nothing to show when neither prod nor the phone has a book", () => {
  expect(chooseRows([], false, null)).toEqual({ rows: [], source: "none" });
  expect(chooseRows([], false, { at: "2026-11-25T04:00:00.000Z", rows: [] })).toEqual({ rows: [], source: "none" });
});

it("never lets an empty answer overwrite a saved book", async () => {
  const store = storage();
  await writeLastKnown(store, LAST_KNOWN.positions, [{ symbol: "ITC" }], "2026-11-25T09:35:00.000Z");
  const kept = store.map.get(`${LAST_KNOWN_PREFIX}${LAST_KNOWN.positions}`);
  expect(JSON.parse(kept!).rows).toEqual([{ symbol: "ITC" }]);

  await writeLastKnown(store, LAST_KNOWN.positions, [], "2026-11-25T10:00:00.000Z");
  expect(JSON.parse(store.map.get(`${LAST_KNOWN_PREFIX}${LAST_KNOWN.positions}`)!).at).toBe("2026-11-25T09:35:00.000Z");
});

it("drops the saved copy when prod proves the list is flat", async () => {
  const store = storage();
  await writeLastKnown(store, LAST_KNOWN.holdings, [{ symbol: "ITC" }], "2026-11-25T09:35:00.000Z");
  expect(store.map.size).toBe(1);
  await clearLastKnown(store, LAST_KNOWN.holdings);
  expect(store.map.size).toBe(0);
});

it("refuses to hand back a copy it cannot read, has no rows in, or that has aged out", async () => {
  const store = storage();
  expect(await readLastKnown(store, LAST_KNOWN.positions)).toBeNull();

  store.map.set(`${LAST_KNOWN_PREFIX}${LAST_KNOWN.positions}`, "{not json");
  expect(await readLastKnown(store, LAST_KNOWN.positions)).toBeNull();

  store.map.set(`${LAST_KNOWN_PREFIX}${LAST_KNOWN.positions}`, JSON.stringify({ at: "2026-11-25T09:00:00.000Z", rows: [] }));
  expect(await readLastKnown(store, LAST_KNOWN.positions)).toBeNull();

  const now = Date.parse("2026-11-25T12:00:00.000Z");
  store.map.set(`${LAST_KNOWN_PREFIX}${LAST_KNOWN.positions}`,
    JSON.stringify({ at: new Date(now - LAST_KNOWN_MAX_AGE_MS - 1000).toISOString(), rows: [{ symbol: "ITC" }] }));
  expect(await readLastKnown(store, LAST_KNOWN.positions, now)).toBeNull();

  store.map.set(`${LAST_KNOWN_PREFIX}${LAST_KNOWN.positions}`,
    JSON.stringify({ at: new Date(now - 3 * 60 * 60 * 1000).toISOString(), rows: [{ symbol: "ITC" }] }));
  expect(await readLastKnown(store, LAST_KNOWN.positions, now)).toEqual({
    at: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
    rows: [{ symbol: "ITC" }],
  });
});

// The owner reads one line, so it has to name the minute and never leave a bare "Unavailable" over a
// book the screen is about to paint.
const noon = new Date("2026-11-25T12:00:00");

it("says when a remembered list was fetched, in the words a trader reads", () => {
  expect(lastFetchedLine("2026-11-25T09:35:00", noon)).toBe("Last fetched at 09:35");
  expect(lastFetchedLine("2026-11-24T22:05:00", noon)).toBe("Last fetched yesterday at 22:05");
  expect(lastFetchedLine("2026-11-20T08:00:00", noon)).toBe("Last fetched on 20/11 at 08:00");
});

it("says nothing rather than a wrong thing about a copy it cannot place in time", () => {
  expect(lastFetchedLine(null)).toBeNull();
  expect(lastFetchedLine("", noon)).toBeNull();
  expect(lastFetchedLine("not a date", noon)).toBeNull();
  expect(lastFetchedLine("2026-11-01T09:00:00", noon)).toBeNull();
});

it("names one surface per watchlist so two lists cannot paint each other", () => {
  expect(LAST_KNOWN.watchlist(1)).not.toBe(LAST_KNOWN.watchlist(2));
  expect(LAST_KNOWN.watchlist("builtin-nifty_50")).not.toBe(LAST_KNOWN.watchlist(1));
});

const read = (path: string) => readFileSync(resolve(path), "utf8");

it("keeps a degraded book on screen instead of replacing it with the reason", () => {
  const screen = read("apps/mobile/app/(tabs)/portfolio.tsx");
  expect(screen).toContain("useLastKnown(LAST_KNOWN.positions, prodPositions, answered(positionsState))");
  expect(screen).toContain("useLastKnown(LAST_KNOWN.holdings, prodHoldings, answered(holdingsState))");
  // Degraded carries prod's own last confirmed rows, so it is an answer; cold and unavailable are not.
  expect(screen).toContain('const answered = (state: { kind: string }) => !blocked(state) || state.kind === "degraded";');
  // A remembered book is labelled, and a screen that has one no longer renders a spinner or a failure.
  expect(screen).toContain("{copyLine(positionCopy)}");
  expect(screen).toContain("{copyLine(holdingCopy)}");
  expect(screen).toContain("if (isLoading && !account && savedPositions.length === 0)");
  expect(screen).toContain("if (isError && savedHoldings.length === 0)");
});

it("paints the remembered index cards instead of a blank strip", () => {
  const strip = read("apps/mobile/src/components/IndexStrip.tsx");
  expect(strip).toContain("useLastKnown(LAST_KNOWN.indexStrip, rawStrip?.indices ?? [], !!rawStrip)");
  expect(strip).toContain('if (copy.rows.length === 0) return null;');
  // A remembered card never keeps prod's old "live" word: it says its price is old, and the line below
  // the bar says how old. A tick that arrives still marks the card live again.
  expect(strip).toContain('copy.rows.map((idx) => ({ ...idx, status: "stale" }))');
  expect(strip).toContain('{copy.line ? <Text style={styles.age}>{copy.line}</Text> : null}');
  expect(strip).toContain("return base.map((idx) => {");
});

it("keeps the last fetched watchlist rows and says when they were read", () => {
  const screen = read("apps/mobile/app/(tabs)/watchlist.tsx");
  expect(screen).toContain("const rows = listCopy.rows;");
  expect(screen).toContain("listCopy.line,");
  // The spinner is for a list with nothing to show, so a remembered list renders its rows.
  expect(screen).toContain("&& rows.length === 0;");
  // The rows the phone kept are the rows the stream subscribes to, so a cached list can still tick.
  expect(screen).toContain("const feed = useQuoteFeed(instruments, authenticated && instruments.length > 0)");
  expect(screen).toContain("markWatchlist(rows, feed.quotes)");
});

it("keeps the remembered book after the socket is closed and the app restarted", () => {
  const hook = read("apps/mobile/src/hooks/useLastKnown.ts");
  expect(hook).toContain("readLastKnown<T>(AsyncStorage, surface)");
  expect(hook).toContain("writeLastKnown(AsyncStorage, surface, copy.rows, copy.at)");
  expect(hook).toContain("clearLastKnown(AsyncStorage, surface)");
  expect(hook).toContain("mirror.set(surface, copy as LastKnown<unknown>);");
});

it("forgets every saved list only when the server itself ends the session", () => {
  const hook = read("apps/mobile/src/hooks/useLastKnown.ts");
  expect(hook).toContain("export function forgetLastKnown(): void {");
  expect(hook).toContain("entry.startsWith(LAST_KNOWN_PREFIX)");
  const client = read("apps/mobile/src/utils/apiClient.ts");
  expect(client).toContain("const refused = status === 401 || status === 403;");
  expect(client).toContain("if (refused) forgetLastKnown();");
  // An unreachable prod must not cost the trader their only copy of the book (or the saved user).
  expect(client).toContain("const retained = refused ? false : await hydrateCachedUser();");
});

it("treats the account frame as a change signal and never as the account answer", () => {
  const source = read("packages/shared/src/api/hooks.ts");
  // main's one shared account stream (PR #2) answers every screen that shows the account.
  const stream = source.slice(source.indexOf("const useAccountStream"), source.indexOf("const accountPoll"));
  expect(stream).toContain("/v1/broker-auth/account/stream");
  // Each frame re-reads the account through rereadAccountOnFrame (one GET; PR #4).
  expect(stream).toContain("rereadAccountOnFrame(queryClient)");
  expect(source).toContain("void queryClient.invalidateQueries({ queryKey: read, exact: true });");
  // The frame carries prod's pre-mapped snapshot, whose sections have `data` instead of the `rows` every
  // screen reads, so writing it into the cache is what blanked the book.
  expect(stream).not.toContain("setQueryData");
});

// A manual Logout ends the session as surely as a 401: the next account must not open onto this book.
it("forgets the saved books and prices when the owner logs out", () => {
  const more = readFileSync(resolve(__dirname, "../../apps/mobile/app/(tabs)/more.tsx"), "utf8");
  const logout = more.slice(more.indexOf("logoutStore();"), more.indexOf('router.replace("/login")'));
  expect(logout).toContain("forgetLastKnown();");
});
