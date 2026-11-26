import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
  cashEntries,
  legEntries,
  paintWatchlist,
  paintable,
  QUOTE_MEMORY_CASH_MAX_AGE_MS,
  QUOTE_MEMORY_KEY,
  QUOTE_MEMORY_MAX,
  readQuoteMemory,
  rememberedSide,
  rememberQuotes,
  sameIstDay,
  seenLine,
  tickEntries,
  writeQuoteMemory,
  type QuoteMemory,
  type RememberedQuote,
} from "../../packages/shared/src/api/quote-memory.ts";
import { LAST_KNOWN_PREFIX } from "../../packages/shared/src/api/last-known.ts";

// Measured on the emulator 2026-11-25: prod answered /v1/watchlist/builtin/nifty_50 with 13 rows and 13 null
// prices, and the ladder priced only the strikes the exchange quoted that second. The phone had seen both
// symbols priced minutes earlier — on the strip, in the book, or on a tick that has since stopped. An empty
// cell beside a number this app already holds is the defect this file holds shut, and the minute printed
// beside the filled-in number is what keeps the fix honest.

const ITC = "instrument:v1:NSE:EQ:ITC:CASH";
const STRIP = "instrument:v1:NSE:INDEX:NIFTY 50:INDEX";
const CE = "instrument:v1:NSE:FO:NIFTY:OPT:2026-11-25:25000:CE";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A fixed instant to measure ages against: 14:30 IST on 25 Nov 2026, mid-session. */
const now = Date.parse("2026-11-25T09:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

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

/** The lookup the screens get from useQuoteMemory().seen, rebuilt here so the age rule is the thing under test. */
const look = (memory: QuoteMemory, at: number = now) => (id: string | null): RememberedQuote | null => {
  if (!id) return null;
  const entry = memory[id];
  return entry && paintable(id, entry, at) ? entry : null;
};

/** A price from `mins` ago on the phone's own clock, for the tests that assert the words a label prints. */
const seenAgo = (mins: number) => new Date(Date.now() - mins * MINUTE).toISOString();

const row = (over: Record<string, unknown> = {}) => ({
  exchange: "NSE", symbol: "ITC", name: "ITC Ltd", ltp: null, close: null, change: null, changePct: null, ...over,
});

// ---------------------------------------------------------------- gap filling

it("leaves a price prod or the stream sent exactly where it was", () => {
  const memory: QuoteMemory = { [ITC]: { price: 100, close: 99, at: seenAgo(1) } };
  const priced = paintWatchlist([row({ ltp: 412.5, close: 410, change: 2.5, changePct: 0.61 })], look(memory, Date.now()));
  expect(priced[0]).toMatchObject({ ltp: 412.5, change: 2.5, changePct: 0.61, seen: null });
});

it("paints a remembered price onto a row prod left unpriced, and says it was seen", () => {
  const memory: QuoteMemory = { [ITC]: { price: 411.2, close: 410, at: seenAgo(20) } };
  const [filled] = paintWatchlist([row()], look(memory, Date.now()));
  expect(filled.ltp).toBe(411.2);
  expect(filled.close).toBe(410);
  expect(filled.change).toBe(1.2);
  expect(filled.changePct).toBe(0.29);
  expect(filled.seen).toMatch(/^seen \d{2}:\d{2}$/);
});

it("measures a remembered row against the close it was seen with, not the one beside it now", () => {
  const memory: QuoteMemory = { [ITC]: { price: 411.2, close: 400, at: seenAgo(60) } };
  const [filled] = paintWatchlist([row({ close: 410 })], look(memory, Date.now()));
  expect(filled.close).toBe(400);
  expect(filled.change).toBe(11.2);
});

it("prints a remembered price with no close rather than inventing a day's move", () => {
  const memory: QuoteMemory = { [ITC]: { price: 411.2, close: null, at: seenAgo(1) } };
  const [filled] = paintWatchlist([row()], look(memory, Date.now()));
  expect(filled).toMatchObject({ ltp: 411.2, change: null, changePct: null });
  expect(filled.seen).toMatch(/^seen /);
});

it("leaves the cell empty when neither prod, the stream nor the phone has a price", () => {
  const [empty] = paintWatchlist([row()], look({}));
  expect(empty).toMatchObject({ ltp: null, seen: null });
});

it("never marks a remembered row live", () => {
  // `live` is the flag a row is drawn in the stream's colour by; a remembered number is not a tick.
  const memory: QuoteMemory = { [ITC]: { price: 411.2, close: 410, at: seenAgo(1) } };
  const marked = paintWatchlist([{ ...row(), live: false }], look(memory, Date.now()));
  expect(marked[0].live).toBe(false);
});

it("will not paint a premium the phone saw on an earlier trading day", () => {
  // 24 Nov 18:00 UTC is 23:30 IST: yesterday's 25000 CE is not this strike's price today.
  const memory: QuoteMemory = { [CE]: { price: 120.5, close: null, at: iso(now - 15 * HOUR) } };
  const side = rememberedSide(look(memory)(CE));
  expect(side).toBeNull();
});

// ---------------------------------------------------------------- the age rule

it("keeps a cash price for days and a premium only for its own trading day", () => {
  expect(paintable(ITC, { price: 411, close: null, at: iso(now - 2 * DAY) }, now)).toBe(true);
  expect(paintable(STRIP, { price: 24100, close: null, at: iso(now - 2 * DAY) }, now)).toBe(true);
  expect(paintable(CE, { price: 120.5, close: null, at: iso(now - 2 * HOUR) }, now)).toBe(true);
  expect(paintable(ITC, { price: 411, close: null, at: iso(now - QUOTE_MEMORY_CASH_MAX_AGE_MS - MINUTE) }, now)).toBe(false);
  expect(paintable(CE, { price: 120.5, close: null, at: iso(now - 15 * HOUR) }, now)).toBe(false);
});

it("ends a remembered premium at midnight IST, not at the phone's midnight", () => {
  // 24 Nov 18:30 UTC is 25 Nov 00:00 IST — the exchange's own next session, so the premium still stands.
  expect(sameIstDay(Date.parse("2026-11-24T18:30:00.000Z"), now)).toBe(true);
  expect(sameIstDay(Date.parse("2026-11-24T18:29:00.000Z"), now)).toBe(false);
  expect(paintable(CE, { price: 120.5, close: null, at: "2026-11-24T18:30:00.000Z" }, now)).toBe(true);
});

it("refuses a price with no time on it, one from the future, and any id it does not publish", () => {
  expect(paintable(ITC, { price: 411, close: null, at: "" }, now)).toBe(false);
  expect(paintable(ITC, { price: 411, close: null, at: "not a date" }, now)).toBe(false);
  expect(paintable(ITC, { price: 411, close: null, at: iso(now + MINUTE) }, now)).toBe(false);
  expect(paintable("instrument:v1:NSE:FX:ITC:CASH", { price: 411, close: null, at: iso(now - MINUTE) }, now)).toBe(false);
  expect(paintable(ITC, undefined, now)).toBe(false);
});

// ---------------------------------------------------------------- remembering

it("keeps the newest price for an id and drops an older offer", () => {
  const start = rememberQuotes({}, [{ id: ITC, price: 411.2, close: 410, at: iso(now - MINUTE) }], now);
  const newer = rememberQuotes(start, [{ id: ITC, price: 412.5, close: 410, at: iso(now) }], now);
  expect(newer[ITC].price).toBe(412.5);
  const stale = rememberQuotes(newer, [{ id: ITC, price: 400, close: 398, at: iso(now - HOUR) }], now);
  expect(stale[ITC].price).toBe(412.5);
});

it("answers with the same object when a tick batch taught it nothing new", () => {
  // The stream publishes dozens of times a minute; a memory that rebuilt itself on every identical frame
  // would redraw every row it touches for no reason.
  const start = rememberQuotes({}, [{ id: ITC, price: 411.2, close: 410, at: iso(now - MINUTE) }], now);
  expect(rememberQuotes(start, [{ id: ITC, price: 411.2, close: 410, at: iso(now - MINUTE) }], now)).toBe(start);
  expect(rememberQuotes(start, [], now)).toBe(start);
});

it("stamps what it saw with the source's own time, and with its clock when the source had none", () => {
  const stamped = rememberQuotes({}, [{ id: ITC, price: 411.2, at: now - 5 * MINUTE }], now);
  expect(stamped[ITC].at).toBe(iso(now - 5 * MINUTE));
  const unstamped = rememberQuotes({}, [{ id: ITC, price: 411.2, at: null }], now);
  expect(unstamped[ITC].at).toBe(iso(now));
});

it("keeps an id it cannot build and a price it cannot show out of the memory", () => {
  const memory = rememberQuotes({}, [
    { id: "", price: 100, at: iso(now) },
    { id: "ITC", price: 100, at: iso(now) },
    { id: ITC, price: 0, at: iso(now) },
    { id: ITC, price: Number.NaN, at: iso(now) },
    { id: ITC, price: -5, at: iso(now) },
  ], now);
  expect(memory).toEqual({});
});

it("drops the oldest prices when the memory is full", () => {
  // Offered oldest first, the way a session actually accumulates them.
  let memory: QuoteMemory = {};
  for (let index = 0; index < QUOTE_MEMORY_MAX + 20; index += 1) {
    const age = (QUOTE_MEMORY_MAX + 20 - index) * MINUTE;
    memory = rememberQuotes(memory, [{ id: `instrument:v1:NSE:EQ:SYM${index}:CASH`, price: 10 + index, at: iso(now - age) }], now);
  }
  expect(Object.keys(memory).length).toBe(QUOTE_MEMORY_MAX);
  expect(memory["instrument:v1:NSE:EQ:SYM0:CASH"]).toBeUndefined();
  expect(memory[`instrument:v1:NSE:EQ:SYM${QUOTE_MEMORY_MAX + 19}:CASH`]).toBeDefined();
});

it("keeps a close an entry did not repeat instead of blanking it", () => {
  const start = rememberQuotes({}, [{ id: ITC, price: 411.2, close: 410, at: iso(now - MINUTE) }], now);
  const next = rememberQuotes(start, [{ id: ITC, price: 412.5, at: now }], now);
  expect(next[ITC]).toEqual({ price: 412.5, close: 410, at: iso(now) });
});

// ---------------------------------------------------------------- entries from each surface

it("offers the stream's prices with the exchange's own stamp", () => {
  const entries = tickEntries([
    { id: ITC, price: 411.2, at: now - 30_000, fresh: true, status: "LIVE", source: "icici", broker: "ICICI", subscriptionId: ITC, previousClose: 410 },
    { id: STRIP, price: 0, at: null, fresh: false, status: "STALE", source: "x", broker: "ICICI", subscriptionId: STRIP },
  ]);
  expect(entries).toEqual([{ id: ITC, price: 411.2, close: 410, at: now - 30_000 }]);
});

it("offers a leg's own premium with the time the chain stamped it", () => {
  const entries = legEntries([
    { instrumentId: CE, ltp: "120.5", ltpAt: "2026-11-25T09:15:00.000Z" },
    { instrumentId: CE, ltp: "0", ltpAt: null },
    { instrumentId: "", ltp: "55", ltpAt: null },
    null,
  ]);
  expect(entries).toEqual([{ id: CE, price: 120.5, close: null, at: "2026-11-25T09:15:00.000Z" }]);
});

it("offers the prices prod put on a cash page itself", () => {
  const entries = cashEntries([row({ ltp: 411.2, close: 410 }), row({ ltp: null, close: 410 }), { ...row(), exchange: "XYZ" }]);
  expect(entries).toEqual([{ id: ITC, price: 411.2, close: 410, at: null }]);
});

// ---------------------------------------------------------------- the words

const noon = new Date("2026-11-25T12:00:00");

it("says the minute a remembered price was seen, in the words a trader reads", () => {
  expect(seenLine("2026-11-25T09:35:00", noon)).toBe("seen 09:35");
  expect(seenLine("2026-11-24T22:05:00", noon)).toBe("seen yesterday 22:05");
  expect(seenLine("2026-11-20T08:00:00", noon)).toBe("seen on 20/11 08:00");
});

it("says nothing rather than a wrong thing about a price it cannot place in time", () => {
  expect(seenLine(null)).toBeNull();
  expect(seenLine("", noon)).toBeNull();
  expect(seenLine("not a date", noon)).toBeNull();
});

it("labels a remembered premium as this phone's own number, never as a tick", () => {
  const side = rememberedSide({ price: 120.5, close: null, at: "2026-11-25T09:35:00" });
  expect(side?.price).toBe(120.5);
  expect(side?.ticked).toBe(false);
  expect(side?.word).toMatch(/^seen /);
  expect(rememberedSide(null)).toBeNull();
  expect(rememberedSide({ price: 0, close: null, at: "2026-11-25T09:35:00" })).toBeNull();
});

// ---------------------------------------------------------------- the saved copy

it("saves the prices under the account's own key so ending a session forgets them", async () => {
  const store = storage();
  const memory: QuoteMemory = { [ITC]: { price: 411.2, close: 410, at: iso(now) } };
  await writeQuoteMemory(store, memory);
  expect(QUOTE_MEMORY_KEY.startsWith(LAST_KNOWN_PREFIX)).toBe(true);
  expect(JSON.parse(store.map.get(QUOTE_MEMORY_KEY)!)).toEqual(memory);
  expect(await readQuoteMemory(store, now)).toEqual(memory);
});

it("writes nothing for an empty memory, so a blank screen cannot erase a good one", async () => {
  const store = storage();
  await writeQuoteMemory(store, { [ITC]: { price: 411.2, close: 410, at: iso(now) } });
  await writeQuoteMemory(store, {});
  expect(JSON.parse(store.map.get(QUOTE_MEMORY_KEY)!)).toEqual({ [ITC]: { price: 411.2, close: 410, at: iso(now) } });
});

it("reads back only what it may still paint", async () => {
  const store = storage();
  store.map.set(QUOTE_MEMORY_KEY, "{not json");
  expect(await readQuoteMemory(store, now)).toEqual({});

  store.map.set(QUOTE_MEMORY_KEY, JSON.stringify({
    "ITC": { price: 411, close: 410, at: iso(now) },
    [ITC]: { price: "411", close: 410, at: iso(now) },
    [STRIP]: { price: 24100, close: null, at: iso(now - 4 * DAY) },
    [CE]: { price: 120.5, close: null, at: iso(now - 20 * HOUR) },
  }));
  expect(Object.keys(await readQuoteMemory(store, now))).toEqual([ITC]);
});

it("keeps the close of a remembered price only when its source named one", async () => {
  const store = storage();
  store.map.set(QUOTE_MEMORY_KEY, JSON.stringify({
    [ITC]: { price: 411, close: 0, at: iso(now) },
    [STRIP]: { price: 24100, close: "nope", at: iso(now) },
  }));
  const read = await readQuoteMemory(store, now);
  expect(read[ITC]?.close).toBeNull();
  expect(read[STRIP]?.close).toBeNull();
});

// ---------------------------------------------------------------- the screens

const read = (path: string) => readFileSync(resolve(path), "utf8");

it("fills an unpriced watchlist row and keeps its minute on the row", () => {
  const screen = read("apps/mobile/app/(tabs)/watchlist.tsx");
  // The memory is offered what the stream and prod just priced, then asked only about the rows neither did.
  expect(screen).toContain("quotes.remember([...tickEntries(feed.quotes), ...cashEntries(liveRows)])");
  expect(screen).toContain("paintWatchlist(liveRows, quotes.seen)");
  // Ordering is the last step before the list, and it reads the painted rows, so a price the phone supplied
  // sorts the list exactly like a price prod sent.
  expect(screen).toContain("sortRows(shownRows, SORT_KEYS, sort)");
  expect(screen).toContain("data={orderedRows}");
  // A remembered row trades its day's move — measured against the close it was seen with — for the minute.
  expect(screen).toContain("{ color: item.seen ? colors.text : priceTone(item.change) }");
  expect(screen).toContain("? item.seen");
  expect(screen).toContain("prev.item.seen === next.item.seen &&");
});

it("falls a ladder leg back to the premium this phone last saw for that same id", () => {
  const screen = read("apps/mobile/app/(tabs)/option-chain.tsx");
  // A tick still outranks the memory, and prod's chain read still outranks it: only a leg neither priced asks.
  expect(screen).toContain("liveSide(callQuote, liveCall) ?? rememberedSide(savedCall)");
  expect(screen).toContain("liveSide(putQuote, livePut) ?? rememberedSide(savedPut)");
  expect(screen).toContain("savedCall={quotes.seen(item.row.call?.instrumentId)}");
  expect(screen).toContain("quotes.remember([...tickEntries(feed.quotes), ...legEntries(legs)])");
});

it("seeds the memory from the two surfaces that always carry prices", () => {
  const strip = read("apps/mobile/src/components/IndexStrip.tsx");
  const portfolio = read("apps/mobile/app/(tabs)/portfolio.tsx");
  expect(strip).toContain("const entries: QuoteEntry[] = tickEntries(feed.quotes);");
  expect(strip).toContain("quotes.remember(entries);");
  expect(portfolio).toContain("quotes.remember([...tickEntries(feed.quotes), ...priced]);");
});

it("forgets the remembered prices with the saved book, not before it", () => {
  const hook = read("apps/mobile/src/hooks/useLastKnown.ts");
  expect(hook).toContain("forgetQuoteMemory();");
  const memory = read("apps/mobile/src/hooks/useQuoteMemory.ts");
  expect(memory).toContain("readQuoteMemory(AsyncStorage)");
  expect(memory).toContain("writeQuoteMemory(AsyncStorage, store)");
  // Learning a price must not repaint a screen: rows ask while they render, and only the disk copy's arrival
  // forces a pass, so a tick frame costs the ladder and the list nothing.
  expect(memory).toContain("if (next === store) return;");
  expect(memory).toContain("for (const repaint of screens) repaint();");
});
