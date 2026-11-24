# Mobile performance audit — findings

**Date:** 2026-11-24
**Tree:** `main` @ `c3082a5`, working tree as-is
**Prepared by:** Qoder agent (read-only pass — no source files were modified to produce this document)
**Follow-ups:** `AUDIT_LIVE_PRICES_AND_ORDER_SPEED.md` (superseded for server-side claims) and
`AUDIT_ICICI_ONLY_PRICES_AND_ORDERS.md` (**current** — the live-price and order-execution findings re-derived
with only ICICI Direct connected). Any statement here about a vendor feed or a second broker should be read
against the ICICI-only document.

**Status update — two commits landed after this document was written** (`ef86218`, `b5939b9` at 14:10 IST
2026-11-24; both verified against the current tree). They close some of what is below, and §2.9 of the ICICI-only
document is the authoritative record of it:

| Section | Status now |
|---|---|
| A2 (`/v1/auth/me` fires twice) | **Fixed** — `initializeQueryClient()` no longer awaits it (`queryClient.ts:53-56`) and `initializeApiClient()` is single-flighted (`apiClient.ts:80-98`) |
| A5 (`ThemeProvider` renders an empty `<View>` first) | **Fixed** — `ThemeProvider.tsx:62-66` renders `children` unconditionally |
| B (registration key rebuilt per render) | **Fixed** for the key — `websocket.ts:280-281` memoized. The per-frame `setFeed` at `:289` and the full-snapshot copy at `:119-131` are **not** fixed and remain P1 |
| C (nothing knows the app is backgrounded/offline) | **Partly** — NetInfo + AppState are now wired (`queryClient.ts:15-28`), but `refetchOnWindowFocus: false` at `:37` makes the focus half inert, so background polling is not actually paused |
| D (style objects rebuilt per render) | **Not addressed** — e.g. `terminal-charts.tsx:138` still calls `StyleSheet.create` in the render body |
| E (chart screen reads a 234 KB asset) | **Superseded** by `ef86218` — the library is inlined as `klinecharts_lib.ts` and interpolated at `KLineChart.tsx:41`. Asset I/O is gone; the trade-offs (bundle weight, an unwired generator, a now-unreferenced `.txt`) are §2.9 item 5 of the ICICI-only document |
| A1, A3, A4 (root `_layout.tsx` null-render, splash in `finally`, persisted-store shortcut) | **Not addressed** — `b5939b9` changed `apps/mobile/app/(tabs)/_layout.tsx`, not `apps/mobile/app/_layout.tsx` |
| F (bundle weight) | **Not addressed**, and the figures there are stale regardless — see the caveats in §F |

## Scope and method

Audited the Expo SDK 58 / React Native 0.88 monorepo (`apps/mobile`, `packages/shared`) for cold start,
navigation, network, caching, live-market render cost and bundle weight. Evidence is from direct file reads,
`grep` sweeps over app source, `node_modules` inspection of the navigation and query libraries, and the
release build artifacts already present under `apps/mobile/android/app/build/`.

Baseline check that did run:

| Command | Result |
|---|---|
| `npx tsc --noEmit -p apps/mobile/tsconfig.json` | exit 0 (clean) |

What was **not** run, and therefore is not claimed anywhere below: no device or emulator session, no
on-screen timing, no profile trace, no fresh release build. Every number in this document is a static
measurement — bytes, counts, configured intervals — not a millisecond the user experiences.

### Uncommitted work noticed in the tree

These already had edits when the audit began and were deliberately left untouched:

- `apps/mobile/src/components/BasketDesk.tsx` — payoff-chart zoom controls and a touch crosshair tooltip
- `tests/contracts/mobile-basket-desk.test.ts` — assertions relaxed to match the above
- `apps/mobile/src/components/KLineChart.tsx` — type-only fixes (`import type`, ref cast, expanded
  `StyleSheet.absoluteFillObject`)

Worth flagging: that BasketDesk diff also **removes displayed figures** — `priceProvenance(built.marks)`,
Greeks, Horizon, the underlying/spot/days-to-expiry lines, and both T+0 legend notes. If those removals were
not intended, they need restoring separately from any performance work.

### The tree changed while this audit was running

A second writer was editing this repository during the pass (it also left its own `PERFORMANCE_AUDIT_REPORT.md`
at 13:11). By 13:16 the following had appeared, none of it mine:

| Change | Effect on this document |
|---|---|
| `apps/mobile/assets/vendor/klinecharts.min.js` → `klinecharts.min.txt` (same 234,469 bytes), with `KLineChart.tsx:41` repointed at the new name | Section E cites the `.txt` path; the byte count and every line number are unchanged |
| `apps/mobile/app/spread-builder.tsx` modified (57 lines) | not cited in this document |
| `KLineChart.tsx` further edits | lines 41 / 45 / 57 re-verified after the edits |

All other citations in this document were re-checked against the tree at 13:17 and still resolve
(`_layout.tsx`, `queryClient.ts`, `ThemeProvider.tsx`, `websocket.ts`, `hooks.ts`, `stores/index.ts`,
`constants/index.ts`, `portfolio.tsx`, `watchlist.tsx`, `SortableTable.tsx`, `terminal-charts.tsx` are all
unmodified in the working tree). Line numbers below refer to the tree at that time; anything else in this repo
is moving under the audit.

---

## A. Cold start waits on a network round-trip — P0

| # | Cause | Evidence |
|---|---|---|
| A1 | The whole provider tree renders `null` until init finishes, and init is a network call | `apps/mobile/app/_layout.tsx:44-72`; `initializeApiClient()` issues `client.get("/v1/auth/me")` at `apps/mobile/src/utils/apiClient.ts:80-91` |
| A2 | `/v1/auth/me` fires **twice** in parallel at launch: `Promise.all([initializeApiClient(), initializeQueryClient()])`, and `initializeQueryClient()` only awaits `initializeApiClient()` again | `_layout.tsx:53-56`; `apps/mobile/src/utils/queryClient.ts:36-38`. No in-flight dedupe exists in `createApiClient` (no `inflight` / `dedupe` / `Map<` in `packages/shared/src/api/client.ts`), so two real requests leave the device |
| A3 | The splash screen clears only in `finally`, so a slow or hung server leaves the app blank | `_layout.tsx:63` |
| A4 | The wait is not needed for correctness: the auth store is already `persist`-ed and `app/index.tsx` redirects off `isAuthenticated` | `packages/shared/src/stores/index.ts:40-85`; `apps/mobile/app/index.tsx` |
| A5 | `ThemeProvider` renders an empty `<View>` for one commit cycle before anything mounts, adding a second frame on top of A1 | `apps/mobile/src/components/ThemeProvider.tsx:61-65` |

**Shape of the delay:** tap icon → splash → *one RTT to myalgodesk.in* → first frame.

**Worst case:** a failing `/v1/auth/me` is retried before anything is shown, because the client defaults
`retry: QUERY_CONFIG.RETRY_COUNT` with `retryDelay: QUERY_CONFIG.RETRY_DELAY` = **3 retries, 1000 ms**
(`packages/shared/src/constants/index.ts:255-256`, applied at `apps/mobile/src/utils/queryClient.ts:17-18`).

---

## B. Every quote frame re-renders the entire book — P0 (live market)

The tick fan-out has no coalescing step anywhere in the chain:

1. `accept(frame)` — `packages/shared/src/api/websocket.ts:153-166`
2. `publish()` — `websocket.ts:129-131`
3. `snapshotFor(ids)` — copies **every** published tick and then filters `websocket.ts:119-127`
4. `setFeed({ ...next, reason })` — a fresh object identity **per frame, per watching screen** — `websocket.ts:288-290`
5. Each screen's memo keyed on `feed.quotes` re-marks all of its rows:
   - `apps/mobile/app/(tabs)/portfolio.tsx:128-130` (`markPositions`, `markHoldings`)
   - `apps/mobile/app/(tabs)/watchlist.tsx:216-217` (`markWatchlist`)

Amplifiers:

- **Zero `React.memo` in the whole app** — `grep -rn "React.memo\|= memo(" apps/mobile` → no hits — so every
  visible row re-renders on every frame.
- `desiredInstruments()` rebuilds and re-sorts the full subscription set on every send — `websocket.ts:133-141`.
- `useRegistration` recomputes `[...new Set(symbols)].sort()` on every render — `websocket.ts:280-281`.

---

## C. Nothing knows the app is backgrounded or offline — P1

`grep -rn "AppState|focusManager|onlineManager|NetInfo|InteractionManager|runAfterInteractions" apps/mobile packages/shared`
→ **zero hits** in app source.

- Every `refetchInterval` keeps firing while the app is in the background, plus the open socket:

  | Query | Interval | Evidence |
  |---|---|---|
  | Open positions | 5 s (staleTime 3 s) | `packages/shared/src/api/hooks.ts:343-347` |
  | Orders / GTT | 10 s each | `hooks.ts:586-600`, `hooks.ts:679-685` |
  | Index strip | 15 s | `hooks.ts:704-713` |
  | Watchlist | 2 s while `pricesPending`, else 5 s | `hooks.ts:379-384` |

  Cost: background data and battery, and a stack of pending state updates landing at resume.
- `refetchOnReconnect: true` (`apps/mobile/src/utils/queryClient.ts:20`) is **inert** — `onlineManager` is
  never wired to anything, although `@react-native-community/netinfo` 12.0.1 is already a dependency
  (`apps/mobile/package.json:20`). Offline-first is not detected at all.
- `refetchOnWindowFocus: false` (`queryClient.ts:19`) removes the one mechanism React Native apps use to
  refresh on foreground, so the current configuration pays for background polling without buying fresh data
  on resume.

---

## D. Style objects rebuilt on every render — P2

`StyleSheet.create` is called inside component bodies in **18 files**: all five tabs, `spread-builder`,
`algo-lab`, `trade-history`, `terminal-charts`, `login`, `BasketDesk`, `BuySheet`, `SortableTable`,
`WatchlistManager`, `IndexStrip`, `KLineChart`, `ThemeProvider`.

Two distinct sub-cases:

- **Not memoised at all** — e.g. `apps/mobile/app/terminal-charts.tsx:138`, `apps/mobile/app/(tabs)/scanner.tsx`.
- **Memoised but with a dep that never matches** — `apps/mobile/src/components/IndexStrip.tsx:40-52` wraps
  `StyleSheet.create` in `useMemo(..., [colors])`, but `colors` is a fresh object literal on every render at
  `IndexStrip.tsx:33-35`, so the memo always misses. The strip is mounted above the router on **every**
  screen (`_layout.tsx:36`), so this is the app-wide case.

---

## E. The chart screen reloads a 234 KB library per interaction — P2

| Fact | Evidence |
|---|---|
| `assets/vendor/klinecharts.min.txt` = **234,469 bytes** (was `.min.js` earlier today; renamed by the second writer mid-audit) | `ls apps/mobile/assets/vendor/` |
| Loaded into component state via `Asset.fromModule` → `downloadAsync` → `FileSystem.readAsStringAsync` | `apps/mobile/src/components/KLineChart.tsx:41-45` |
| The full HTML document (library text embedded) is rebuilt on every theme change | `KLineChart.tsx:57` |
| A `key={chartKey}` remount forces a **complete WebView reload on every symbol and interval change** | `apps/mobile/app/terminal-charts.tsx:220`, driven by `chartKey` at `terminal-charts.tsx:74` |
| Chart height is hard-coded, not viewport-derived | `terminal-charts.tsx:221` (`height={500}`) |

Consequence: switching NIFTY 1m → BANKNIFTY 1m is a page load, not a data update.

---

## F. Bundle weight — P1, the measurement is stale and must be re-taken

Artifacts present in the tree, dated **2026-11-24 10:30** (n = 1 build, 1,904 modules):

| Metric | Value |
|---|---|
| Shipped release JS (`android/app/build/generated/assets/react/release/index.android.bundle`) | **4,371,604 B** (4.37 MB), minified |
| Release sourcemap | 11,714,972 B |
| react-native | 2,251 KB (28.9 % of source bytes) |
| expo-router | 1,336 KB (17.1 %) |
| react-native-reanimated | 916 KB (11.7 %) |
| react-native-gesture-handler | 451 KB (5.8 %) |
| `react-native-gifted-charts` | **732 KB** — 381 KB `gifted-charts-core/dist` **+** 350 KB `react-native-gifted-charts/src`, i.e. the wrapper source *and* the compiled core both in the graph |
| `apps/mobile` own code | 287 KB |
| `packages/shared` | 188 KB |
| Hermes `.hbc` bytecode anywhere under `android/app/build` | **none found** |

Two caveats, stated rather than smoothed over:

1. **The build predates the current code.** It is older than `c93a5ba` (11:36) and `c3082a5` (12:46), the
   commits that stopped `terminal-charts` from using `CandleStickChart`. Current source imports
   `react-native-gifted-charts` nowhere (`grep -rn "gifted" apps/mobile/app apps/mobile/src packages/shared/src`
   → only `apps/mobile/package.json:40`), so the 732 KB should already be absent from a fresh build.
2. **"No `.hbc`" is not yet a verdict.** No APK was produced, so bytecode may have been generated elsewhere,
   or the build may have stopped before packaging. `hermesCommand` is wired at
   `apps/mobile/android/app/build.gradle:14` and `hermesEnabled=true` is set at
   `android/gradle.properties:48`.

The one command that settles both:

```
cd apps/mobile/android && ./gradlew clean :app:assembleRelease
```

then re-measure the bundle and search for `.hbc`.

---

## G. Ruled out — these are not problems

| Item | Evidence |
|---|---|
| New architecture and Hermes are both enabled | `android/gradle.properties:44`, `:48` |
| Tabs are already lazy — no change needed in `app/(tabs)/_layout.tsx` | `lazyByDefault: true` at `node_modules/expo-router/build/react-navigation/bottom-tabs/navigators/createBottomTabNavigator.js:55` |
| Lists are already virtualised | `FlatList` in `orders.tsx:241/256/271`, `watchlist.tsx:365`, `option-chain.tsx:435/553/611`, `scanner.tsx`; the book table uses `FlatList` at `src/components/SortableTable.tsx:129` |
| The socket is one correct module-level connection shared across screens, with refusal-aware backoff | `packages/shared/src/api/websocket.ts:168-183` |
| `useRealtimeQuotes` / `useCombinedQuotes` are imported by nothing (screens use `useQuoteFeed` directly) | `apps/mobile/src/hooks/useRealtimeQuotes.ts:20,82` — no consumers found |
| `useMarketQuotes`' 1 s poller has no mobile caller, so it costs nothing today | `packages/shared/src/api/hooks.ts:691-699` |
| Metro monorepo wiring is minimal and correct (watches `packages` only) | `apps/mobile/metro.config.js` |

---

## Suggested order of work

| Step | Items | Why first | Diff size |
|---|---|---|---|
| 1 | A1-A5 | Largest perceived-speed win and the smallest change: render from persisted auth, run `/v1/auth/me` once in the background, remove the extra theme frame | small, 3 files |
| 2 | B | Coalesce to one `setFeed` per ~250 ms in `useRegistration`, memo row components | small, 2-3 files |
| 3 | C | Wire `focusManager` to `AppState` and `onlineManager` to the NetInfo already installed | small, 1 file |
| 4 | F | One real `assembleRelease`, then decide whether bundle work is warranted at all | measurement only |
| 5 | D, E | Per-screen cleanups; lowest urgency | mechanical |

Each step is independently shippable. Nothing above was applied.
