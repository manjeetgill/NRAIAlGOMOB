# Mobile Code Fixes — Chart Speed, Tick Path, and Poll-to-Push

Actionable fix list for the Expo/RN client, derived from `AUDIT_ICICI_ONLY_PRICES_AND_ORDERS.md` §2.4, §3.6, §8.
**Proposed changes only — nothing here was applied.**

| | |
|---|---|
| Code root | `C:\Users\manje\Downloads\NRAIAlgo-Python-main\mobile-app` (git `275a7f8`) |
| Companion doc | `BACKEND_CODE_FIXES.md` — M4, M6-M9 are paired with B5, B7-B10 |
| Written | 2026-11-24, ~15:05 IST |

### Gate, re-run in this pass

```
npx tsc --noEmit -p apps/mobile/tsconfig.json    →  exit 0, 0 lines of output, 14:55:35 IST on 275a7f8
npx tsc --noEmit -p apps/mobile/tsconfig.json    →  exit 0, 0 lines of output, 20:46:48 IST on §F's branch
```

The second run is §F's tree: PR #51 merged as `c93996f`, and that branch's commits change only these two
documents, so the gate was re-run against the tree §F cites rather than carried forward from `275a7f8`.

**This supersedes the audit's §2.10**, which recorded exit 2 with 4 errors at 14:31-14:33 on `c3082a5`. Two commits
landed between those runs and fixed it: `isCalendarBasket` is now declared (`apps/mobile/app/spread-builder.tsx:584`,
used at `:588`, `:600`) and the `algo-lab.tsx` query calls now pass `enabled` plus their own query keys
(`apps/mobile/app/algo-lab.tsx:58`, `:62`), which is what priority 15 asked for. **[V]** — my earlier note that
`hooks.ts:341` takes one parameter is stale; it spreads `...options`, so the `queryKey` overrides are the same keys
and nothing is shadowed.

No build, no install, no app launch, no device or emulator run. So: **every item below is a source-level finding.
None is verified to render or to feel faster on a phone.**

### Rails

1. Do not verify a send-path change by sending an order. M4 is the only item that touches one, and it is
   verifiable from the abort arithmetic plus a fake timer.
2. **Keep every REST fallback.** `needsRead` suppresses socket prices server-side (audit §8.5), so a push consumer
   must start a slow reconcile, not replace the poll outright.
3. A new subscription must be idempotent: a changed instrument set moves the server's subscription fingerprint and
   **replaces a working Breeze stream** (`BACKEND_CODE_FIXES.md` "Already correct"). Client-side churn — an
   unmemoised id array, a per-render subscribe — can therefore restart a healthy socket. This is the main risk in
   M6-M9.
4. SSE capacity is **3 per kind per workspace, 20 globally** (`api/overview.py:422-425`, `:483-486`, `:548-551`).
   Do not open one connection per hook; multiplex one per workspace.

---

## A. What commit `275a7f8` already did — do not redo it

I checked each claim against the current tree rather than trusting the commit message.

| Its claim | Actual state now |
|---|---|
| "KLineChart: in-memory candle deduplication key to avoid unnecessary WebView re-renders" | **Real.** `apps/mobile/src/components/KLineChart.tsx:111-114` builds a `length_firstTs_lastTs_lastClose` key and returns early on a match. **[V]** But the full-series replace is still there — `:124 chart.applyNewData(klineData)` — so item **M2 stays open**; the guard only removes *no-op* updates |
| "algo-lab: lazily enable useFleet / useOpenPositions by active tab" | **Real and it closes the typecheck error.** `apps/mobile/app/algo-lab.tsx:58`, `:62` **[V]** — removes audit priority 15 |
| "watchlist: constant-height `getItemLayout` (65px)" | Not independently verified beyond the diff stat; M8's `useEquityQuote`/watchlist poll claim is separate and still holds |
| "orders: single-pass bucketing", "scanner: Sets + virtualization", "trade-history: `getItemLayout` (69px) + virtualize", "spread-builder: memoize payoff/SVG, hoist styles" | Render-cost work in screens I audited only for tick-path and send-path issues. **None of these touches `websocket.ts`, `terminal-charts.tsx`'s tick path, the poll intervals, or the abort timeout** — verified by `git diff ef86218..HEAD --stat` and the greps above **[V]** |

So the whole of section **B** and **C** below is untouched by that commit. It fixes *what a screen costs to lay
out*; it does not fix *how often the phone is woken* or *how many REST polls it pays*.

---

## B. Tick path — the price-update speed items

| ID | Fix | Where | Effect |
|---|---|---|---|
| M1 | One feed object per **changed** quote, not per frame | `packages/shared/src/api/websocket.ts:119-126`, `:129-131`, `:289` | Removes a full-array copy + a new React object per frame per screen |
| M2 | Patch the last bar instead of replacing the series | `apps/mobile/src/components/KLineChart.tsx:124` | Removes a full-series serialise into the WebView on every tick |
| M3 | Hoist the chart screen's style sheet off the tick path; bound the min/max scan and the window | `apps/mobile/app/terminal-charts.tsx:138`, `:125-126`, `:100` | Stops a `StyleSheet.create` per tick and an O(window) scan |

### M1 — the per-frame cascade

`snapshotFor()` at `websocket.ts:119-126` builds a fresh array of every published quote
(`[...published.values()]`, or a `.filter()` over all of them) on each call; `publish()` at `:129-131` calls every
watcher with it; and `useRegistration`'s handler at `:289` does `setFeed({ ...next, reason })` — a **new object
identity every frame**, so every screen re-renders even when its own instruments did not move.

**Change.** Emit per changed id. The frame already arrives as snapshot-or-delta (`api/quotes.py:22-28`
`mode`), so the module can keep the published map and hand each watcher only the ids it registered for, creating a
new feed object when one of *those* ids changed and nothing otherwise.

**Verification, offline.** Unit-test the module with two watchers on disjoint id sets and assert the second
watcher's handler is not called when only the first's instrument ticks. That is a countable assertion, not a feel
test. **[D]** for any claim about jank until it is seen on a device.

### M2 — full-series replace

`KLineChart.tsx:108-127` `updateData(data)`: it maps the entire array to `klineData` (`:115-122`) then calls
`chart.applyNewData(klineData)` (`:124`). `applyNewData` resets the series. **[V]** With the `:111-114` dedup guard
in place this now happens only when something actually changed — which makes M2 the remaining half of that fix,
not a duplicate of it.

**Change.** When only the last bar moved, update that bar (`updateSeries`/`updateData` on the last item) and
reserve `applyNewData` for a genuine series change — new window, interval change, or first paint.

### M3 — three things in one file, all in the tick path

| Line | Issue | Change |
|---|---|---|
| `terminal-charts.tsx:138` | `const styles = StyleSheet.create({...})` sits in the render body, and `:107 useLiveCandles` makes that render tick-driven — so "per render" means **per tick** **[V]** | Module-level static sheet + a `useMemo` keyed only on theme colors |
| `:125-126` | `Math.max(...highs) - Math.min(...lows)` and both spreads again over the whole window, twice, per render **[V]** | One pass computing min/max; note spread on a large array also risks an argument-count limit |
| `:100` | `withForming(candles, chartData?.forming, 0)` — `0` means the intraday window is unbounded (`withForming` at `:61` takes a `limit`) **[V]** | Pass an explicit cap for the visible window |

---

## C. Poll-to-push — where the app is doing work ICICI already did

Full evidence in audit §8. One-line version of *why*: ICICI counts every REST call against ~5,000/day and its
websocket is not counted (`services/stream_marks.py:3-5`), so a poll is a claim on the budget the trader needs to
place orders.

Counts below are arithmetic from the interval, **not measurements**. A market session here is ~6 h 25 m
(09:15-15:40 IST) and an app left open after close keeps polling the rest of the day.

| ID | Poll today | Interval | Requests / open hour | Push source that already exists |
|---|---|---|---|---|
| M6 | `hooks.ts:640-651` `useOrderSnapshot`, `refetchInterval: 1 s` while unsettled (`:646`), used at `spread-builder.tsx:259` | 1 s | 3,600 | `api/overview.py:475-540` SSE — emits only `queued/working/unknown/needs_manual` intents with per-leg state (`:505-525`) and wakes on a tick (`:528`) |
| M7 | `hooks.ts:341-347` `useOpenPositions` **and** `hooks.ts:355-360` `useIciciAccount`, both 5 s, both `/v1/broker-auth/icici/account` | 5 s ×2 | 1,440 + 1,440 | `api/overview.py:414-471` SSE, whose docstring says it exists so "a terminal no longer opens a broker read per account poll" (`:418-419`) |
| M8 | `hooks.ts:656-667` `useEquityQuote` 3 s, consumed at `BuySheet.tsx:33` | 3 s | 1,200 | The socket already holds it: `brokers/streams.py:320-324` force-subscribes 217 core equities, `:302-305` the saved watchlist, `:333-343` leased rows |
| M9 | `hooks.ts:711-717` `useIndices` 15 s, mounted app-wide (`_layout.tsx:13`, `:36`) so it runs on **every** screen | 15 s | 240 | Server side is already socket-first (`services/option_chain_service.py:701-731`); five headline indices force-subscribed (`brokers/streams.py:306-319`). Blocked on backend **B9** |
| M10 | `hooks.ts:698-704` `useMarketQuotes` 1 s and `hooks.ts:722-728` `useMarketDepth` 1 s — **both have zero consumers** **[V]** | 1 s each if mounted | 3,600 each | Delete both, or convert to the quote WS. A dormant 1 s poller is one import away from being live |
| M11 | `hooks.ts:274-279` `useBaskets` 10 s (`BasketDesk.tsx:80`) | 10 s | 360 | Push-to-invalidate on the M7 connection; the leg marks inside that payload already come off the socket (`option_chain_service.py:946-954`) |
| M12 | `hooks.ts:743-748` scanner `liveTrades` 10 s, `:755-759` `useTechnicalEvents` 60 s | 10 s / 60 s | 360 / 60 | Our own Postgres, not ICICI — lowest value, do last |
| — | `hooks.ts:492` `useOptionChain` 5 s | 5 s | 720 | **Leave it.** Its leg marks are already socket-complete, and lowering the ladder cadence without moving strikes onto the WS would make the visible chain slower. Conditional on M9 |

**How to land M6-M9 without the churn risk (rail 3).** Subscribe once per workspace, in the same module that owns
`websocket.ts`, and have hooks consume a shared feed rather than each opening a transport. Each new consumer must
be paired with a slow reconcile (`refetchInterval` raised to 30-60 s) that stays alive while the push is silent, so
`needsRead` can never leave a screen showing nothing.

## D. Send path and lifecycle

| ID | Fix | Where |
|---|---|---|
| M4 | Stop the client abandoning a call the server is still completing — **paired with B5** | `packages/shared/src/api/client.ts:66` `timeout = 30_000`; `:68-69` abort timer; `:136-140` `AbortError` → 408 `TIMEOUT`. Server default is 45 s (`brokers/runtime.py:128`) and `api/strategy_drafts.py` sets no override **[V]** |
| M5 | ~~Make the AppState wiring actually pause polling~~ — **wrong when written, and the opposite is the problem.** `apps/mobile/src/utils/queryClient.ts:33-43` sets `focusManager.setFocused(...)`, and `:52` is `refetchOnWindowFocus: true`, not the `false` this row claimed. The focus signal is honoured, so a foreground is a refetch burst: the fix is M27, gating it. Audit §9.7 | `apps/mobile/src/utils/queryClient.ts:33-43`, `:52` **[V]** re-read at `c93996f` |
| M13 | Delete or wire the dead hooks — **the pollers are already off, `useOrderIntents` has a consumer, and the third file is gone** | `hooks.ts:1158-1169` `useOrderIntents` (`refetchInterval: false` at `:1166`, consumed by `apps/mobile/app/(tabs)/orders.tsx:198`), `hooks.ts:1171-1182` `useBrokerLiveOrders` (`:1179`; `/v1/orders/broker-live` still has no route — `grep -rn "broker-live" backend/python/nraialgo/` is empty **[V]**); `useRealtimeQuotes.ts` no longer exists in the tree. What is left is deleting the second hook, not muting it |
| M14 | ~~Resolve the option-chain `window` collision on a shared cache key~~ — **no longer collides** | `queryKeys.optionChain.chain` now takes the window into the key (`hooks.ts:308`), so the 30-strike read (`CHAIN_WINDOW = 30` at `:386`, used at `:401-402`, `:1021`) and the full-ladder read (`FULL_WINDOW = 400` at `:235`, used at `:1070-1072`) are two entries. Written against an earlier tree; audit §9.7 |
| M15 | Make the generated chart library reproducible | `apps/mobile/src/components/klinecharts_lib.ts:1-2` says *"Auto-generated by build_klinecharts_lib.js - DO NOT EDIT / Source: assets/vendor/klinecharts.min.txt (234410 bytes)"* — but `apps/mobile/package.json:6-13` has **no script** that runs `scripts/build_klinecharts_lib.js` **[V]**. Wire it into a prebuild/typecheck step, or delete the `.txt` asset so there is one source of truth |
| M16 | The one price-status word that carries no reason | `packages/shared/src/api/live-candles.ts:183` — `STATUS_LABELS[tick.status.toUpperCase()] ?? tick.status`, and `"Unlabelled"` when `tick.status` is empty (`:183`). A label of "Unlabelled price 1,234.50" tells the trader the server knows nothing, without saying why. Give it the reason the way the three refusals above it already do (`:179-181`) **[V]** |

M4 is the only item here that touches a send, and the fix is a timeout value, not an order-path behaviour change.
**Do not** "fix" it by raising 30 s to 60 s: that only lengthens a spinner on a call that may already have
committed. The right shape is one idempotent round-trip keyed on `clientId`, or a server budget the client cannot
outrun.

### B1's client half is already done — checked, and no change is needed

I went looking for a client change to pair with backend **B1** (post-close `STALE` → `LAST_CLOSE`) and the answer is
that none is required. Proved, not assumed:

- `packages/shared/src/api/live-candles.ts:168` already maps `LAST_CLOSE: "Last close"`, and `:183` normalises with
  `tick.status.toUpperCase()` before lookup — so a new `LAST_CLOSE` frame renders correctly the moment the server
  emits it. **[V]**
- `apps/mobile/src/components/IndexStrip.tsx:17-24` compares lowercase (`"live"`, `"stale"`), and the strip's rows
  arrive with lowercase `priceStatus` — `services/option_chain_service.py:680` sets `"priceStatus": … quote_quality`,
  and the index strip rows carry **no** `dataStatus` at all, so `hooks.ts:1897`'s
  `row.dataStatus ?? row.priceStatus` resolves to the lowercase field. The casing matches. **[V]**
- The only hardcoded stale test in the whole client is `IndexStrip.tsx:20`, and it is fed correctly. **[V]**

Worth stating plainly because I nearly wrote the opposite: my first reading was that the strip's lowercase
comparisons could never match an uppercase `dataStatus`, which would have made every live index read "last close".
Reading `option_chain_service.py:670-682` refuted that — the strip does not use `dataStatus`. **There is no casing
defect here.**

## E. Order of work

1. **M10** and **M13**: delete provably dead pollers. Zero product risk, and they remove future 1 s pollers and a
   404-poller before anyone mounts them. **M15** belongs here too — it is a one-line `package.json` script, and
   until it exists the shipped chart engine has no reproducible source.
2. **M3** and **M2** — mechanical, tick-path, no behaviour change to review.
3. **M1** — the biggest tick-path win, and the only one unit-testable without a device (count handler calls).
4. **M5**, then **M7** + **M6** together (one multiplexed connection, order + account), with the reconcile fallback
   in the same change.
5. **M8**, **M9**, **M11** — each needs the backend answer from `BACKEND_CODE_FIXES.md` B7-B10 first.
6. **M4** with B5, **M12** last.

**Not worth doing:** any client change aimed at "getting faster ticks". No client change can print an ICICI
instrument more often than ICICI prints it — audit §2.1. Every item above reduces *work done per tick* or *requests
that were never needed*, not the tick rate.

## F. Live-price freeze — the work list from audit §9 (2026-11-27)

Full evidence, the tick-by-tick trace and the drop-in code are in `AUDIT_ICICI_ONLY_PRICES_AND_ORDERS.md`
§9.1-§9.6. Citations are merged main `c93996f` — that is PR #51 inside the tree this list applies to, and each
row says what #51 already took.

| ID | Fix | Where |
|---|---|---|
| M17 | **Release the dispatch hold.** `pauseQuoteDispatch` sets a bare module boolean that only a scroll-end clears — count the holders, add a 1.5 s watchdog, release on unmount (`useQuoteDispatchHold`) | `websocket.ts:166`, `:182-191`, `disconnect` `:446-472`; holders at `SortableTable.tsx:143-144` and `option-chain.tsx:817-818` **[V]** |
| M18 | **Take the live spot out of the analysis request.** The body is the cache key, so a tick is a POST plus a retained entry; key on the basket (legs, dates, shocks) and let the socket price the drawing. #51 only throttled it | `PayoffChart.tsx:246` → deps `:308`, `:359` → `:362`, `:368`, `:378`; key `hooks.ts:312`, query `:1130-1139`; second pass through `PayoffChart.tsx:394` → `:415` **[V]** |
| M19 | **Memoize the order-ticket container.** Thirteen actions are already `useCallback`'d; the returned literal is new every render, so `onTrade` is new and no row memo can bail | `packages/shared/src/hooks/useOrderTicket.tsx:374` (actions at `:126`-`:352`); consumers `option-chain.tsx:583-594`, `:859`, `portfolio.tsx`, `watchlist.tsx`, `stock.tsx` **[V]** |
| M20 | **A hidden screen releases its ids.** Both screens already compute `focused` for polling; the stream subscription ignores it, so the one socket carries every mounted tab | `option-chain.tsx:327` vs `:445`; `watchlist.tsx:235` vs `:421`; union `websocket.ts:265-267` **[V]** |
| M21 | **Cut the per-frame work in the ingest path.** `quoteKey` without `JSON.stringify`; cache `desiredInstruments` against watcher churn instead of rebuilding it in `armSilence`; index published ticks by id so `snapshotFor` reads its own ids instead of copying the map | `websocket.ts:128-130` (once per quote at `:299` since #51, was twice); `:265-267` called from `:351-353` on every message (`:422`); `:156-162` **[V]** |
| M22 | **Rewrite quote memory when the data changes, not when a tick lands.** #51 took the ladder's effect off `feed.quotes`; three writers still clone and sort up to 600 keys per live tick | `option-chain.tsx:147-149` (per moved cell), `watchlist.tsx:430` and `IndexStrip.tsx:81-88` (per publish); ladder effect now at `option-chain.tsx:454-457`; `quote-memory.ts:57`, `:113`, `:129`, `:137` **[V]** |
| M23 | **Make the book screen derive on its own data.** Four unmemoized derivations and an inline index-keyed ladder on every tick of its own symbol | `stock.tsx:54`, `:55`, `:56-64`, `:170`, `:171`, `:172`, `:326-337`; `quoteProvenance` → `isTodayIST` allocates two `Date`s per call (`utils/index.ts:47-51`) **[V]** |
| M24 | **Cap the cache.** No `gcTime` anywhere, so M18's dead keys sit for the library default (5 min) | `queryClient.ts:46-58` **[V]** |
| M25 | **Memoize the table's geometry** — a synchronous `Dimensions.get` per render feeds both memos' dependency lists, and there is no `extraData` | `SortableTable.tsx:50`, `:74`, `:95`, `:134` **[V]** |
| M26 | **Return the same series when a tick re-prices a bar already drawn.** The WebView already patches one bar; this side still rebuilds ~150 objects when the bar is new | `live-candles.ts:265-280` → `terminal-charts.tsx:500-510`; patch path `KLineChart.tsx:789-802`, `patchBar` `:605-624` **[V]** |
| M27 | **Make a foreground a resume, not a burst.** All three refetch flags are on while the same event re-snapshots every watcher | `queryClient.ts:52-54`, `:34-38`, `:24-31`; `websocket.ts:407-413`, `:289-294` **[V]** |
| M28 | Optional, only if M17-M20 land and the band is still hot: skip `tickByInstrument`'s allocation when the publish carried none of this screen's ids | `chain-ticks.ts:71-83`, call `spread-builder.tsx:481` (the chain's call site is gone since #51) **[V]** |

**Already landed by PR #51** (merged as `c93996f`) — do not redo: M19's per-tick half on the chain (cells now
subscribe individually through `packages/shared/src/api/quote-store.ts`, `option-chain.tsx:146`, `:199`), M22's
ladder half, M26's "same bar" guard, and M28's chain call site. Still open: **M17, M18, M20, M21, M22 (the three
remaining writers), M23, M24, M25, M27, M28**. Full before/after in audit §9.6. **[V]**

**Not in this list on purpose:** no worker, no worklet, no WebView compute path for the payoff math. Hermes has no
worker threads and the curve is ~300 `bsm` calls for a four-leg spread; M18 leaves it running four times a second
(ten before #51's throttle), which is the whole problem. If a 32-leg basket is ever genuinely slow, the fix is the
61-point grid at `PayoffChart.tsx:397-411`, not a new runtime. Audit §9.5(c4).

**Order of work:** M17 first — it is the only item that can stop prices across the whole app permanently and it is
twenty lines. Then M18 + M24 (request storm and its retention), M20, M19, M21, then M23/M25/M26/M27 as surface
clean-up.

## Status

Proposed changes only. No file under `mobile-app` was modified while writing this; `git status --porcelain` shows
nothing but untracked audit documents. The only command with side effects was a read-only typecheck
(`npx tsc --noEmit`), exit 0, recorded above with its timestamp and commit. **No order was placed, cancelled,
amended, previewed or dry-run**; no endpoint was called; no websocket or SSE connection was opened; no device,
emulator or dev server was started. No secret, token, API key, TOTP or session value appears here or was printed
while writing it.
