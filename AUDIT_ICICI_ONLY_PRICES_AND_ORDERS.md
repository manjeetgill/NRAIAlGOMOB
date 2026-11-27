# ICICI-Only Audit — Live Price Speed and Order Execution Speed

Re-derivation of `AUDIT_LIVE_PRICES_AND_ORDER_SPEED.md` under one added constraint: **ICICI Direct (Breeze)
is the only connected broker and there is no market-data vendor feed.** Nothing in this document assumes
Accelpix/TrueData or Zerodha/Kotak/Angel paths are live.

Date: 2026-11-24. Repository state: `main` at c3082a5 plus uncommitted working-tree changes.

Added on request, and answered area by area in **§8**: *with ICICI connected, which areas should read the stream
instead of polling REST* — including the four transports the backend already exposes and the mobile app does not
use, and the §8.4 list of data Breeze genuinely cannot push.

---

## 0. Method, and what was and was not run

| Item | Status |
|---|---|
| Source read | `mobile-app` (Expo/RN client) and `../backend/python/nraialgo` (FastAPI server + Breeze adapter + execution service), plus `deploy/vps/compose.yaml` and `Dockerfile.api` for what is actually configured |
| Every load-bearing line below | Re-read by me in this session, at the line numbers cited, **after** commits `ef86218` and `b5939b9` landed mid-pass. Where the other writer's commit already fixed one of my findings it is recorded as fixed (§2.9), not re-listed as open |
| Byte-level check | The inlined chart module was compared against the asset it was generated from, unescaping the template literal — equal at 234,410 characters (§2.9 item 5) |
| Typecheck | **Ran three times (14:31, 14:32, 14:33 IST): exit 2 every time.** 2 errors in `algo-lab.tsx` (pre-existing, not from today's commits) and 2 in `spread-builder.tsx` (`isCalendarBasket` is used and never declared — the mobile bundle does not currently build). Full attribution, timestamps and the one runtime bug the errors reveal: §2.10. I fixed nothing |
| Device / emulator run | **None.** No build, no install, no app launch. |
| Network calls | **None.** No endpoint called, no websocket opened, no broker API touched. |
| Orders | **Nothing placed, cancelled, amended, previewed or dry-run.** No execution worker, adapter method or SDK call was invoked. Every order-path claim is a read of source. |
| Secrets | No token, API key, TOTP or session value printed or copied anywhere; config *key names* only. |

Labels: **[V]** = I read the cited line myself this session. **[A]** = attributed from the backend source by a
delegated read and cross-checked against the file, but one step removed. **[D]** = arithmetic or logical
consequence of cited code — a bound, not a measurement.

**Line numbers moved twice during this pass.** `apps/mobile/app/spread-builder.tsx` grew by ~49 lines while this
document was being written, and `apps/mobile/src/components/BasketDesk.tsx` and
`assets/vendor/klinecharts.min.{js→txt}` changed too (none of it mine). Every mobile citation above was
re-read from the tree immediately before writing, so they refer to the tree as of this document; if your
working copy is older, expect the `spread-builder.tsx` offsets to be ~49 lines lower. I did not revert, edit or
stage any of it.

Commands run, all read-only: `ls`, `grep`, `sed -n`, `git status`, `git diff`, a consumer search over
`apps/mobile` + `packages/shared`, and one `python` read of `brokers/streams.py` to count the pre-subscribed
symbol tuple. Nothing was written except this document and the two pointers added to the older documents.

**There are no measured latencies in this document.** Where a number appears it is either a value written in
source (a timeout, a TTL, a batch size, a pacing interval) or `[D]` arithmetic on those values. Nothing here is
a stopwatch result, and nothing here should be read as "prod takes X seconds".

---

## 1. What changes when only ICICI is connected

This is the assumption each earlier finding was written under, and what survives removing it.

| Earlier assumption | ICICI-only reality | Effect |
|---|---|---|
| Ticks arrive from a vendor book; the broker is the secondary/fallback source | There is no vendor book at all: `quote_selection.py:134-142` runs its `book is None` arm **always** | New P0 for prices (§2.2) |
| Equity frames come at a vendor push rate | Breeze frames are `last-trade` event-shaped (`stream_worker.py:439-443`), so the per-instrument floor is ICICI's own print rate | Retracts the "origin cadence" framing (§2.1) |
| Feed freshness is the rate limiter | 0.25 s (`streams.py:843-854`) is a cross-socket coalescer, not a poll and not a floor | Retracted |
| Watchlist/quote reads fan out over 3 providers | Only one provider row exists; the loops are DB reads, not timeouts | Retracted |
| `DAILY_LIMIT = 20000` is the ICICI allowance | It is a log-only constant and disagrees with its own docstring (~5,000) | Retracted |
| Other brokers' placement code is on the order path | One POST, ICICI only (`external_execution.py`, `breeze_connect/config.py:4`) | Simplified (§3.1) |
| Client-side dead routes (`/v1/auth/brokers`, `/v1/orders/broker-live`) | Still dead — and, per a consumer search, the hooks that would call them are **mounted nowhere**, so they cost nothing today either | Holds, downgraded to dormant (§2.4) |
| Client per-frame re-render cascade | Still the client's own cost, and now the *whole* tick load is ICICI's stream | **Holds, and is the main fixable item** |

One consequence worth stating plainly: with no vendor, **ICICI's websocket is both the price source and the
order-notification source** (`streams.py:445` routes `len(key) == 2` entries as order feeds). A single Breeze
session fault is now one failure domain for both screens and orders, where before a vendor could mask it.

And one consequence of the clock: while this document was being written, two commits landed from the other
writer — `ef86218` (chart library inlined) and `b5939b9` (a mobile perf pass over 15 files, 14:10 IST). They
already fix four of the client-side items I had carried forward from `PERFORMANCE_AUDIT.md`, and `b5939b9`
introduces three findings of its own, one of which touches the option-chain path an order reads. All of that is
§2.9; the citations in §2.4 and §3.6 are against the post-commit tree.

---

## 2. Live prices

### 2.1 Where the ticks come from — and the real floor

**[V]** `backend/python/nraialgo/brokers/stream_worker.py:455-457` — the only market-data subscription made
is `subscribe_feeds(stock_token=token)`. The channel is inside the token; `:286` sets `client.interval = ""`.
There is no Breeze "full feed / tick-by-tick / 1-second" mode parameter anywhere on this path. (`MODE_FULL`
at `:223` belongs to the Zerodha worker, which is not in scope.)

**[V]** A *second* socket is opened for order notifications: `:469-474`, `subscribe_feeds(get_order_notification=True)`.

**[V]** Frames arrive demuxed as `kind: "last-trade"` (`stream_worker.py:439-443`), with the exchange timestamp
UTC-corrected at `:112-143`.

**[V]** The only ~1-per-second cadence asserted in this repository is for **indices**, not equities:
`brokers/streams.py:94-97` (with the 18-Nov-2026 note) and `services/market_data/index_recording.py:144`
("An index prints about every second").

**[V]** `streams.py:219` rejects an identical replay; `:208` rejects a frame timestamped more than 5 s in the
future.

**[D] Consequence.** For an individual equity or option, the app cannot display a price faster than ICICI
prints one. Liquid NSE large-caps print often; an illiquid strike can go minutes without a print. So:

- The **first-tick latency** question is only meaningful as *app overhead on top of a print*, and that overhead
  is §2.4.
- `fresh: false` / non-LIVE on a name that has not printed for 15 s is **correct behaviour**, not a defect.
  `quote_selection.py:97` requires `tick and fresh_tick(tick, now) and entry['state'] == 'streaming'`, and
  `services/market_data/freshness.py:67` sets `DEFAULT_LIVE_MAX_AGE_MS = 15_000` (`:68` STALE = 60_000,
  clamped at `:95-101`). **[V]**

If the goal is "prices that visibly move in the chart", the lever is *which instruments are subscribed* and
*how the client handles each frame* — not any interval knob.

### 2.2 P0 — after market close, every ICICI price is forced to STALE

**[V]** `services/quote_selection.py:134-142`:

```python
session = book.session.view(now) if book else freshness.SESSION.view(now)
if chosen and chosen.get('priceSource') in BROKER_PROVIDERS and session.state in {
        freshness.Session.CLOSED, freshness.Session.HOLIDAY, freshness.Session.PRE_MARKET}:
    if chosen.get('fallbackReason') in {'vendor-unavailable-after-close', 'vendor-unavailable-pre-open'}:
        pass
    elif book is None:
        # No vendor: a broker's last observation is display-only, never LIVE.
        chosen = {**chosen, 'priceStatus': 'stale', 'dataStatus': 'STALE', 'fresh': False,
                  'fallbackReason': 'broker-last-observation'}
    else:
        chosen = None
```

Under ICICI-only, `book is None` is the standing condition, so the second arm fires **on every quote, every
read, outside 09:15–15:40 IST**. Two things follow:

1. **LIVE is unreachable after close.** The exemption at `:137` only passes quotes carrying
   `vendor-unavailable-after-close` / `-pre-open`, and those reasons are produced by vendor selection, which
   never runs here. `freshness.py:69` already defines a 30-minute `LAST_CLOSE` window with a matching session
   rule at `:208-221` — but the vendor-less path never reaches it. ICICI's own last print is a valid closing
   observation, and the code knows `LAST_CLOSE` is the right label for it.
2. **`states['market-data']` never exists.** **[V]** `quote_selection.py:123-124` sets it only `if book`. Any
   client or screen that reads a `market-data` state gets nothing, silently, under this deployment.

**Fix shape (not applied):** add a dated-close arm to the `book is None` branch — classify via
`freshness.classify()` (`:224-274`) so a within-30-minutes last print is `LAST_CLOSE` rather than `STALE`, and
leave genuinely old prints as `STALE`. Scope: `quote_selection.py:134-144`. No client change needed; the
client already renders `dataStatus`.

### 2.3 Starting the stream is a 7-condition gate, and cold-start is a download

**[A]** To reach `state == 'streaming'` (which §2.1 shows is required for `fresh`), all of these must hold:
`streams.py:366` entry capacity (`len(self.entries) >= 16` refuses), `:375` `limit = 2000`, `:368-373`
`accountId` present and state `connecting`, a connected provider row (`api/brokers.py:263-297`), a broker
snapshot (`services/broker_snapshots.py:21`, `:43-46`, `:49-61`), and the hub policy
(`quote_selection.py:22-40`: edition, rollout, `NRAIALGO_QUOTE_HUB`).

**[A]** `streams.py:636-685` — `warm_views` deliberately never opens a stream (`:644-647`, `:666-667`). A warm
view is a DB read, not a subscription.

**[A]** A cold *first* subscription is a file download, not a socket open: `SecurityMaster.zip` (cap ~32 MB) →
parse → `BreezeNames` → token mapping (`stream_worker.py:303-407`, coverage guard `:410-411`) → `ws_connect`
(`:445-446`) → `subscribe_feeds`. The repo's own download allowance is 8 s where the SDK default is 60 s. The
client sees **202 "Fetching the first broker snapshot."** — **[V]** `api/brokers.py:240`.

**[A][D] The mitigation that already exists, and works.** `streams.py:36-65` pre-subscribes
`ICICI_CORE_EQUITIES` — **217 symbols**, counted from that tuple — consumed at `:320`, so the instruments the
trader actually looks at are usually already on the socket. And
`services/market_data/index_recording.py:32-35` + `:112-138`
(`keep_streams`, window 09:13–15:31, 30 s, wired at `main.py:180-181`) hold the sockets up even when no client
is attached. So during market hours a mobile open normally lands on an existing entry and only **widens it in
place** (`streams.py:382-409`, `{"add": added}` at `:403`) — which is the cheap path. A restart clears
ticks/depths/instruments (`:433-435`), so the 09:13 rebuild is the one expensive moment per day.

**[V]** There is an ICICI-specific branch making exactly that widen possible — `streams.py:447-449`:

```python
if provider != "icici":
    process.stdin.close()
# ICICI keeps stdin open so extend() can add views without a replacement.
```

So for ICICI the worker process stays writable and a new tab's symbols go through `extend()` instead of a
process replacement. This is why "chart tab opens, prices arrive" is usually fast in this deployment, and it
is the one part of §2.3 that is already tuned for ICICI-only rather than merely surviving it.

**[V]** `streams.py:290` key shape means a per-tab subscription change re-keys the entry, and `:557` backoff is
`min(60, 2 ** min(attempt, 6))`. A refused subscription is not retried by the client
(`packages/shared/src/api/websocket.ts:168-183`), and refusal copy is at `:314-318`. **[D]** That combination —
server backoff up to 60 s + client not retrying a refusal — is why a "prices stuck at the first value" report
is usually a *capacity or session* refusal, not a slow tick.

### 2.4 The client cost per frame (unchanged by ICICI-only, and now the whole price story)

These were the same findings as in `PERFORMANCE_AUDIT.md` §B — the broker constraint does not change them — but
they are now stated against the **post-`b5939b9`** tree, so row 4 is already fixed and §2.9 lists the rest of
what that commit changed. All **[V]**, all mobile-side, all still fixable without touching ICICI.

| # | Where | What happens per frame | Why it matters more here |
|---|---|---|---|
| 1 | `packages/shared/src/api/websocket.ts:119-127` | `snapshotFor` copies **all** published ticks, then filters to the tab's set | With one feed there is one big published set; every subscriber copies the whole thing |
| 2 | `:129-131` | `publish()` iterates every watcher | O(ticks × watchers) |
| 3 | `:288-290` | `setFeed({ ...next, reason })` — a **new object per frame** | Every subscribing screen re-renders per frame, whatever the frame is about |
| 4 | ~~`websocket.ts:280-281` registration key rebuilt per render~~ **fixed today by `b5939b9`** — `:280-281` now `useMemo(() => [...new Set(symbols)].sort(), [symbols])` and `key` memoized **[V]** | was: re-reconciliation on every parent re-render | **gone.** §2.9 records the fix with the rest |
| 5 | `app/(tabs)/portfolio.tsx:128-130`, `app/(tabs)/watchlist.tsx:225-226` | `markPositions` / `markHoldings` / `markWatchlist` memos keyed on `feed.quotes` | The whole list re-derives per frame, including rows whose price did not move |
| 6 | `app/terminal-charts.tsx:138` | `StyleSheet.create` **inside the render body** | Style object rebuilt per re-render — i.e. per frame, per §3 |
| 7 | `app/terminal-charts.tsx:125-126` | `Math.max(...highs)` / `Math.min(...lows)` over the full array, spread | O(n) per frame on a long window |
| 8 | `app/terminal-charts.tsx:100` | `withForming(...)` — intraday window is unbounded (`:107` `useLiveCandles`) | Bounds n for §7 |
| 9 | `src/components/KLineChart.tsx:155`, `:168` | `postMessage(JSON.stringify({ type: "update", data }))` | Full array serialised into the WebView per update, then `applyNewData` at `:118` replaces the whole series rather than patching the last bar |

`packages/shared/src/api/live-candles.ts:226-285` **[V]** already folds ticks incrementally and only moves a
bar when `tickBarInput` finds a usable price — so the chart *data* layer is efficient. The waste is entirely
in §3 (one new object per frame for all subscribers) and §9 (serialise-whole-series into the WebView).

**[V] Dormant traps** — verified by a consumer search across `apps/mobile/app`, `apps/mobile/src` and
`packages/shared/src`, which returned **only** `spread-builder.tsx:213`/`:259` for the order hooks:
`src/hooks/useRealtimeQuotes.ts:20,82` has no consumers; `hooks.ts:691-699` (`useMarketQuotes`, 1 s poll of
`/v1/quotes`), `:586-597` (`useOrderIntents`, 10 s poll of `/v1/orders`) and `:599-610`
(`useBrokerLiveOrders` → `/v1/orders/broker-live`) are all defined and **mounted nowhere**, so none of them
costs anything today. `:603` targets a route that does not exist in the backend, so the moment someone wires
that hook up it becomes a 10 s 404-poller. `hooks.ts:243` calls `/v1/auth/brokers`, also with no handler — the
real ones are `/v1/broker-credentials/status` (`api/brokers.py:621-626`) and `/v1/broker-auth/status`
(`:628-633`), and on non-`hosts_private` editions those are unmounted (`main.py:359-361`, `:441-443`). **[A]**

**[A] ICICI re-auth is not reachable from the app.** The session bound is fail-closed at midnight IST
(`brokers/shared/responses.py:17-28`, `:24`) and there is no automatic re-login; re-authentication is a manual
browser-pasted session token (`api/brokers.py:723-731`). The mobile app has no route for it
(`src/constants/index.ts` contains no `broker-auth/icici/login`). **[D]** So every "prices stopped" incident
after midnight or a session fault ends at the same wall: the trader must use a desktop browser. That is a
product gap, not a performance one, but it is the reason a *speed* complaint recurs.

### 2.5 The REST fallback under ICICI pacing — bounded by design, and slow by design

**[V]** `brokers/shared/watch.py:15-45`: `MAX_WATCH = 50`, `WATCH_READ_PACE_SECONDS = 0.65`,
`WATCH_READ_REQUEST_SECONDS = 0.15`, `PACED_BATCH_SIZE = 5`, and `PACED_WATCH_PROVIDERS = frozenset({"icici"})`
— ICICI *is* the paced provider, and the comment at `:16-21` gives the reason ("Breeze rejects rapid successive
cash reads"). `paced_batch_seconds(5)` = 4 × 0.65 + 5 × 0.15 = **3.35 s per batch of 5 [D]**.
`brokers/icici/watch.py:38` sleeps per symbol with the reason at `:35-36`, one quote call per symbol at `:42`.

**[V] I had this wrong in draft, and the correction matters.** `watch_batch_size(provider, left)` (`watch.py:38-45`)
*shrinks the batch to fit the seconds actually remaining*, and `services/watchlist.py:141-170`
(`read_in_batches`) feeds it a live deadline (`:154 left = deadline_left(deadline)`, `:156 if not size: break`,
`:159 asyncio.wait_for(load_batch(batch), left)`) and keeps whatever arrived (`:145-148`: "Whatever already
arrived is returned; discarding it made every drawer reload from an empty table"). So the paced fallback does
**not** overrun its budget — it returns a partial drawer on purpose.

**[D] What that costs the trader, restated honestly.** With `DRAWER_SEED_BUDGET = 6.0` (`watchlist.py:85`) and
`DRAWER_PRICE_TIMEOUT = 8.0` (`:86`), one 5-symbol batch already spends 3.35 s of a 6 s budget, so a cold
50-symbol drawer advances at roughly **5 symbols per 3.35 s ≈ 1.5 symbols/s** and reaches maybe its second
batch before the deadline. `MAX_WATCH = 50` means it can never be one call for ICICI anyway. The visible
consequence is a drawer that fills in, not one that fails.

So the right framing is: **the REST fallback is correctly paced and correctly bounded; it is simply not a
fast way to price 50 symbols, and it exists only for the case where the websocket is not carrying them.**
Per §2.3, the 217 pre-subscribed names plus in-place `extend()` mean the common path never reaches it. This
replaces my draft's claim that "the fallback cannot finish inside its own window" — it can, because it gives
up early by design. The remaining client-side note is **[V]** `watchlist.py:208-232` `paint()` not cancelling
its underlying work, and `:81`/`:84` `DRAWER_PAINT_SECONDS = 0.35` as what the screen commits to showing.

Also **[V]**: `watchlist.py:853-855` gates `for provider in ("zerodha", "icici", "kotak")` — with only ICICI
connected this is a DB read miss for the other two, costing nothing in time. This is the correction of the
earlier "waits on 3 providers" claim. `:905-910` is a Zerodha fallback that never fires here.
`:53-68` (`socket_tick_current`) is what prefers the stream over all of this.

### 2.6 Option chain freshness, ICICI-only

**[V]** `services/option_chain_service.py`: `STRIP_TTL = 5` (`:74`), `STRIP_REST_SECONDS = 30` (`:77`),
`STRIP_REFILL_AGE = 40` (`:78`), `CHAIN_TTL = 5` (`:79`), `STREAMED_CHAIN_TTL = 30` (`:80`),
`CLOSED_CHAIN_TTL = 60` (`:82`), `CONTRACTS_TTL = 3600` (`:72`). `PROVIDERS = CONNECTED_MARKET_BROKERS`
(`:116-121`) — so this list has exactly one entry in this deployment, which is already correct.

`_strip()` (`:640-699`) is socket-first with `_last_good_strip` (`:693-698`) as the reserve, and
`research_sources` sets `vendors = []` (`:417-456`). **[D]** Under ICICI-only, chain prices inherit §2.1
exactly: an illiquid strike shows its last print, and §2.2 forces STALE after close. "Chain is slow to fill"
here is the REST fallback of §2.5 plus `brokers/runtime.py:128` `timeout = 45` and the 429/503 paths
(`:60-72`, `:100-101`, `:292-295`) — not a client problem.

**[V] But the client changed the request today, and it is the bigger lever here.** `b5939b9` cut the mobile
single-expiry chain read to `window: 30` (`hooks.ts:481`) from `FULL_WINDOW = 400` (`:13`), and raised its
`staleTime` to 60 s (`:490`) with `refetchInterval` 5 s (`:492`). The server's own TTLs are now shorter than the
client's: `STRIP_TTL = 5` (`option_chain_service.py:74`) and `CHAIN_TTL = 5` (`:79`) mean a 5 s client poll is
already re-reading a server copy that is at most 5 s old, so the previous 2 s `staleTime` was mostly spending
requests the server would have answered from cache anyway. **[D]** On that reading the commit's *timing* change
is sound and reduces chain traffic; the **`window: 30` half is the part to review**, because of the shared-key
collision in §2.9 item 1 — fewer strikes is a correctness question for baskets, not a speed question.

### 2.7 Depth

**[V]** `streams.py:704-743`: `equity_depth` returns `None` unless the stream is up, and `:765-791` `depth_note`
supplies the reason. Channels are split: quote token vs depth token with the `.2!` suffix
(`stream_worker.py:353-355`, `:363`, `:402-403`). **[D]** Depth is a separate Breeze subscription, so a screen
that needs a book needs the depth channel *added*, and per §2.3 that is a widen (`streams.py:382-409`), not a
new socket — unless the depth channel was never requested, in which case it is a fresh subscribe and the 202
path again.

### 2.8 Live-price scorecard, ICICI-only

| Stage | Bound in source | Verdict |
|---|---|---|
| ICICI print rate | not in our control; `last-trade` event-shaped | floor — do not promise better |
| Duplicate/replay filter | `streams.py:219`, `:208` | correct |
| Server coalescing | 0.25 s `streams.py:843-854` | not a delay, not a limit |
| `fresh` gate | 15 s + `streaming` `quote_selection.py:97`, `freshness.py:67` | correct, and correctly shows stale illiquid names |
| Post-close classification | forced STALE `quote_selection.py:139-142` | **P0 defect** |
| Stream start gate | 7 conditions, `warm_views` never subscribes | by design; capacity refusal copy is client-side `websocket.ts:314-318` |
| First cold subscribe | SecurityMaster download + parse + map | day's one expensive moment; `keep_streams` covers market hours |
| REST fallback | 0.65 s/symbol, batch 5 ≈ 3.35 s/batch (`watch.py:15-45`), batch size shrinks to the live deadline (`watchlist.py:154-159`) | bounded by design; ≈1.5 symbols/s, so a cold drawer fills in rather than fails |
| Client per frame | new object + full snapshot copy + memo re-derive | **P1 — the only part we own** |
| Chart paint | `KLineChart.tsx:155` full-array `postMessage`, `:118` `applyNewData` | **P1** |
| ICICI re-auth from mobile | route absent | product gap, causes recurrence of "prices stopped" |

### 2.9 Commits that landed while this audit ran — what they fixed, and what they introduced

Two commits arrived between my reads, neither of them mine: **`ef86218` "fix(mobile): inline klinecharts
library to fix asset loading"** and **`b5939b9` "perf: optimize mobile app performance, option chain loading,
cold start, and lifecycle management"** (14:10 IST today, 15 files). I record them because they invalidate part
of §2.4 and of `PERFORMANCE_AUDIT.md`, and because `b5939b9` introduces three findings this document did not
have an hour ago.

**Fixed, verified in the current tree:**

| Earlier finding | Now | Evidence |
|---|---|---|
| `initializeQueryClient()` awaits `initializeApiClient()` a second time, so cold start pays `/v1/auth/me` twice | The second await is gone — the function body is now only a comment | `apps/mobile/src/utils/queryClient.ts:53-56` **[V]** |
| Cold start pays `/v1/auth/me` more than once from any caller | Single-flighted: `initInFlight` returns the in-flight promise | `apps/mobile/src/utils/apiClient.ts:80-98` **[V]** |
| No AppState / NetInfo wiring | Both wired: `onlineManager.setEventListener` with NetInfo at module scope, `AppState` → `focusManager.setFocused` | `queryClient.ts:15-19`, `:21-28` **[V]** (see item 3 — the focus half is inert) |
| `useRegistration` rebuilt `ids`/`key` per render | Both memoized | `websocket.ts:280-281` **[V]** |
| The chart library was read from an asset at runtime (`downloadAsync` → `readAsStringAsync`) — my `PERFORMANCE_AUDIT.md` §E | Replaced by a generated module: `KLINECHARTS_LIB` imported at `KLineChart.tsx:15` and interpolated into the HTML at `:41`. The asset I/O and the WebView-network failure mode are gone | `apps/mobile/src/components/klinecharts_lib.ts` (234,695 B, generated by `scripts/build_klinecharts_lib.js`), `apps/mobile/assets/vendor/klinecharts.min.txt` still present but unreferenced by the component **[V]** |

**New in `b5939b9`, and load-bearing for this audit:**

1. **[V] The option-chain cache key now holds two different window sizes.** `hooks.ts:481` changed the mobile
   single-expiry read from `window: FULL_WINDOW` to **`window: 30`**, while `useOptionChains` at `:509` still
   requests **`window: FULL_WINDOW`** — where `FULL_WINDOW = 400` (`hooks.ts:13`). Both use the *same* key,
   `queryKeys.optionChain.chain(underlying, expiry)`, and the comment at `:466` says that sharing is deliberate.
   Worse, `:483-485` now **cross-seeds**: after an unasked read it writes the 30-window payload under
   `chain(underlying, data.expiry)` — a key the ladder treats as its own. `useOptionChains` then has
   `staleTime: 60 * 1000` (`:512`) and, per `:501-502`, "deliberately do not re-poll". So a ladder entry that
   gets its first data from the 30-window cross-seed is fresh for 60 s and never re-fetched, and it is short by
   ~370 strikes. **[D]** The consumers of that ladder are `spread-builder.tsx:277` (`offDates` — the extra
   expiries a multi-date basket needs) and `BasketDesk.tsx:268`. Since `send()` resolves each leg against the
   ladder of the expiry it is sent with (`spread-builder.tsx:661-662`), a truncated strip is an **order-path**
   risk, not only a display one: the strike a trader wants may simply not be in the payload. I did not run it,
   so this is stated as the mechanism, not as an observed truncation. The one-line check is whether the desk's
   strike list can show a strike outside ±30 of ATM after the cross-seed has fired.
2. **[V] `staleTime: 60 * 1000` on the chain the spread builder reads** (`hooks.ts:490`, was 2 s), with
   `refetchInterval` 5 s (`:492`, was 3 s). **[D]** Under ICICI-only this interacts with §2.1: a chain opened
   from a warm cache can be up to 60 s old on first paint, so the *strikes* a trader marks to close can carry a
   minute-old price. That is fine for display and correct for the draft path (order pricing re-reads its own
   quotes — `spread-builder.tsx:655-659` refuses any leg with no broker price), but it means the numbers on the
   basket screen are older than they were before this commit, and the on-screen price is *not* the price the
   order will use.
3. **[V] The AppState wiring cannot do the thing it was written for.** `queryClient.ts:37` still sets
   `refetchOnWindowFocus: false`, and `focusManager.setFocused` only drives *focus* refetches. **[D]** So
   `onAppStateChange` (`:22-26`) changes a flag that no query consults, and background polling is not actually
   paused by it — pausing happens only through `onlineManager`/reconnect (`:38 refetchOnReconnect: true`). The
   commit message claims "lifecycle management"; the mechanism present is connectivity, not focus. (Also
   `:17` uses `state.isConnected`, which on iOS is a network-reachability signal, not an internet-reachability
   one — `isInternetReachable` is the stricter field.) Not a regression, but it should not be counted as done.
4. **[V] Minor:** `queryClient.ts:28` registers `AppState.addEventListener` at module scope with no removal;
   harmless for a singleton, but it means the listener exists before any screen mounts and survives every later
   mount.
5. **[V] The inlined chart library has no freshness guard, and it is byte-correct only by luck of this hour.**
   I generated-from-source compared the two files: `klinecharts_lib.ts`'s template literal, after undoing the
   escaping, is **exactly equal** to `assets/vendor/klinecharts.min.txt` (234,410 characters; the `.txt` is
   234,469 *bytes* because of multi-byte characters). So today there is no drift. But
   `apps/mobile/scripts/build_klinecharts_lib.js` is wired to **nothing** — `apps/mobile/package.json:11`
   `"prebuild": "expo prebuild"` is Expo's own, not this script, and there is no postinstall — and
   `assets/vendor/klinecharts.min.txt` is now referenced by no component. **[D]** So the file that used to be
   the source of truth is a decoy: someone updating the `.txt` gets a silently unchanged app, and the 234 KB
   that ships is whatever was last generated by hand. The generator's own header is also misleading —
   `build_klinecharts_lib.js:17` prints `content.length`, a character count, labelled "bytes", which is why the
   header says 234410 for a 234469-byte file.

**What this does not change:** everything in §3 (all of it backend), §2.1, §2.2, §2.3, §2.5 and §2.7. The
post-close STALE demotion, the `unknown`-on-expired-session classification and the cold-master question are all
untouched by these commits — none of the 15 files is a backend file.

### 2.10 Typecheck, run three times in this pass — the mobile workspace is currently red

**[V] Runs, commands, timestamps (IST, 2026-11-24), all on the live tree:**

| Time | Command | Exit | Errors |
|---|---|---|---|
| 14:31 | `npm run typecheck` (root) | 2 | 2 — `algo-lab.tsx:57`, `:58` |
| 14:32 | `npx tsc --noEmit -p apps/mobile/tsconfig.json` | 2 | 4 — the two above **plus** `spread-builder.tsx:582`, `:594` |
| 14:33 | same, re-run to check it was not a torn read | 2 | 4 — identical |

**[V] What the two new errors are.** `apps/mobile/app/spread-builder.tsx:582` and `:594` reference
`isCalendarBasket`, and grep across `apps/mobile` + `packages/shared/src` finds **no declaration of it
anywhere** — only those two uses. That is an undefined identifier in the basket screen, i.e. the file that holds
`send()` (§3.6), so the mobile bundle cannot build as it stands.

**[V] And it is not mine, and it is probably in flight.** `spread-builder.tsx` was written at **14:32:30** — 47
seconds before my first grep of it — and `git status` now shows the other writer's working-tree edits to
`(tabs)/orders.tsx`, `(tabs)/watchlist.tsx`, `algo-lab.tsx`, `spread-builder.tsx` and `trade-history.tsx`,
none of which were modified when this audit began. So I am reporting a transient mid-edit state, not a merged
defect, and **I touched none of it** — my only writes in this repository are the `.md` files, all still
untracked.

**[V] Attribution of the `algo-lab.tsx` pair, which is not mid-edit.** `b5939b9` did not touch either hook it
calls — filtering that commit's `hooks.ts` diff for `useFleet` / `useOpenPositions` returns nothing — and
`algo-lab.tsx` was last committed in `14a60ca`, the initial import. `npx tsc --version` is 5.9.3. **[D]** So
those two predate today's commits. One claim I will not paper over: an earlier session of this same audit
recorded "`npx tsc --noEmit -p apps/mobile/tsconfig.json` | exit 0 (clean)" — the exact command I just ran three
times for exit 2. Either the tree moved underneath it (most likely, given the writer is live in these files) or
that reading was scoped differently. Read `PERFORMANCE_AUDIT.md` §A/§B as written against a tree whose mobile
typecheck cannot currently be reproduced as green.

**[V] The finding the second error points at — a real, if small, always-on request, independent of the build
state.** `packages/shared/src/api/hooks.ts:341` declares `useOpenPositions(options?)` — **one** parameter — and
spreads it at `:348`. `apps/mobile/app/algo-lab.tsx:58` calls it as
`useOpenPositions(undefined, { enabled: activeTab === "risk" })`. TypeScript rejects the arity, and at runtime the
extra object is simply **ignored**, so `enabled` never reaches the query. `useOpenPositions` polls with
`refetchInterval: 5 * 1000` (`:347`), and each poll reads `/v1/broker-auth/icici/account` (`:345`, projected into
positions by `iciciOpenPositions`). **[D]** Therefore the Algo Lab screen keeps a 5-second positions poll alive
on every tab of that screen, not just when Risk is shown. The fix is one argument move:
`useOpenPositions({ enabled: activeTab === "risk" })`.

`useFleet` at `:57` passes a single argument and behaves as intended; its error is type-level (`queryKey` is
structurally required in the exposed option type at `hooks.ts:765`, so no caller can name it) — a signature
smell, not a runtime bug.

---

## 3. Order execution

### 3.1 One manual order is exactly one authenticated HTTP call

**[A][V]** The ICICI placement is a single `POST` to
`https://api.icicidirect.com/breezeapi/api/v1/order` (`breeze_connect/config.py:4`, `:42`; call site
`breeze_connect/breeze_connect.py:2199`). Account binding, envelope, contracts and arguments add **0
authenticated HTTP calls**: `brokers/shared/external_execution.py:75-91` overrides the funds/margin reads that
`brokers/shared/execution_policy.py:231-245` would otherwise make, and the docstring at `:79-82` says so
explicitly ("verify identity without making redundant remote HTTP funds queries during order
placement/lookup/cancellation").

**[V]** Broker-first placement does no app-side verification at all — `execution/worker.py:440-446`: "The broker
decides whether it accepts the order's funds, margin and market constraints", with `evidence = {'accountId':
..., 'brokerFirst': True}` and no lookup.

**[A]** The margin calculator is preview-only and is where ICICI's 0.75 s pacing and 6 s read timeout apply
(`brokers/icici/transport.py`, `brokers/icici/budget.py`). **[V]** `brokers/icici/budget.py` never refuses a
*write* — so the REST budget is not an order-path throttle. This retracts the earlier claim that
`DAILY_LIMIT = 20000` caps placements; that constant is log-only and contradicts its own docstring (~5,000).

**[D]** Therefore: for a warm session and a warm instrument master, the broker's own share of order latency is
one HTTPS round-trip, and **nothing in the client or the app's DB layer dominates it.** Everything in §3.2–§3.4
is either (a) a path that adds calls, or (b) a path that makes the *confirmation* slow rather than the send.

### 3.2 P0 — an expired ICICI session is provably not sent, and is recorded as `unknown`

This is the most consequential ICICI-only finding, because the session is the failure mode that actually
occurs (midnight-IST fail-closed bound, manual re-auth, no mobile route).

**[V]** `brokers/registry.py:63-66`:

```python
if not isinstance(payload, dict) or not isinstance(payload.get("session"), dict):
    raise BrokerFailure("BROKER_SESSION_EXPIRED")
if moment(payload["session"].get("expiresAt")) <= datetime.now(UTC):
    raise BrokerFailure("BROKER_SESSION_EXPIRED")
```

This raises **before** `adapter_class(...)` at `:67` and before any HTTP — 0 calls, 0 seconds, and a certainty:
ICICI never saw this order.

**[V]** `execution/worker.py:460-469` then catches it as if it were uncertainty:

```python
result = await self.sdk(intent['provider'], 'execution_place', credentials, payload,
                        timeout=_place_timeout(intent['provider']))
except (BrokerFailure, TimeoutError) as error:
    code = failure_code(error)
    result = {'state': 'unknown', 'message': 'Broker acceptance is uncertain; this command will not be sent again.', ...}
```

**[V][D] What `unknown` costs**, from `execution/repository.py` and `execution/models.py`:

| Effect | Evidence |
|---|---|
| Retaining the lock on `unknown` is **deliberate** | `models.py:23-25`: "Unknown deliberately retains its account lock and margin reservation." / `ACTIVE_INTENTS = frozenset({'queued','working','unknown'})` **[V]** |
| The account head stays claimed by it | `repository.py:1027` counts `status IN ('queued','working','unknown')` as "behind" for other intents **[V]** |
| `active_intent` is released only in the expire path | `repository.py:1037`, reached only by `expire_unstarted` **[V]** |
| `expire_unstarted` cannot reach it | `repository.py:1029` selects `i.status='queued'`, and `:1030` requires `NOT EXISTS(leg.state != 'queued')` — this leg was dispatched **[V]** |
| Margin reservation is held | `repository.py:726-734`, `:494-503` **[A]** |
| It retries until escalation | 30 s cadence, `needs_manual` after ~6 attempts **[A]** |
| The right message already exists | `errors.py:20`: `'BROKER_SESSION_EXPIRED': 'The broker session expired. Reconnect before submitting.'` **[V]** |

**[D] So this is not a bug in the quarantine — it is a bug in the classification.** Keeping the lock and the
margin on a genuinely uncertain order is the correct, documented design: the engine must not free exposure it
cannot account for. The defect is that `worker.py:465-469` applies that treatment to a case that is *not*
uncertain. `registry.py:63-66` raises before the adapter is even constructed (`adapter_class(...)` is `:67`),
so at that moment the process has provable knowledge that no request was made — and it discards that knowledge
by merging it into the same `except (BrokerFailure, TimeoutError)` arm as a real transport timeout.

The trader's experience of that merge: a fact with one answer ("nothing was sent; reconnect") becomes ~3
minutes of an account locked behind an order that never existed, reserved margin that will not release, then a
human-only clear. And the natural recovery — reconnect, then send again — is the action that later shows a
stuck order the trader cannot cancel.

**[D] Fix shape (not applied):** in `worker.py:465-469`, separate failures raised *before* the SDK call was
entered from failures that could have happened after. `BROKER_SESSION_EXPIRED` and the other pre-flight codes
from `registry.py:57-66` are deterministic refusals: map them to `rejected` with `errors.py:20`'s text, release
the account and reservation through the existing reject path (`:475-476` already skips queued legs on
`rejected`), and leave `unknown` — and its deliberate lock — for genuine `TimeoutError`/transport uncertainty.
The distinction is available at the raise site, so this needs no new state and no change to `models.py`.

### 3.3 A cold ICICI option master exceeds the whole place budget — and what actually guards it

**[V]** `execution/worker.py:63-72` states the failure in the repo's own words:

> "When today's file is missing, the place call has to rebuild it first: the NFO list (about 85,000 contracts)
> takes longer than the whole 30 s place budget on the server, so the call was cut off before the order reached
> ICICI, and the half-built file was never saved, so every later option order did the same (5 Nov 2026)."

`_place_timeout('icici')` is 30 s (`:58`, `:55-60`) — **[V]** the ceiling it exceeds.

**[V] The guard exists, and it is wired — my draft said otherwise and was wrong.** Four things, each checked:

| Question | Answer | Evidence |
|---|---|---|
| Is the cache directory configured in production? | **Yes** — `NRAIALGO_INSTRUMENT_CACHE_DIR: /data/instruments` on all four app services | `deploy/vps/compose.yaml:81`, `:126`, `:172`, `:206` |
| Does it survive a redeploy? | **Yes** — named volume `instruments` (`:318`) mounted at `/data/instruments` on each service (`:93`, `:137`, `:183`, `:219`) | `deploy/vps/compose.yaml` |
| Is `warm_icici_masters()` ever called? | **Yes** — from `prewarm()`, a 60 s loop that builds NFO+NSE once per IST day and logs `execution_masters_ready NFO=… NSE=…` | `worker.py:643-673`, call at `:656`, cadence at `:671`, log at `:658` |
| Do the warm-up and the placement read the **same** file? | **Yes.** Warm uses `InstrumentCache(Path(dir)/'icici')` (`worker.py:78`); ICICI placement uses `InstrumentCache(Path(dir)/self.provider)` (`external_execution.py:71-72`) → identical path. `InstrumentCache` adds no provider level of its own — its filename is `zerodha-v1-{exchange}.json` whatever the provider (`instrument_cache.py:56`) | **[V]** |

So my draft's claims "the builder is inert without configuration" and "the two masters live in different
directories" are both **retracted** — see §4. The odd filename prefix (`zerodha-v1-` on ICICI data) is a naming
artifact, not a bug: separation comes entirely from the directory.

**[D] What is left, and it is the real exposure.** `prewarm()` picks its work at `worker.py:652`:

```python
rows = await store.rows("SELECT workspace_id FROM live_trading WHERE provider='icici' AND enabled")
today = datetime.now(IST).date()
if rows and masters_day != today:
```

The master build is gated on there being **at least one workspace with `live_trading` armed for ICICI** — the
autopilot/live switch (`execution/live_switch.py:39`, `api/live_trading.py`). Broker-first manual placement
(§3.1) does not require that switch. So:

- If nobody has `live_trading.enabled = true` for ICICI, `rows` is empty, the masters are never warmed that day,
  and the **first ICICI option order of the day rebuilds 85,000 contracts inside its own 30 s budget** — the
  5 Nov failure, unchanged. Later orders are fine because the successful rebuild does save the file.
- `:659-660` swallows any exception and only logs `execution_masters_unavailable`, retrying on the next 60 s
  pass; if the build always throws, the order path pays the rebuild on **every** option order.

**[D] Two read-only checks decide this, and neither is something I ran.** (1) Does
`SELECT workspace_id, enabled FROM live_trading WHERE provider='icici'` return an enabled row for the
workspaces that actually trade options by hand? (2) Does the execution worker's log contain
`execution_masters_ready` for today, and with what counts? A `ready` line with `NFO=0`-ish or a day of
`execution_masters_unavailable` is the same hole as an empty `rows`. If both come back clean, ICICI option
placement is warm and this whole section is moot — which is the outcome I would expect from the compose file,
and precisely why it is worth 60 seconds of log-reading instead of code changes.

### 3.4 Confirmation: the send is fast; the first *evidence* is delayed by our own re-check

**[A][V]** There **is** a real ICICI order-notification websocket: `breeze_connect/breeze_connect.py:402-407`
(`livefeeds.icicidirect.com`), demuxed through the same `on_ticks` handler, routed to
`streams.py:445` (`orderNotifications: len(key) == 2`). It is used only as a **wake-up**, throttled to 1/s with
`wake_from_stream` (`streams.py:512-518`). **[D]** So a fill hint can start a lookup early, but it is not a
state source, and its throttle is a reason two rapid fills can collapse into one wake.

**[V]** The immediate post-ACK status read is not part of broker-first: `worker.py:473-474` — "No immediate
status lookup here: the accepted order releases the account (`repository.release`) and fills arrive from stream
hints or the next check." (Also `:356`, `:424-433` on the non-broker-first branch.)

**[D] Derived timeline, single-leg, warm everything.** Times are bounds derived from constants, not
measurements:

| t | Event | Source |
|---|---|---|
| 0 | Press → 1 POST to the app → **202** accepted | `execution/api.py:130`, `:275-286` **[A]** |
| ~0 | Client already off the send path; it holds `clientId` | `spread-builder.tsx:692` **[V]**; the cash ticket awaits and returns `useOrderTicket.tsx:196` **[V]** |
| ≥0 | Worker claims via `pg_notify`/`LISTEN` wake or the 30 s sweep | `execution/wakeups.py:12-35`, `:42` **[A]** |
| ≥0 | `FOR UPDATE SKIP LOCKED`, 120 s lease | `repository.py:131-138`, `:159-176` **[A]** |
| +1 HTTPS round-trip | Broker ACK | §3.1 |
| **+~3 s** | Next single-leg re-check (unless a hint woke it first) | `worker.py` re-check cadence **[A]** |
| +up to 15 s | `execution_lookup` — 1 GET order, +1 GET trades when filled, holding the per-account warm lock | `brokers/icici/reads.py:111`, `:129-150`; `warm_reader.py:235`, `:240-248`, `:66` **[A]** |
| +1 s **or** +5 s | Basket: `useOrderSnapshot` poll. Cash/equity: no per-order poll — the Orders tab re-reads the broker's own order list from the server's cached account copy | `hooks.ts:646-649` **[V]**; `hooks.ts:355-363` `refetchInterval: 5 * 1000` **[V]**; `app/(tabs)/orders.tsx:80`, `:83` `iciciOrders(iciciAccount)` **[V]** |

**[D] Conclusion.** The trader's "confirmed" time is set by **our re-check delay + our own lookup budget + the
client's 1 s (basket) or 5 s (cash) poll**, not by ICICI. The one HTTPS call that matters is the fastest stage
in the chain. Two independent levers, neither in the client: the post-ACK observation (`worker.py:473-474`) and
the `execution_lookup` budget — and §3.2's head-of-line note: **[A]** `brokers/runtime.py:188-191` charges the
*wait for the warm lock* against the same 30 s ceiling, so a 15 s lookup ahead of you pushes the next place
toward its budget. The 1 s DB write pacing is bypassed in broker-first (`repository.py:777`) **[A]**.

**[V] Worth stating because it matches how the app should work:** the Orders tab is not an app-local history.
`orders.tsx:83` renders `iciciOrders(iciciAccount)` — ICICI's own order list, via a poll of the server's cached
copy, and the comment at `hooks.ts:352-354` is explicit that it is "not another broker call". So the 5 s figure
buys broker-truth display, which is the correct trade.

**[A]** `streams.py:559-591` `watch_feed_reconciliation` (poll 1.0 s, `give_up` 300.0 s at `:577`) unblocks a
*screen* waiting on a feed; it is not an order reconciler. Do not expect it to explain an order state.

### 3.5 Misdiagnosis risk: two refusals that did not come from ICICI

**[V]** `external_execution.py:31-50` `broker_refusal` decides "ICICI rejected this order" purely from response
shape — non-200 `Status` plus a string `Error` and a falsy `Success`. It also scrubs token-shaped text (`:28`,
`:47`) and caps the reason at 200 chars (`:48`). That is sound for real refusals, and its docstring explains
why it exists.

**[D]** Two non-ICICI responses share that shape:
1. `SESSIONKEY_EXPIRED` — the expired-session case of §3.2, when it arrives as a response rather than a
   pre-flight raise. Reporting it as "ICICI rejected this order: …" sends the trader to fix an order problem
   they do not have.
2. The SDK's locally synthesised `{"Success": "", "Status": 500}` for client-side argument validation
   (`breeze_connect/breeze_connect.py`), which never reaches the network at all.

Both would be classified as a broker refusal. Worth one arm: if the scrubbed reason matches a session-key
shape, use `errors.py:20`'s reconnect text instead of "ICICI rejected this order".

### 3.6 The client's own two send paths

**[V] Equity / cash** — `packages/shared/src/hooks/useOrderTicket.tsx:178` payload, `:196` a single
`await placeOrder(payload)`. **[D]** One round-trip, correct. The gap is that the cash ticket does not mount
`useOrderSnapshot` (`packages/shared/src/api/hooks.ts:640-651`, `staleTime: 0` at `:645`, 1 s while any leg is
unsettled at `:646-649`, and it stops by itself once landed — the comment at `:636-638` says a finished trade
"never keeps the phone polling prod"). Instead the Orders tab picks the order up through its 5 s poll of the
broker's own list (`hooks.ts:355-363`, `orders.tsx:80`, `:83`). **[D]** That is a defensible design — broker
truth, cached server-side, one extra request per 5 s — so the cash path is **not** the cheap client fix I first
listed it as; the lever for its tail is §3.4's server-side re-check, not the client.

**[V] Basket / spread** — `apps/mobile/app/spread-builder.tsx:646-707` (`send`): after the guards, **two serial
round-trips per press**: `createDrafts` at `:682` then `placeOrder` at `:684`, and `setSentId(receipt.clientId)`
at `:692`. The `useOrderSnapshot(sentId, sentId !== "")` poll *is* wired here (`:259`), and a receipt for a
basket that changed mid-send is deliberately suppressed (`:694-696`).

> Note: `spread-builder.tsx` moved under me during this pass — the same block was at `:597-658` an hour
> earlier. Re-verified at `:646-707` immediately before writing this; if you read a stale copy of the file, the
> offsets differ by ~49 lines.

**[D][V] The mismatch to fix.** The client aborts at 30 s (`packages/shared/src/api/client.ts:66`
`timeout = 30_000` → `:69` `controller.abort()`, mapped to 408 at `:137-138`), while the SDK-call ceiling is
45 s (`brokers/runtime.py:128` — `async def call_sdk(..., timeout=45, ...)` **[V]**; semaphores at `:60-72`,
`:100-101`). If §3.3's master is cold, the drafts call is the one that runs long: **the client gives up 15 s
before the server's own budget expires**, and the drafts call may still commit server-side after the abort. The
error copy already handles this honestly — `spread-builder.tsx:698-703` splits "a refusal (nothing was sent)"
from "a lost answer (may still reach the broker; do not send again, check Orders)" using
`refused = typeof error?.status === 'number'` at `:702`. That copy is right; the timeout is the wrong number.
Either raise the drafts timeout above 45 s or make the two round-trips one.

**[V] Re-send safety on screen** — guards before any send: no chain answer (`:647`), no legs (`:648`), nothing
in the plan (`:649-652`), >8 legs refused client-side (`:653`), no connected account (`:654`), unpriced leg
(`:655-659`). `referenceFor(basketKey)` is captured *before* the first await (`:676`), which is what keeps an
edit-during-send from shipping old contracts under a new reference.

### 3.7 Multi-leg baskets, ICICI-only

**[V]** `worker.py:478` `place_broker_first_batch` — "Persist every independent long-leg marker before parallel
broker sends." **[A]** Each leg is its own single POST (§3.1), in parallel, so a basket's broker-side cost is
not serial; the earlier "multi-leg gets 1.1–1.5 s" figure was a multi-broker artefact and is retracted.
`:475-476` skips the remaining queued legs the moment one is rejected.

---

## 4. CORRECTIONS — findings from the earlier documents that the ICICI-only constraint invalidates

Retracted here explicitly so nothing below is quoted from the wrong document.

| Retracted claim | Where it was published | Why it is wrong | What replaces it |
|---|---|---|---|
| "0.25 s is the effective quote rate limit / floor" | `AUDIT_LIVE_PRICES_AND_ORDER_SPEED.md` §1 | `streams.py:843-854` is a projection cache shared between sockets | §2.1: the floor is ICICI's per-instrument print rate |
| "LIVE is reachable after close via the vendor fallback" | same doc §1 | With `book is None`, `quote_selection.py:139-142` always demotes | §2.2 — this is now a P0 **defect**, not a fallback |
| "Watchlist and quote reads pay for 3 providers" | same doc §1, `PERFORMANCE_AUDIT.md` §B-adjacent | `watchlist.py:853-855` loops `"zerodha","icici","kotak"` — a DB read miss, not a timeout | §2.5: cost is ICICI's 0.65 s pacing only |
| "Up to 3 `display_snapshot` calls per watchlist read" | same doc | 1 connected provider | drop |
| "`DAILY_LIMIT = 20000` is the ICICI allowance that throttles orders" | same doc §2 | `budget.py:12-16` is log-only and contradicts its own docstring (~5,000); writes are never refused | §3.1 |
| "Multi-leg placement gets 1.1–1.5 s per leg" | same doc §2 | derived from other brokers' pacing | §3.7: parallel, 1 POST per leg |
| "1 s/account write pacing applies to placement" | same doc §2 | bypassed in broker-first, `repository.py:777` | §3.4 |
| "An immediate post-ACK observation exists" | same doc §2 | `worker.py:473-474` says explicitly there is none in broker-first | §3.4 |
| "Zerodha `write_failure` / `ExecutionPolicy.place` are on the ICICI path" | same doc §2 | ICICI uses `ExternalExecutionAdapter`, which overrides those reads (`external_execution.py:75-91`) | §3.1, §3.5 |
| "`MODE_FULL` feed mode governs our tick density" | same doc §1 | `stream_worker.py:223` is Zerodha; Breeze is token-only, `:286`, `:455-457` | §2.1 |
| "The REST watchlist fallback cannot finish inside its own budget" (my own draft of this document, §2.5) | this doc, first draft | `watch_batch_size(provider, left)` shrinks the batch to the live deadline and `read_in_batches` keeps partial results — overrunning is prevented by design | §2.5: bounded, ~1.5 symbols/s, fills in progressively |
| "The cash ticket's confirmation rides a 10 s intents poll, so mounting the snapshot is the cheap fix" | this doc, first draft | `useOrderIntents` (`hooks.ts:586-597`) has **no consumer**; the Orders tab reads the broker's own list on a 5 s poll of the cached copy (`:355-363`, `orders.tsx:83`) | §3.4 / §3.6: the cash path is broker-truth by design; the lever is the server's re-check (§3.4), not the client |
| "`ICICI_CORE_EQUITIES` is ~208 names" | this doc, first draft | counted from the tuple at `streams.py:36-65` | **217** names, consumed at `:320` |
| "`useRegistration` rebuilds the subscription key every render" | this doc §2.4 row 4, and `PERFORMANCE_AUDIT.md` §B | **fixed while this audit ran** — `b5939b9` memoized both `ids` and `key` (`websocket.ts:280-281`) | §2.9 item table; the remaining client items are rows 1-3 and 5-9 |
| "Cold start pays `/v1/auth/me` twice (`initializeQueryClient` awaits `initializeApiClient`)" | `PERFORMANCE_AUDIT.md` §A | **fixed by `b5939b9`** — the await was deleted and the init is single-flighted | §2.9 |
| "No AppState/NetInfo wiring (`focusManager`/`onlineManager` unwired)" | `PERFORMANCE_AUDIT.md` §C | **partly fixed** — both are now wired, but `refetchOnWindowFocus: false` makes the focus half inert | §2.9 item 3 |
| "The chart library is re-downloaded/re-read from an asset per mount (`KLineChart.tsx:41-45`)" | this doc §2.4 row 9, and `PERFORMANCE_AUDIT.md` §E | **superseded by `ef86218`** — the library is now an inlined module (`KLineChart.tsx:15`, `:41`); asset I/O gone, but the `.txt` is unreferenced and the generator is unwired | §2.9 item 5, and §2.4 row 9 still stands for `postMessage` |
| "`warm_icici_masters()` is a no-op unless `NRAIALGO_INSTRUMENT_CACHE_DIR` is set, so prod may be unset" | this doc, first draft §3.3 | **the variable is set** in all four services (`compose.yaml:81`, `:126`, `:172`, `:206`) on a named volume (`:318`), and the function **is** called daily from `prewarm()` (`worker.py:656`) | §3.3 — the open question is the `live_trading` gate at `:652`, not the config |
| "The chain master and the order master live in different directories and do not share parsed rows" | this doc, first draft §3.3 | both resolve to `<dir>/icici/` (`worker.py:78`, `external_execution.py:71-72`), and `InstrumentCache` adds no provider level of its own (`instrument_cache.py:42`, `:56`) | §3.3 — retracted; only the `zerodha-v1-` filename prefix is misleading |
| "Vendor feeds (Accelpix/TrueData) explain freshness gaps" | both docs | no vendor configured | §2.2, §2.6 |
| "`useMarketQuotes` / `useBrokerLiveOrders` / `/v1/auth/brokers` are dead routes" | `PERFORMANCE_AUDIT.md` | **unaffected** by the broker constraint | §2.4 — still holds |
| Client per-frame re-render cascade, `StyleSheet.create`-per-render, WebView full-array `postMessage` | `PERFORMANCE_AUDIT.md` §B, `AUDIT_LIVE_PRICES_AND_ORDER_SPEED.md` §1 | client-side; the broker does not change them | §2.4 — still holds, and is now the primary fixable item |

---

## 5. Duplicate-order safety — what was proven, and what was not

Required proof, because the standing rule is that nothing may be placed except on the trader's explicit
command. **[A][V]**, all from source:

1. There are exactly **two** call sites that send a placement: `worker.py:415` (single-leg) and `worker.py:463`
   (broker-first), plus the parallel batch at `:478`. No third path exists.
2. The command is fenced **before** the send: `repository.dispatch()` at `worker.py:448` returns nothing if the
   marker is already taken (`:450-451`), and `repository.py:738-739`, `:768` enforce one active intent per
   account head.
3. Claims are `FOR UPDATE SKIP LOCKED` (`repository.py:131-138`, `:159-176`), so two workers cannot take the
   same leg.
4. A leg's state machine has no edge that re-enters "send" after "unknown": `models.py:99-126`, `:129-140`, and
   `next_leg` gating.
5. "Send once, never retry" is written into the uncertain branch itself: `worker.py:468`,
   `external_execution.py:112-117` and `execution_policy.py:3-4`, `:930`.
6. Recovery and reconcile read; they do not place (`execution/recovery.py`, `repository.py:878-882`, `:933-936`).
7. Cancellation and `/stuck` (`api.py:302-337`, `controls.py:21-22`, `:41`) never call `execution_place`.
8. **In this audit session, zero** HTTP requests, SDK methods, adapter calls, worker starts or CLI invocations
   were executed. Nothing was placed, cancelled, amended, previewed or dry-run — not once, because the
   opportunity was never taken.

What is **not** proven by this document: that a *lost client abort* cannot leave a committed drafts call (§3.6) —
that is a real window, and the client copy at `spread-builder.tsx:698-703` handles it by telling the trader not
to re-send. Fixing the 30 s vs 45 s mismatch closes it.

---

## 6. Priority, ICICI-only

| # | Change | Where | Why this rank | Risk to leave |
|---|---|---|---|---|
| 0 | Confirm the mobile workspace builds before acting on anything below — `isCalendarBasket` at `spread-builder.tsx:582`, `:594` has no declaration anywhere in the repo | `apps/mobile/app/spread-builder.tsx:582`, `:594`; `npx tsc --noEmit -p apps/mobile/tsconfig.json` → exit 2 (§2.10) | The basket send path (§3.6) is the file being edited, and it is the one an order actually leaves from. Nothing else on this list is testable while the bundle cannot build. **This may already be in hand** — the file was written 47 s before my first read, and I changed none of it | An option order cannot be sent from a build that does not compile; or worse, an older bundle ships without the calendar guard |
| 1 | Check the master warm-up actually covers manual traders: `live_trading WHERE provider='icici' AND enabled` rows, and today's `execution_masters_ready` log line | `worker.py:652` (the gate), `:656`, `:658-660`; `compose.yaml:81`, `:318` | The config and the wiring are already right (§3.3); the only open question is whether the gate has anything behind it for a manual-only workspace | First ICICI option order of the day can still rebuild 85,000 contracts inside its own 30 s budget — the 5-Nov failure |
| 2 | Classify pre-flight `BROKER_SESSION_EXPIRED` as `rejected`, not `unknown` | `worker.py:465-469` + `registry.py:63-66` + `errors.py:20` | Deterministic non-send currently locks the account and holds margin for ~3 min, then needs a human | Stuck orders after midnight, recurring exactly when re-auth is impossible from mobile |
| 3 | Post-close arm for the vendor-less case (`LAST_CLOSE`, not `STALE`) | `quote_selection.py:134-142`, `freshness.py:69`, `:208-221` | LIVE/LAST_CLOSE is unreachable 19 h a day in this deployment | Traders learn prices are "always stale" and stop trusting the badge |
| 4 | **Decide the option-chain `window` collision introduced today** — either key on `window`, or make the cross-seed carry the same window the ladder expects | `hooks.ts:481` (30) vs `:509` (400) on the shared key `:466`, `:476`, `:483-485`; consumers `spread-builder.tsx:277`, `BasketDesk.tsx:268` | Newest, and it is the only item here that can hide a strike a basket leg needs — see §2.9 item 1 | A multi-expiry basket resolves against a 30-strike strip it thinks is full, for 60 s, and never re-fetches |
| 5 | One feed object per *changed* quote, not per frame; stop copying the full snapshot | `websocket.ts:119-131`, `:289` | The whole client tick cost is ours to cut, and it is the only part of §2 not bounded by ICICI | Chart and portfolio stay janky even when ICICI prints fine |
| 6 | Patch the last bar instead of `applyNewData` of the full series | `KLineChart.tsx:118`, `:155`, `:168` | Removes the per-update serialise + full-series replace in the WebView | Visible repaint per tick on the chart tab |
| 7 | Raise the drafts timeout above 45 s, or merge drafts+place into one round-trip | `client.ts:66`, `:69`, `spread-builder.tsx:682`, `:684`, `brokers/runtime.py:128` | Closes the "aborted while it may still commit" window | Ambiguous basket sends; the honest copy is a mitigation, not a fix |
| 8 | Consider re-enabling a post-ACK observation in broker-first | `worker.py:473-474`, `streams.py:512-518` | Moves first confirmation from "next re-check" to ACK-time | Traders keep seeing ACK then a multi-second gap to a state |
| 9 | Hoist `StyleSheet.create` out of the chart screen's render body, and bound the min/max scan | `terminal-charts.tsx:138` (runs per render, and `:134-136` are tick-derived, so "per render" means per tick **[V]**), `:125-126` `Math.max(...highs)` / `Math.min(...lows)` over the whole window, `:100` unbounded intraday window **[V]** | Client-only, mechanical, and it sits directly in the tick path — the second-cheapest reduction of §2.4 after item 5 | The chart tab rebuilds its style sheet for every ICICI print |
| 10 | Wire the chart-library generator into a build step, or delete the now-unreferenced `.txt` asset | `apps/mobile/scripts/build_klinecharts_lib.js`, `apps/mobile/package.json:6-15`, `assets/vendor/klinecharts.min.txt` | Proven byte-identical today (§2.9 item 5); nothing keeps it that way | Someone edits the decoy asset and the app ships an old chart engine silently |
| 11 | Add a session-key arm to `broker_refusal` | `external_execution.py:31-50` | Stops "ICICI rejected this order" for our own expired session / SDK-local 500 | Wrong advice at the worst moment |
| 12 | Make the new AppState wiring actually pause polling, or drop the claim | `queryClient.ts:22-28` vs `:37` | §2.9 item 3 — the mechanism present is connectivity, not focus | Background polling keeps running on a locked phone, which is the cost this commit was meant to stop |
| 13 | ICICI re-auth reachable from mobile | `api/brokers.py:723-731`, `constants/index.ts`, and the unmounted status routes (`main.py:359-361`) | Product gap that makes price "stoppages" unresolvable in-app | Recurring support-shaped incidents after midnight |
| 14 | Delete or wire the dead routes/hooks | `hooks.ts:243`, `:599-610`, `:691-699`, `useRealtimeQuotes.ts` | Dormant today (none has a consumer — §2.4); a 404-poller the moment someone mounts one | Silent 404 polling if reused |
| 15 | Fix the `useOpenPositions` call arity in Algo Lab — the cheapest item in this table | `algo-lab.tsx:58` → `useOpenPositions({ enabled: activeTab === "risk" })`, against `hooks.ts:341`, `:348` | One argument move; it also clears one of the two typecheck errors (§2.10) | A 5 s positions poll stays alive on every Algo Lab tab, not just Risk |
| 16 | Move the post-send order status from a 1 s REST poll to the push route that already emits exactly those intents | `hooks.ts:640-651` (`:646`), `spread-builder.tsx:259` → `api/overview.py:475-540` and `api/hub.py:158-201` | §8.3 item 1. The server already wakes its SSE from `notify()` (`streams.py:279-280`); only the phone still polls. Complements priority 8, does not replace it | The first state after a send still lands on the client's own poll boundary, and every unsettled order costs a REST round-trip per second |
| 17 | Replace the two 5 s account/positions polls with one multiplexed account SSE, treated as *invalidate* not *populate* | `hooks.ts:343-347`, `:357-360` → `api/overview.py:414-471` | §8.3 item 2. That route's own docstring says it exists so "a terminal no longer opens a broker read per account poll" | Positions and margin keep being re-read on a timer, on every screen, for a broker that cannot push them anyway |
| 18 | Kill `useMarketDepth` before anything mounts it, and take the depth dialog off its 3×/s REST poll | `hooks.ts:722-728` (zero consumers **[V]**), `streams.py:704-720` | §8.3 item 5. One second per symbol per open dialog, against an ICICI budget that the socket does not charge (§8.1) | A dormant 1 s poller becomes live the moment a screen imports it; the live dialog keeps paying for a book the socket already accepted |
| 19 | Decide whether the app-wide index strip keeps its 15 s poll | `hooks.ts:711-717`, `_layout.tsx:13`, `:36`, `option_chain_service.py:701-731`, `streams.py:306-319` | §8.3 item 4. The numbers are already socket-derived server-side, and the five headline names are force-subscribed so the socket never lacks them | A market-data poll runs on every screen of the app, including the ones showing no market |

Do not do any of 16-19 by deleting a REST path: while an account `needsRead`, socket prices are suppressed
(§8.5 item 2), so REST is the correctness fallback. **[V]**

Not a priority: any client change aimed at "getting faster ticks". **[D]** §2.1 — no client change can print
an ICICI instrument more often than ICICI does.

---

## 7. To turn these bounds into numbers

Six fields already in the server's own order records, per reference — **[A]** `execution/api.py:166`, `:172`,
`:179`, `:186`, `repository.py:344`, `:404-410`: the stage timings around
`dispatch_database` / `broker_call_started` / `broker_call_response` (`worker.py:449`, `:461-463`), plus
`freshness.py:238` `networkLatencyMs` and `:270` `lateDelivery` on quotes.

That is enough to answer, for ICICI specifically, without any new instrumentation:
- median and p95 of `broker_call_response` — the one HTTPS round-trip of §3.1, and the number to compare
  against §3.4's re-check tail;
- count of orders whose first non-`queued` state arrived after the 3 s re-check rather than from a stream hint;
- count of `failureCode == BROKER_SESSION_EXPIRED` in the last 30 days and how long each held the account —
  §3.2's real blast radius;
- `lateDelivery` distribution against the 15 s gate — whether §2.1's floor or §2.4's client cascade is what the
  trader actually experiences.

Add two checks that settle §3.3 and §2.2 without any code change, both read-only:

1. `docker compose logs execution-worker | grep -E "execution_masters_ready|execution_masters_unavailable|execution_prewarm"`
   — the warm-up does run (`worker.py:678 asyncio.create_task(prewarm())`, service at `compose.yaml:211`), so
   the log tells you today's answer directly: `ready` with real NFO/NSE counts means ICICI option placement is
   warm; a day of `unavailable` or no line at all means the `:652` gate has no enabled row behind it.
2. `SELECT workspace_id, enabled, changed_at FROM live_trading WHERE provider='icici';` — whether the workspace
   that trades options by hand is in the set `prewarm()` looks at.

No query was run here, and no endpoint was called. This section is a pointer, deliberately, so the next pass can
be measured instead of derived.

---

## 8. With ICICI connected: which areas should read the stream instead of polling REST

Asked directly: *"if ICICI is connected, which areas should use websocket, not REST."* This section answers it
area by area, and — just as important — names the areas where REST is the only option, so nobody converts those
and breaks them.

**Nothing here was opened.** No websocket or SSE connection was made, no endpoint was called, no order was
touched. Every line is a read of source in this working tree.

### 8.1 The currency this is decided in

`services/stream_marks.py:3-5` states it better than I can:

> ICICI counts every REST call against about 5,000 a day; its websocket is not counted.

**[V]** So "should this be a poll or a push" is not a style question here. A poll spends a share of a hard daily
ICICI budget; a socket tick spends none of it. The same file's practice is the precedent already inside this
codebase — leg marks and index spots come off the stream, "A REST read is made only for a contract the stream has
not delivered yet" (`stream_marks.py:5-7`).

Five push transports exist today, and the mobile app uses exactly one of them:

| Transport | Where defined | Carries | Used by mobile? |
|---|---|---|---|
| WS `/v1/quotes/stream` | `api/quotes.py:58-59`, payload `delivery()` `api/quotes.py:22-28` | prices only — `{asOf, mode, quotes, removed}` | **Yes** — the only one: `packages/shared/src/constants/index.ts:68` → `websocket.ts:188` **[V]** |
| SSE `/v1/broker-auth/account/stream` | `api/overview.py:414-471` | the whole account display snapshot, "only when it changes" | **No** **[V]** |
| SSE `/v1/broker-auth/order/stream` | `api/overview.py:475-540` | active intents in `queued/working/unknown/needs_manual`, per-leg state | **No** **[V]** |
| SSE `/v1/broker-auth/icici/stream` | `api/overview.py:544-583` | `streams.snapshot(workspace,'icici')` — the raw Breeze tick set | **No** **[V]** |
| WS `/v1/hub/ws/orders` | `api/hub.py:158-201` | `{"type":"order_update","data":…}` from `stream_reconciler.subscribe(workspace)` | **No** **[V]** |

Grepped for `EventSource`, `text/event-stream`, `/v1/hub/ws/orders` and every route above across
`apps/mobile/**` and `packages/shared/**`: the only hit is the quotes WS. **[V]** The last mile is the gap — the
server already pushes; the phone still polls.

And the push is *tick-driven*, not merely a heartbeat: `brokers/streams.py:271-280` `notify()` drops the
workspace's `quote_cache` entry (`:273`) and calls `event.set()` on every registered listener (`:279-280`), which
is exactly what each SSE route waits on
(`overview.py:459`, `:528`, `:572`). A Breeze order hint therefore wakes a waiting SSE immediately.
**[V]**

### 8.2 Already correct — leave these alone

| Area | Evidence |
|---|---|
| Chart tab candles | `app/terminal-charts.tsx:107 useLiveCandles` → the hook opens the socket itself (`live-candles.ts:233`) and folds each tick into the bar (`:242-244 foldBucket`) **[V]** |
| Option-chain *leg marks* and algo marks | `option_chain_service.py:946-954`: for ICICI the wanted strikes are read off the socket first, and when `streamed["complete"]` (every leg plus the spot, `:1010`) the function returns **without any REST read**. `:994-1010` subscribes what is missing and reads the ticks **[V]** |
| Watchlist *prices* | the screen already opens the socket (`watchlist.tsx:227 useQuoteFeed`) and the backend pre-subscribes every saved row (`streams.py:302-305`) **[V]** |
| Portfolio live P&L | `portfolio.tsx:128 useQuoteFeed` **[V]** |
| Index strip *numbers* | server-side this is already a socket read: `option_chain_service.py:701-731` `strip_quotes()` — "Headline indices from the ICICI socket; REST reads only the indices the socket lacks" (`:702`), one REST refill per set at most every `STRIP_REST_SECONDS = 30` (`:77`) and only once a row is older than `STRIP_REFILL_AGE = 40` (`:78`) — and `streams.py:306-319` force-subscribes the five headline names so the socket never lacks them **[V]** |

### 8.3 Should be push — the seven areas, in the order I would do them

**1. Post-send order status — `useOrderSnapshot` 1 s while unsettled.**
`hooks.ts:640-651` (`refetchInterval` at `:646`), consumed only by `spread-builder.tsx:259` after a send. This is
the client half of §3.4's confirmation tail: the trader's first evidence of a state arrives on the phone's own poll
boundary. Two routes already push precisely this set — `/v1/broker-auth/order/stream` emits per-leg `state`,
`filledQuantity`, `averagePrice`, `brokerOrderId`, `message` filtered to unsettled intents (`overview.py:505-525`),
and `/v1/hub/ws/orders` pushes normalized order updates for the workspace (`hub.py:188-192`). **[V]**
Verdict: subscribe on send, keep the 1 s poll as the fallback that stops when push is alive. Note honestly: push
here removes the *client's* 1 s quantisation, not the server-side observation gap in §3.4 — priority 8 still stands.

**2. Open positions and account/margin — two separate 5 s polls of the same route.**
`hooks.ts:343-347` `useOpenPositions` and `:357-360` `useIciciAccount`, both 5 s, both against
`/v1/broker-auth/icici/account`; consumers `BasketDesk.tsx:85` and `:80`'s sibling `useOpenPositions()`; the Algo
Lab call at `algo-lab.tsx:58` is the arity bug in §2.10 which keeps a positions poll alive on every tab. The SSE
route's own docstring is the answer: *"Sends the same display snapshot a screen poll would, but only when it
changes, so a terminal no longer opens a broker read per account poll"* (`overview.py:418-419`). **[V]**
Verdict: one SSE per workspace, both hooks fed from it. Because Breeze cannot push positions (§8.4), the event
must be treated as *invalidate*, not *populate* — the wake-up still needs a REST read to get quantities.

**3. The order ticket's touch price — `useEquityQuote` 3 s.**
`hooks.ts:656-667` (`refetchInterval: enabled ? 3_000 : false`), consumed at `BuySheet.tsx:33`. The backend
already holds these ticks: `streams.py:320-324` pre-subscribes 217 core equities (counted from the tuple) and
`:302-305` the saved watchlist, and `streams.py:333-343` widens it further for rows a screen leases. So a ticket
for a listed stock is asking REST for a price the socket already delivered. **[V]**
Verdict: read it from `/v1/quotes/stream`. Caveat **[D]**: `book_fields()` gives bid/ask/OI/ttq on the tick
(`stream_worker.py:147-162`), so the ticket's spread field is available — but I did not verify the current
`EquityQuote` shape maps 1:1 onto a tick, so the swap needs a field-by-field diff first.

**4. Index strip — the poll is fetching socket data over HTTP every 15 s.**
`hooks.ts:711-717`, 15 s, `/v1/index-strip?overview=true` → `api/option_chain.py:109-110` → `strip_quotes()`. The
strip is mounted app-wide (`_layout.tsx:13`, `:36`), so this poll runs on every screen, including the ones with no
market in view. **[V]** Verdict: either push the strip rows on the quotes WS, or drop this screen to the account
SSE. Second choice is safer: the raw-tick SSE `/v1/broker-auth/icici/stream` already yields
`streams.snapshot(...)` and wakes on a tick (`overview.py:570-572`), whereas the client quotes WS payload is
`quote_selection`-derived (`api/quotes.py:22-28`) and I did not confirm it can carry `NSE:INDEX:` ids to a phone
**[D]** — the server-side index identity exists (`stream_worker.py:333-340` resolves a `watchSymbol`;
`index_recording.py:30-31` `INDEX_PREFIX = "instrument:v1:NSE:INDEX:"`) but I did not trace it into the client
frame.

**5. Depth — a 1 s REST poll exists and is dead; a 3×/s poll is the live cost.**
`hooks.ts:722-728` `useMarketDepth` at `refetchInterval: 1000` has **zero consumers** in `apps/` or `packages/`
outside its own definition **[V]** — dormant today, a 1-per-second REST book the moment someone mounts it. The live
depth cost is the stock dialog, which polls three times a second (`streams.py:707`, its own comment) while the
socket already serves the accepted book (`streams.py:704-720`, and depth views are subscribed at
`streams.py:326-328` up to `DEPTH_VIEWS_PER_WORKSPACE = 50` at `:77`). **[V]**
Verdict: do not mount `useMarketDepth`. Attach the socket `depth:` event to the dialog and let REST fill only the
uncached first frame. Note the limit that makes REST permanent for options: depth views exist for cash `EQ` only
(`streams.py:652-653` builds the identifier with `'EQ'`/`'CASH'`). **[V]**

**6. Baskets desk — 10 s for a payload the comment says is expensive.**
`hooks.ts:274-279` `refetchInterval: 10 * 1000`, consumer `BasketDesk.tsx:80`; `:271-272` describes it as "every
basket arrives with its legs, marks, booked P&L, close charges and the payoff contracts". Marks on those legs come
from the socket (`stream_marks.py`), so most of what changes in that response changes on a tick, not on a timer.
**[V]** Verdict: push-to-invalidate on the account SSE rather than a fixed 10 s; nothing ICICI-specific is added by
the re-read itself, so this is a smaller win than 1-3 and I would not do it first.

**7. Scanner rows — 10 s / 60 s, and no ICICI involvement.**
`hooks.ts:743-748` `liveTrades` 10 s, `:755-759` `useTechnicalEvents` 60 s. These read our own Postgres, not Breeze.
Converting them costs no ICICI budget and buys latency only; `/v1/alerts/stream` and
`/v1/market-intelligence/stream` exist **[A]** (route names seen; I did not read their bodies). Lowest priority in
this list.

### 8.4 Must stay REST — Breeze has nothing to push here

Verified by reading the ICICI adapter's own call sites; **no push subscription exists for any of these**, so a
proposal to socket-ify them is wrong, not merely premature.

| Data | Read | Why REST is the only option |
|---|---|---|
| Positions | `brokers/icici/account.py:46` `get_portfolio_positions` | no Breeze position subscription **[A]** |
| Holdings | `account.py:47`, `:49` | same **[A]** |
| Funds / margins | `account.py:48` `get_funds`, `:76` | same **[A]** |
| Order list / detail | `account.py:53` `get_order_list` / `get_order_detail` | the order *notification* socket exists but is reduced to id/remark/status (`stream_worker.py:256-274`, `:416-420`), so quantities and averages still need the REST read **[V]** |
| Trade list / detail | `account.py:77`, `:97` | no trade push **[A]** |
| Candles / intraday bars | `chart_history.py:85`, `:113`, `:162` `get_historical_data_v2` | history is a request/response API **[A]** — the chart socket only *extends* the last bar, which is what `useLiveCandles` already does |
| Option master | `market_data.py:129-150` — an HTTP zip | a file download, not a feed **[A]** |
| Whole-expiry chain ladder | `option_chain_service.py:1098-1100` `read("chain_quotes", …)`, and `:1235-1244` bhavcopy closes for untraded strikes | the socket carries the strikes it is subscribed to (§8.2), not a strike range it is not — so the *ladder* stays REST even though the *marks* on it do not **[V]** |
| GTT | `execution/gtt_orders.py:111`, `:128`, projector `:162` | the rows are our own Postgres **[V]**; no Breeze GTT subscription appears anywhere in the worker **[A]** |

The correct mobile shape for this whole group is **push-to-invalidate**: the Breeze order hint already wakes the
worker via `Repository.wake_from_stream` (`repository.py:1045-1068`, throttled 1/s, and it only sets
`next_attempt_at` + `pg_notify` **[V]**) and `watch_feed_reconciliation` (`streams.py:559-598`). The client should
follow that same pattern — take the event, then spend exactly one REST read — instead of holding a timer open.

### 8.5 Four constraints that decide *how*, once *whether* is settled

1. **Capacity is per workspace and small.** SSE: 3 connections per kind per workspace, 20 globally
   (`overview.py:422-425`, `:483-486`, `:548-551`); the quotes WS already caps at 3 tabs per workspace **[A]**
   (`websocket.ts` policy refusals); server-side: `DEPTH_VIEWS_PER_WORKSPACE = 50` (`streams.py:77`),
   `TICK_VIEWS_PER_WORKSPACE = 250` (`:83`), `MAX_DEMAND = 400` (`stream_marks.py:26`). **[V]** A design that opens
   one SSE per hook hits 429/503 immediately — it must be **one connection per workspace, multiplexed**.
2. **Do not delete a REST path when adding a push.** While an account `needsRead`, socket prices are *suppressed*
   — `stream_marks.py:72` returns no entry when `needsRead` is set, and `quote_selection.py:81-82` skips such an
   entry entirely. **[V]** That flag is the reconciliation state, so the REST read is the correctness fallback, not
   a redundancy. Every conversion above is an overlay.
3. **A new subscription must be idempotent.** `streams.py:331-332` and `:336-338` are explicit that adding a name
   already in the set "moves the subscription fingerprint and replaces a stream that is working", and the
   fingerprint is over `[session, desired]` (`:351`). **[V]** Client-side churn — subscribing per render, or an
   unstable id list — can therefore restart a healthy Breeze socket. This is the real risk in items 3 and 4, and it
   is why I would not let a phone drive the subscription set without a stable canonical id.
4. **A persistent connection changes the background story.** Each SSE re-authorises on its own cadence
   (3 s for orders `overview.py:499-500`, 1 s for the ICICI raw stream `:564-565`) and stops on
   `request.is_disconnected()`. On a phone that means priority 12 (§6) gets *more* load-bearing, not less: the
   AppState wiring there is currently inert, so a backgrounded app would keep a broker-authenticated stream open.
   Fix 12 before or with any of 1-4. **[V]** for the code state; the battery/network consequence is unmeasured
   **[D]**.

### 8.6 What I could not determine without calling something

- Whether each client poll actually costs an **ICICI** call or is served from `quote_cache` / the intent cache —
  `notify()` pops that cache (`streams.py:273`) but I did not trace every route's hit/miss. The polls are real;
  their share of the ~5,000/day is not established here. **[D]**
- Whether `/v1/quotes/stream` can deliver `NSE:INDEX:` ids to the client (§8.3 item 4). **[D]**
- What `/v1/hub/ws/orders` actually emits, i.e. whether `stream_reconciler.subscribe` covers fills *and*
  terminal states, or only reconciled order rows. I read the transport (`hub.py:158-201`), not the reconciler.
  **[D]**
- Whether `EquityQuote` (`hooks.ts:656-667`) maps field-for-field onto a socket tick (§8.3 item 3). **[D]**

Answering those four needs either a live connection or a log read — which is why §7 exists. I took neither.

---

## 9. Live-price freeze across four surfaces — option chain, bid/ask book, live chart, payoff diagram

Added 2026-11-27 on request: *"during live market hours, whenever prices update, the entire application hangs,
lags severely, or completely freezes — specifically across the Option Chain, Bid/Ask Order Book, Live Chart and
Strategy Payoff Diagram."* Reviewed as a low-latency problem: ingestion → state → options math → render, one
tick at a time, with the line numbers read out of the tree rather than inferred.

**Tree.** The pass was taken against `origin/main` at `37b1056`, frozen in its own worktree (`wt-perf-audit`,
clean) before a single citation was read. PR #51 (`fix/low-latency-tick-pipeline`) merged into that main as
`c93996f` on 2026-11-27 while §9 was being written, so **every line number below was re-read against merged
main `c93996f`** — the tree a reviewer checks out — and every finding says what #51 did to it. §9.6 is the
per-finding before/after. Where a sentence describes code #51 removed, it says "before #51".

**Rails.** Read-only. No build, no install, no device, no emulator, no dev server. No endpoint called, no
websocket opened, no SSE consumed. **No order placed, cancelled, amended, previewed or dry-run; no strategy
executed or deployed; no production configuration touched.** No secret, token or session value read or printed.
Market was closed while this ran, so nothing here is a live-market measurement — every rate below is a constant
in source or arithmetic on one, labelled **[D]**.

**Labels.** **[V]** read by me at the cited line this pass. **[D]** arithmetic on values written in source.
**[A]** attributed from a delegated read, then re-checked by me in the file.

### 9.1 Four premises the request brought, and what the source says instead

Getting these wrong sends the whole fix to the wrong layer, so they are answered first.

| Assumed in the request | Actual state | Citation |
|---|---|---|
| Ticks arrive on the platform main/UI thread and block it | There is no app-written Kotlin/Java — `android/app/src` holds only the Expo-generated shell, and `android/gradle.properties` sets `newArchEnabled=true`. On Hermes + Fabric the socket callback runs on the JS thread, so the stall is **JS-thread saturation**, not UI-thread blocking. The UI thread only suffers when it is asked to mount what the JS thread produced. | **[V]** tree state |
| Frames are Protobuf/binary and need binary decoding | The transport is JSON text, decoded synchronously: `JSON.parse(String(event.data))`. | `websocket.ts:415-424` (`JSON.parse` at `:418`) **[V]** |
| The ingestion queue is unbounded and needs backpressure / conflation | Conflation already exists and is correct: a 100 ms publish window (`THROTTLE_MS = 100`), a latest-wins map keyed by `[broker, accountId, subscriptionId]`, and a coalesced dirty-id set that merges frames rather than queuing them. `published` cannot grow past the subscribed id count, so there is no stale-tick backlog to drain. **The dispatcher does not need conflation; it needs less work per frame and a release path for its suspend switch.** | `websocket.ts:179`, `:197-211`, `:248-263`, `:285-331` **[V]** |
| Lists are not virtualized and keys are unstable; subscriptions leak | The chain ladder is a `FlatList` with `getItemLayout`, a padded viewability band and a stable `item.key`; `SortableTable` is virtualized too. A watcher's cleanup exists and every subscribe message is a full replace, so an id cannot go ghost on expiry or symbol switch. **The real subscription defect is the opposite: hidden screens never release theirs** (§9.2 H1). | `option-chain.tsx:810-823`, `SortableTable.tsx:132-146`, `websocket.ts:265-273`, `:513-531` **[V]** |

### 9.2 Ranked bottleneck summary

Ranked by work forced per unit of price movement, which is what the complaint is about. Severity is as scored
against merged main `c93996f`, i.e. after PR #51; the before/after per row is §9.6.

| # | Sev | Defect | Where | Rate forced **[D]** |
|---|---|---|---|---|
| C1 | **Critical** | The live spot is inside the `/v1/strategy-analysis` request body, and the query key **is** the body → a price move is a new cache entry plus a POST | `PayoffChart.tsx:246` → `:308` → `:359` → `:362` → `:368` → `:378`; key `hooks.ts:312`, query `hooks.ts:1130-1139` | ≤4 POST/s and ≤4 new query entries/s while the payoff is on screen (the 250 ms spot throttle at `:246`; 10/s before #51) |
| C2 | **Critical** | `pauseQuoteDispatch()` is a module boolean with no owner count, no unmount release and no watchdog; the lists set it on drag-start | `websocket.ts:166`, `:182-191`; `SortableTable.tsx:143-144`; `option-chain.tsx:817-818` | one lost `onScrollEndDrag` = **0 publishes/s, forever**, on every screen |
| C3 | **High** (Critical before #51) | A chain screen render still repaints the whole visible window: `renderItem` is a fresh closure on every render, `useOrderTicket` hands back a new object literal so `ticket` — and `openTicket`, whose deps are `[underlying, ticket]` — change identity, and the row comparator compares exactly those props. #51 removed the *per-tick* half: the screen no longer re-renders on publish, and each cell subscribes to its own instrument | `useOrderTicket.tsx:374`; `option-chain.tsx:594`, `:824`, `:859`, comparator `:281-289`, row memo `:234`; cell memo `:136` with `useInstrumentTick` at `:146` | every visible strike row re-renders per screen render (ladder read, expiry tap, store write); a tick repaints only the cells whose own price moved |
| H1 | High | Hidden tabs keep their socket subscriptions and keep re-rendering: the enable flags ignore the `focused` the same screens compute | `option-chain.tsx:327` vs `:445`; `watchlist.tsx:235` vs `:421`; union `websocket.ts:265-267`; fan-out `:239-247` | subscription set = all mounted screens; `accept()` cost and every frame's fan-out scale with it |
| H2 | High | Per-frame synchronous cost in the ingest path: one `JSON.stringify` per quote (#51 collapsed the two it used to make), a `Set` + `flatMap` + sort over every subscribed id per message, and a copy of the whole published map per watcher per publish | `websocket.ts:128-130` used once at `:299`; `:351-353` called at `:412` and `:422`; `:156-162`; `:239-247` | a 250-id set ≈ 250 stringify + ≈ 250 sort keys + several hundred map reads **per frame** **[D]** |
| H3 | High | Quote memory rewritten on live prices, by every consumer that takes a tick: `rememberQuotes` is copy-on-write over the whole ≤600-key memory, and the cell effect, the watchlist effect and the strip effect each feed it a fresh tick per publish | `option-chain.tsx:147-149` → `quote-memory.ts:113`, `:129`, `:137` (`QUOTE_MEMORY_MAX = 600` `:57`); `watchlist.tsx:430`; `IndexStrip.tsx:81-88`; whole-ladder pass `option-chain.tsx:454-457` | ≈600-key clone per cell that moved: a 12-row window with both legs live is ≤24 clones per publish, ≈14,400 property copies per publish, ≤144,000/s at the 10 Hz ceiling; the watchlist adds one full clone per publish **[D]** |
| H4 | High | The book screen re-derives everything per tick with nothing memoized, and the ladder is not virtualized | `stock.tsx:54`, `:55`, `:56-64`, `:170`, `:171`, `:172` (`quoteProvenance` → `isTodayIST` allocates 2 `Date` + 2 strings, `utils/index.ts:47-51`), `:173`, `:326-337` | one screen render + 4 derivations + 20 inline rows per tick for that symbol |
| M1 | Med | No `gcTime` cap anywhere, so C1's dead keys are retained for the library default (5 min) | `queryClient.ts:46-58` | up to ≈1,200 retained entries during a fast patch at 4 POST/s **[D]**; matches the 471–497 MB PSS and GC every 2–4 s in `PERFORMANCE_AUDIT_REPORT.md` |
| M2 | Med | `SortableTable` recomputes column widths — with a synchronous `Dimensions.get` — outside any memo, which defeats both of its own memos and has no `extraData` | `SortableTable.tsx:50`, `:74`, `:95`, `:134` | new `renderItem` identity per render → in-window rows reconcile even for a sort tap |
| M3 | Med | The chart series is rebuilt end-to-end per publish even though the WebView only ever needs the one forming bar | `live-candles.ts:265-280` → `terminal-charts.tsx:500-510`; patch path already exists at `KLineChart.tsx:789-802` | ≈150 fresh objects per publish per chart |
| M4 | Med | Foreground/reconnect is a burst, not a resume: all three refetch flags are on *and* the stream re-snapshots every watcher in the same event | `queryClient.ts:52-54`, `:34-38`, `:24-31`; snapshot publish `websocket.ts:407-413`, `:289-294`; teardown `:446-472` | one app-restore = full re-read of every stale query + full repaint of every watcher |
| M5 | Med | `tickByInstrument` allocates a `Map`, spreads it and compares every entry on each publish | `chain-ticks.ts:71-83`; call site `spread-builder.tsx:481` (the chain's call site was removed by #51) | O(band) per publish; deliberate (the comment says holding it in state repaints forever) |

Nothing in the four named surfaces has a synchronous lock, a mutex or a blocking call — there is no such
primitive in single-threaded JS. Every "lock" in §9.4 is a function that does not return until the work is done,
which is the same effect and a different fix.

### 9.3 Per-surface root cause

**Option chain.** After #51 the tick no longer enters through the screen: `option-chain.tsx:445` subscribes with
`useQuoteSubscription` (`websocket.ts:645-652`, a `NOOP_WATCHER` at `:639`), so a publish does not rebuild the
render body. What it does cost is one render per cell whose own price moved — `OptionLegCell` reads
`useInstrumentTick` (`:146`), re-derives `priceObj` (`:150`) and pushes the tick through the memory clone
(`:147-149`, H3). The row memo (`:234`) and its comparator (`:281-289`) are what keep the rest of the row still,
and they hold for ticks but not for screen renders: `renderItem` (`:824`) is a fresh closure each render and
`onTrade` (`:859`) comes from `openTicket` (`:583-594`, deps `[underlying, ticket]`), which is new because
`useOrderTicket` returns a fresh literal (`useOrderTicket.tsx:374`). Before #51 that chain fired ≤10 times a
second on price alone; it now fires on ladder reads, expiry taps and store writes (C3). The rows are where the
pixels are: each is a nested `View`/`Text` tree, so a screen render is roughly a dozen row renders.

**Bid/ask book.** `stock.tsx` subscribes the screen, not the cell. `useQuoteSubscription` (`:54`) keeps the whole
feed out of React, but `useInstrumentTick(cashId)` (`:55`) puts this symbol's own tick straight into the screen's
render, so a tick re-runs the `quote` merge (`:56-64`, a spread of the REST quote), then `depthBook` (`:170`),
`bookStamp` (`:171`), `quoteProvenance` (`:172`) and a watchlist scan (`:173`), and re-creates the inline
five-level ladder (`:326-337`) with index keys, inside a plain `ScrollView` (`:297`). Five levels deep is cheap
per pass; the pass is just never skipped.

**Live chart.** This is the best-behaved of the four and the least suspicious: the WebView already patches one
bar instead of resending the series (`KLineChart.tsx:789-802`, `patchBar` `:605-624`). What is left is on this
side of the bridge — `useLiveCandles` folds a new bar object per tick (`live-candles.ts:265-274`), which rebuilds
the visible array from that index (`:276-280`), which `terminal-charts.tsx:500-510` maps into fresh objects, which
re-runs the `[data]` effect (`KLineChart.tsx:789`). Hundreds of allocations per publish, and one `postMessage` of a
small string. It contributes to the pile; it is not the boulder.

**Payoff diagram.** C1. `spot` is a prop (`:172`), and two memo dependency lists contain the throttled copy of it
(`:308`, `:359`), and the body of a POST is built from them (`:362`, `:368`), and the query key of that POST *is*
the body (`hooks.ts:312`). Then the response's own spot comes back through `liveSpot` (`:394`) and drives the local
Black-Scholes again (`:415` → `:475` → `:486` → `:525` → `:589`), which rewrites three SVG path strings
(`:672-674`) and the OI bars (`:737`) — so one tick is two render passes and one network round trip. The
local math is `spots × legs` `bsm()` calls plus a density integral: for a 4-leg spread over the 61-point grid
that is ≈300 `bsm` evaluations per pass, ≈1,200/s at the throttled 4 Hz; for a 32-leg basket ≈2,000 per pass,
≈7,800/s **[D]** (grid at `:397-411`, math at `:529-530`, `:537-545`, `:552-560`, `bsm` at `:58-91`).

### 9.4 Data-flow diagnosis: one tick, end to end

A fresh price for one strike, arriving on the shared socket, with the Option Chain tab open and Watchlist
mounted behind it. "Sync" = this does not return before the work is done.

| Step | File:line | Sync work | Cascade it starts |
|---|---|---|---|
| 1 | `websocket.ts:415-424` `ws.onmessage` | `JSON.parse` of the whole frame (`:418`) | — |
| 2 | `:422` → `armSilence` `:351-353` | `desiredInstruments()` (`:265-267`) → `Set` + `flatMap` + `sort` over every subscribed id, then a `clearTimeout`/`setTimeout` | — |
| 3 | `accept` `:289-294` | if not a delta: `published = new Map()` (`:290`) — a snapshot frame throws the whole price book away | — |
| 4 | `accept` `:299` and `:300` | `quoteKey` = one `JSON.stringify` per quote (two before #51), plus `toTick` (`:137-154`: `Date.parse`, 4 × `positiveNumber`) | — |
| 5 | `accept` `:330` | `publish(changedIds)` → `bufferPublish` (`:197-204`) | **if `isSuspended`, stop here** (`:250`) — nothing below runs until someone calls `resumeQuoteDispatch` (C2) |
| 6 | `publish` `:248-263` | `Date.now()`, timer bookkeeping | — |
| 7 | `publishImmediate` `:226-247` | for **each** watcher (`:239`): id intersection scan, then `snapshotFor` (`:156-162`) which copies every published tick | one `setFeed` per interested screen |
| 8 | `useRegistration` `:546-548` | `{...next, reason}` — a new object identity even when nothing this screen owns moved | React schedules a render of every screen still on `useQuoteFeed`/`useQuotesStream`, on every mounted tab (H1) |
| 9a | chain `option-chain.tsx:146` | `useInstrumentTick` per cell — the render only runs for cells whose own id moved | — |
| 9b | chain `:147-149`, whole ladder at `:454-457` | `tickEntries` → `rememberQuotes` clone (`quote-memory.ts:129`) + sort/slice (`:137`) | async AsyncStorage write, throttled to 10 s (`useQuoteMemory.ts:47`, `:57-62`) |
| 9c | chain `:824-860` | new `renderItem` closure; `onTrade` new (`:583-594`) | **the memo at `:234` fails on a screen render → every visible row re-renders** (C3) |
| 9d | watchlist `watchlist.tsx:422`, `:430`, `:432`, `:435` | `markWatchlist` clone-all + `remember` of the whole feed + `paintWatchlist` clone-all + `sortRows` | hidden tab reconciles its list |
| 9e | `IndexStrip.tsx:52`, `:57-75`, `:81-88` | strip memo + `remember` of the index ticks | global chrome above the router re-renders on every screen |
| 10 | payoff, if mounted: `spread-builder.tsx:477`, `:480-482` | a **second** state update per publish (`setTicks(new Map(...))`) | another render pass |
| 11 | `PayoffChart.tsx:268`, `:311` | `virtualBasket` + whole-chain `prepareQuote` clone | — |
| 12 | `:362` → `:368` → `:378` → `hooks.ts:312`/`:1132` | `buildAnalysis` and a **new query key** | **POST `/v1/strategy-analysis`** + a new retained cache entry (C1, M1) |
| 13 | `:415` → `:475` → `:486` → `:525` → `:589` | ≈300–2,000 `bsm` per pass, 3 path strings, OI bars | SVG diff + native redraw |
| 14 | the POST's response, ~1 round trip later | `model` `:387`, `liveSpot` `:394` | **steps 11-13 again for the same tick** |

That is the whole answer to "why does everything lag when prices move": step 5's guard, the fan-out at 7-8 that
reaches screens nobody is looking at, and steps 11-14 turning a price change into a network request and two
render passes. On the emulator this showed up as jank 90.74-98.33 %, p50 frame times of 117-150 ms, 8-15 FPS and
GC every 2-4 s (`PERFORMANCE_AUDIT_REPORT.md`, n=5, AVD `sdk_gphone64_x86_64`) — which is the shape of
§9.2, measured.

### 9.5 Production-ready refactoring plan

Three commits, in this order, because each one is a behaviour and the owner lands one behaviour per branch.
Client items are **M17–M27** in `MOBILE_CODE_FIXES.md` §F.

#### (a) Tick conflation and batch dispatcher — keep the window, cut the work per frame, make the suspend switch releasable

The 100 ms window is right; leave `THROTTLE_MS` alone. Four changes, all in `packages/shared/src/api/websocket.ts`.

**a1. One composite key per quote, allocated without JSON** (`:128-130`, computed once per quote at `:299`):

```ts
/**
 * The composite key the server deltas against: [broker, accountId, subscriptionId]. Joined with NUL rather
 * than serialised, because `accept` builds it for every quote of every frame and the frame rate is the reason
 * this file exists.
 */
function quoteKey(quote: WireQuote): string {
  return `${quote.broker ?? ""}\u0000${quote.accountId ?? ""}\u0000${quote.subscriptionId ?? ""}`;
}
```

`accept` already computes it once (`:299` — it did so twice before #51), so what is left is the allocation:

```ts
const key = quoteKey(quote);
const seen = published.get(key);
// …previousClose carry-forward unchanged…
published.set(key, tick);
```

**a2. Stop rebuilding the subscription set on every frame.** `armSilence` (`:351-353`) and `sendSubscriptions`
(`:269-273`) both call `desiredInstruments()` (`:265-267`), which allocates a `Set`, a `flatMap` array and a sort
over every id — and `armSilence` runs on `ws.onopen` (`:412`) and again on every message (`:422`), which is not
when the answer can have changed. Cache it against watcher churn instead:

```ts
/** The subscription set only changes when a screen registers or releases, so the sort is not per-frame work. */
let desiredCache: string[] | null = null;

function desiredInstruments(): string[] {
  if (desiredCache === null) {
    desiredCache = [...new Set([...watchers].flatMap((watcher) => watcher.ids))].sort();
  }
  return desiredCache;
}

function invalidateDesired() {
  desiredCache = null;
}
```

Call `invalidateDesired()` at both mutation points in `watchQuotes` — immediately after `watchers.add(watcher)`
(`:515`) and inside the returned cleanup before the `!watchers.size` test (`:527-528`). `armSilence` then
reads a cached array and allocates nothing.

**a3. Give `snapshotFor` an index instead of a copy.** `:156-162` copies the entire published map per watcher per
publish, which is O(watchers × all ids) to answer a question about ≤100 ids. Maintain the id index in the same
loop that writes `published`:

```ts
/** id → the live entries for it, kept beside `published` so a watcher's snapshot reads its own ids. */
const byId = new Map<string, QuoteTick[]>();

function snapshotFor(ids: readonly string[]): FeedSnapshot {
  const quotes: QuoteTick[] = [];
  if (ids.length === 0) {
    for (const tick of published.values()) quotes.push(tick);
  } else {
    for (const id of ids) {
      const hit = byId.get(id);
      if (hit) for (const tick of hit) quotes.push(tick);
    }
  }
  return { quotes, states, connected, asOf };
}
```

Maintain it in `accept`: clear `byId` wherever `published` is cleared (`:290`, `:364`, `:429`, `:467`), push on
`published.set(key, tick)`, and remove on the `removed` path (which already has `existing.id` at `:318`). An array
per id, not a single entry, because two accounts on one broker legitimately price the same canonical id and today
both survive the filter at `:159`.

**a4. A suspend switch that cannot outlive the hand that set it.** This is C2 and it is the one defect that makes
the whole app stop rather than stutter: `isSuspended` is a bare boolean (`:166`), `pauseQuoteDispatch` is
idempotent-but-never-released-by-anybody-except-the-list (`:182-184`), and the two lists that use it pass it
straight to `onScrollBeginDrag` with no unmount release (`SortableTable.tsx:143-144`,
`option-chain.tsx:817-818`). A drag interrupted by a navigation, a list remount or a re-render that recycles the
`FlatList` leaves `onScrollEndDrag` unspent, and then **no screen ever publishes again** until the app is
backgrounded.

```ts
/** A scroll holds the dispatch; nothing holds it longer than this, because a lost end-drag is not an outage. */
const SUSPEND_MAX_MS = 1_500;

let suspendHolds = 0;
let suspendWatchdog: ReturnType<typeof setTimeout> | null = null;

/**
 * Counts the holders instead of setting a flag, and lets the watchdog release them all.
 *
 * A list is the only reason to hold the dispatch — the frames that land mid-drag are the ones that make the
 * drag stutter — so the hold belongs to that list. Unmount it mid-drag, or take a gesture that never reports
 * an end, and an uncounted flag would keep every screen in the app silent on prices with a socket that is
 * still open, still subscribed and still carrying. The watchdog is the floor under that: a hold is a
 * rendering preference, never a reason to stop telling the trader what the prices are.
 */
export function pauseQuoteDispatch() {
  suspendHolds += 1;
  isSuspended = true;
  if (suspendWatchdog) return;
  suspendWatchdog = setTimeout(() => {
    suspendWatchdog = null;
    suspendHolds = 0;
    releaseQuoteDispatch();
  }, SUSPEND_MAX_MS);
}

/** Resumes only the last holder, and flushes whatever the window buffered. */
export function resumeQuoteDispatch() {
  if (suspendHolds > 0) suspendHolds -= 1;
  if (suspendHolds > 0) return;
  if (suspendWatchdog) {
    clearTimeout(suspendWatchdog);
    suspendWatchdog = null;
  }
  releaseQuoteDispatch();
}

function releaseQuoteDispatch() {
  if (!isSuspended) return;
  isSuspended = false;
  if (hasBuffered()) publishImmediate(takeBuffered());
}

/**
 * For a list that can be unmounted mid-drag: give these to `onScrollBeginDrag` / `onScrollEndDrag`.
 * Unmounting releases the hold, so a screen that leaves while the finger is down cannot take the app's
 * prices with it.
 */
export function useQuoteDispatchHold() {
  const onBegin = useCallback(pauseQuoteDispatch, []);
  const onEnd = useCallback(resumeQuoteDispatch, []);
  useEffect(() => resumeQuoteDispatch, []);
  return { onBegin, onEnd };
}
```

`disconnect` (`:446-472`) should also clear the hold state (`suspendHolds = 0`, watchdog cleared) so a dropped
socket cannot be resurrected already-suspended.

**a5. Hidden screens release their ids (H1).** `option-chain.tsx:445` and `watchlist.tsx:421` pass enable flags
that never mention `focused`, while `option-chain.tsx:327` and `watchlist.tsx:235` already compute it for
polling. Add it:

```ts
// option-chain.tsx:445
useQuoteSubscription(ids, focused && !!chain?.marketOpen && ids.length > 0);
// watchlist.tsx:421
const feed = useQuoteFeed(instruments, authenticated && focused && instruments.length > 0);
```

The server allows three tabs per workspace and the phone holds one socket for all of them; asking it to price the
chain of a tab that is not on screen is the load, not the fix. Coming back to the tab re-registers, which already
resets the refusal and the retry budget (`websocket.ts:486-507`).

#### (b) Granular cell-level reactivity

**b1. Make the ticket object stable, once, for every screen.** `useOrderTicket` memoizes all thirteen actions
(`:126`, `:151`, `:171`, `:235-352`) and then hands back a new container literal at `:374`. That single line is
why `openTicket` (`option-chain.tsx:583-594`) is new on every render and why the row memo at `:234` never
returns early. The fix is at the source, so all four consumers (`option-chain`, `portfolio`, `watchlist`,
`stock`) get it at once:

```ts
  // The actions are memoized above; the container has to be too, or every screen that holds this object
  // hands its children a new `onTrade` on every render and no row memo can ever bail out.
  return useMemo(() => ({
    visible, config, localState, isSubmitting, validationError, setLocalState,
    open, close, submit, validate,
    quickBuy, quickSell, quickLimitBuy, quickLimitSell, quickStopLossBuy, quickStopLossSell,
    fromOptionChain, fromGlobalSearch, fromBasket, fromPosition,
  }), [
    visible, config, localState, isSubmitting, validationError,
    open, close, submit, validate,
    quickBuy, quickSell, quickLimitBuy, quickLimitSell, quickStopLossBuy, quickStopLossSell,
    fromOptionChain, fromGlobalSearch, fromBasket, fromPosition,
  ]);
```

Keep `setLocalState` out of the deps (it is a stable `useState` setter). `localState` and `config` still change
on a press, which is correct: a ticket that opened must re-render the sheet that shows it.

**b2. Price the cell, not the screen.** One store, one selector per cell, so a publish re-renders the rows whose
own instrument moved and nothing else. PR #51 ships this and it is on main (`packages/shared/src/api/quote-store.ts`,
`useInstrumentTick` at `:88-90`, `OptionLegCell` at `option-chain.tsx:136`) and it is the right shape; two
hardening points remain — the batch flush must not copy the whole record more often than the publish window (it
does not: one `set` per publish, `websocket.ts:226-247`), and a subscriber must not read a tick the connection no
longer owns, which #51 handles by gating on `state.connected`.

The consumer change is the part that buys the frame time — hoist the row out of the render body and let it
subscribe itself:

```tsx
// option-chain.tsx:824 — today the renderItem prop is a fresh arrow on every render.
const renderItem = useCallback(({ item }: { item: ChainItem }) => {
  if (item.kind === "section") return <SectionRow item={item} styles={styles} />;
  if (item.kind === "pending") return <PendingRow expiry={item.expiry} styles={styles} />;
  if (item.kind === "failed") return <FailedRow expiry={item.expiry} message={item.message} styles={styles} />;
  return <OptionRowItem row={item.row} expiry={item.expiry} styles={styles} onTrade={openTicket} />;
}, [styles, openTicket]);
```

with the two live figures pulled out of the row's props and into hooks inside it:

```tsx
const OptionRowItem = React.memo(function OptionRowItem({ row, expiry, styles, onTrade }: OptionRowItemProps) {
  const liveCall = useInstrumentTick(row.call?.instrumentId);
  const livePut = useInstrumentTick(row.put?.instrumentId);
  // …
});
```

Then `savedCall` and `savedPut` leave the prop list at `option-chain.tsx:853-860`. #51 already moved the live tick
into the cell (`:146`), so these two are the remaining values a row is handed that it could read itself — and every
one of them is in the comparator (`:281-289`), so each is a reason a screen render repaints the window.

**b3. Stop rewriting quote memory per tick (H3).** Before #51 the effect at `option-chain.tsx:409-412` depended on
`feed.quotes`, which was new every publish, so every publish cloned and sorted up to 600 keys
(`quote-memory.ts:129`, `:137`) to remember prices the ladder had not changed. #51 moved that to the ladder
(`:454-457`):

```ts
  useEffect(() => {
    const legs = items.flatMap(item => (item.kind === "row" ? [item.row.call, item.row.put] : []));
    quotes.remember(legEntries(legs));
  }, [quotes, items]);
```

What is left of H3 after #51 is the other three writers, each of which still runs on a live tick: the cell effect
at `option-chain.tsx:147-149` (one whole-memory clone per cell whose price moved), `watchlist.tsx:430` (one per
publish, for the entire feed) and `IndexStrip.tsx:81-88` (one per publish for the indices). Do it where the ticks
already are — inside the store's batch flush, once per publish window, on `dirtyBuffer` rather than a rebuilt
array — and leave the ladder re-reads as the effect's only trigger.

**b4. Memoize the table's own geometry (M2).** `SortableTable.tsx:50`:

```ts
  const width = useWindowWidth();            // Dimensions.addEventListener("change"), not a get per render
  const widths = useMemo(() => scaleWidths(columns, PADDING, width), [columns, width]);
```

**b5. Memoize the book screen (H4).** `stock.tsx:170-173` → one memo keyed on what it actually reads:

```ts
  const book = useMemo(() => depthBook(quote ?? null), [quote]);
  const stamp = useMemo(() => bookStamp(quote ?? null), [quote]);
  const provenance = useMemo(() => quoteProvenance(quote ?? null), [quote]);
```

and lift the five rungs at `:326-337` into a `React.memo`'d `DepthRow` keyed on `side+price` rather than index.
Five levels do not need virtualization; they do need to survive the case #51 left open — `useInstrumentTick(cashId)`
at `:55` re-renders this whole screen on its own symbol's tick, which is the only tick it can get, so every
derivation and every rung rebuilds at 10 Hz whether or not the depth changed.

#### (c) Payoff and Greeks: off the tick path, then capped

**c1. Break C1 first — it is a network request caused by a price change.** The server read is not what draws the
line: `PayoffChart.tsx:381-386` says so in its own comment, and the local curve at `:462-585` is what paints while
the model is out. So the model read should run on the cadence of a *decision* (a leg added, a date changed, a
shock slider moved) and not on the cadence of the market.

```ts
  // 4. The server read is the refinement, not the drawing: POP, the model's own Greeks and planning margin,
  //    asked again when the basket changed and at most every couple of seconds after that. Feeding it the
  //    live spot made every tick a POST and a cache entry the phone keeps for five minutes.
  const analysisBody = useMemo(() => {
    if (!built.body) return null;
    return { ...built.body, spotShockPct, ivShiftPoints };
  }, [built.body, spotShockPct, ivShiftPoints]);

  const steadyBody = useSteadyValue(analysisBody, 2_000, sameAnalysisRequest);
  const analysis = useStrategyAnalysis(steadyBody);
```

```ts
/** What makes this a different question to /v1/strategy-analysis: a leg, a date, a premium that moved. */
function sameAnalysisRequest(a: StrategyAnalysisRequest | null, b: StrategyAnalysisRequest | null): boolean {
  if (!a || !b || a.legs.length !== b.legs.length) return false;
  const tick = (v: number) => Math.round(v * 20) / 20;                 // a 5-paise move is not a new analysis
  for (let i = 0; i < a.legs.length; i++) {
    const x = a.legs[i]!;
    const y = b.legs[i]!;
    if (x.strike !== y.strike || x.expiry !== y.expiry || x.right !== y.right || x.action !== y.action) return false;
    if (tick(Number(x.price)) !== tick(Number(y.price))) return false;
  }
  return tick(Number(a.spot)) === tick(Number(b.spot));
}
```

and stop putting the tick in the body at all, which is the smaller and better version of the same fix: price the
legs from the ladder read (`quote.price`, `basket-desk.ts:440`), not from the socket, and let the spot in the
request be the ladder's own — `PayoffChart.tsx:268` and `:311` then lose `spot` from their dependency lists
(`:308`, `:359`) and C1 disappears without a throttle. PR #51 chose the throttle (`useThrottledValue(spot, 250)`
at `:246`, still in `virtualBasket` deps at `:308` and `preparedChains` deps at `:359`), which turns 10 POST/s
into 4 POST/s. That is the difference between a stutter and a stall, not a fix.

**c2. Cap the retention that C1 was filling (M1).** `queryClient.ts:46-58` sets no `gcTime`:

```ts
    queries: {
      staleTime: QUERY_CONFIG.STALE_TIME_NORMAL,
      // A screen that moved on should not carry its old reads for five minutes: the analysis key is a whole
      // request body, so a fast patch used to add an entry every publish window.
      gcTime: 60_000,
      retry: QUERY_CONFIG.RETRY_COUNT,
```

**c3. Rate-cap the drawing, then the math (payoff target 10-15 FPS, not 60).** `liveSpot` (`:394`) feeds the
61-point grid math (`:529-530`), the integral (`:552-560`) and the three path strings (`:672-674`). Put one
throttle in front of that chain rather than three:

```ts
  const curveSpot = useThrottledValue(liveSpot, 100, (a, b) => Math.abs(a - b) < 0.05);
```

The hook at `:200` takes `(value, intervalMs)` only, so the deadband is a new third argument, not a call-site
change. A deadband matters more than the interval here: an axis that jitters by 5 paise recomputes ≈300 `bsm`
calls to draw the same line.

**c4. On "off-main-thread options math" — the honest answer for this runtime.** Hermes has no JS worker threads,
and the only off-thread compute surface actually installed in this app is the chart's WebView
(`react-native-webview` 14.0.1), which would cost a JSON `postMessage` and one to two frames of latency to save
the ≈300 `bsm` calls of a four-leg spread. That is the wrong trade: `bsm` (`:58-91`) is ~10 arithmetic ops plus
two transcendentals, so the four-leg curve is a sub-millisecond job on this class of phone; it only *looks* like
a heavy-math problem because C1 makes it run four times a second and then re-runs it when the response lands. So:
**cut the rate (c1-c3), keep the math on the JS thread, and do not add a worker, a worklet or a WebView
compute path for it.** If a 32-leg basket ever needs the full grid at speed, the fix is the grid — `:407` samples
61 points and `:529` evaluates every leg at every point, so a piecewise-linear expiry line with BSM only near the
strikes is an order-of-magnitude saving with no new runtime.

**c5. The chart's own series rebuild (M3)** is worth three lines in `live-candles.ts:276-280`: return the previous
array when the folded bar matches the last bar it holds, so a tick that only re-prices an already-drawn bar stops
rebuilding ≈150 objects per publish. The `terminal-charts.tsx:500-510` map then stops running, and
`KLineChart.tsx:789-802` already patches the one bar that moved.

**Target rates after (a)-(c),** which is the honest ceiling for these surfaces on this runtime:
chain and payoff **6-10 Hz** (100-150 ms window, unchanged), the server analysis **≤0.5 Hz**, the chart
**tick-for-tick on the patch path** with no full-series rebuild, the book **per tick for its own symbol only**.

### 9.6 What PR #51 already repairs, and what survives it

Scored against the merged tip `c93996f`. The PR head was `533df0e`; the branch moved mid-pass and this table was
re-read from it after the merge.

| Finding | In #51? | Evidence |
|---|---|---|
| C3 chain cells all repaint | **Fixed on the tick path, open on the render path** | `option-chain.tsx:445` subscribes without re-rendering (`useQuoteSubscription` + `NOOP_WATCHER`, `websocket.ts:639`, `:645-652`); `OptionLegCell`/`SpotDisplay` take their own tick (`option-chain.tsx:146`, `:199`, `quote-store.ts:88-90`), so a publish no longer repaints rows whose strike did not move. `renderItem` (`:824`) and `openTicket` (`:583-594`, from `useOrderTicket.tsx:374`) are still new on every screen render |
| H4 book screen | **Not fixed** | `stock.tsx:54` keeps the feed out of React, but `:55` renders the whole screen on its own symbol's tick and `:56-64`, `:170-173`, `:326-337` are still unmemoized |
| H3 memory rewritten | **Attenuated on the chain, untouched elsewhere** | the ladder effect now depends on `[quotes, items]` (`option-chain.tsx:454-457`), not `feed.quotes`; the cell effect (`:147-149`), `watchlist.tsx:430` and `IndexStrip.tsx:81-88` each still clone the whole memory on a live tick |
| M3 chart series rebuilt per publish | **Partly** | `live-candles.ts:276-280` checks the last bar's timestamp before rebuilding; `terminal-charts.tsx:500-510` still maps the whole array when it does |
| C1 tick → POST | **Attenuated, not removed** | `PayoffChart.tsx:246` throttles to 250 ms but `:308` and `:359` still carry `throttledSpot` into the body → ≤4 POST/s with ≤4 new cache entries/s; `:394` still re-enters the local math from the response |
| C2 unguarded suspend | **Survives** | `option-chain.tsx:817` still passes bare `pauseQuoteDispatch`; no hold count, no unmount release, no watchdog in `websocket.ts` |
| H1 hidden-tab subscriptions | **Survives** | `option-chain.tsx:445` and `watchlist.tsx:421` enable flags still ignore `focused` |
| H2 per-frame ingest cost | **Survives, halved** | `quoteKey` is still `JSON.stringify` at `websocket.ts:129`, now computed once per quote (`:299`); `armSilence` still calls `desiredInstruments()` per message (`:353`, from `:412` and `:422`); `snapshotFor` still copies the whole map (`:159`) |
| M1 no `gcTime` | **Survives** | `queryClient.ts:47-55` still has no `gcTime` |
| M2 table geometry | **Survives** | `SortableTable.tsx` is not in the PR's file list |
| M5 `tickByInstrument` per publish | **Chain call site removed** | the chain no longer calls it; `spread-builder.tsx:481` still does, on every publish |

So the PR fixes the per-tick re-render storm on the chain, and leaves the request storm, the suspend switch, the
hidden-tab ids, the book screen's own per-tick render and the retention cap. Those are what makes "the whole app
freezes" happen rather than merely look bad for a second, which is why §9.5 is ordered (a4) → (c1) → (a5) → (c2)
rather than by file.

### 9.7 Corrections to what this repository already says

| Where | Said | True state now |
|---|---|---|
| `MOBILE_CODE_FIXES.md` M5 | "`queryClient.ts:37` is `refetchOnWindowFocus: false`" | It is **`true`** — `queryClient.ts:52`, with the comment "Tied to AppState active status via focusManager". The consequence flips: the focus signal is honoured, so a foreground is a refetch burst (M4 in §9.2). **[V]** |
| `MOBILE_CODE_FIXES.md` M1/M2 | the per-frame cascade and the full-series replace | Both are the same territory as §9.2 C3/M3; #51 has since taken the cascade. Do not re-do them. **[V]** |
| `MOBILE_CODE_FIXES.md` M13 | `useOrderIntents` is an unconsumed 10 s poller at `hooks.ts:588-594`, `useBrokerLiveOrders` polls at `:599-607` | Both are now `refetchInterval: false` (`hooks.ts:1166`, `:1179`, each with a comment naming M13), `useOrderIntents` is consumed by `apps/mobile/app/(tabs)/orders.tsx:198`, and `useRealtimeQuotes.ts` is not in the tree. `/v1/orders/broker-live` still has no backend route. **[V]** |
| `MOBILE_CODE_FIXES.md` M14 | the 30-strike and full-ladder chain reads share one cache key | They do not: `queryKeys.optionChain.chain` takes the window into the key (`hooks.ts:308`), so `CHAIN_WINDOW = 30` (`:386`, `:401-402`, `:1021`) and `FULL_WINDOW = 400` (`:235`, `:1070-1072`) are separate entries. **[V]** |
| `PERFORMANCE_OPTIMIZATION_ROADMAP.md` | RN 0.74.5 / SDK 51 | The tree is Expo SDK 58 / RN 0.88.1 / React 19.3.0 (`package.json`, `android/gradle.properties` `newArchEnabled=true`). Any advice in that file premised on the old architecture — bridge thresholds, `InteractionManager`, turbo-module offloading — does not apply. **[V]** |
| `PERFORMANCE_AUDIT.md`, `AUDIT_LIVE_PRICES_AND_ORDER_SPEED.md` | vendor-feed assumptions | Superseded by §1 and §4 of this document. |

`react-native-svg` 15.16.0 is the only renderer in the payoff path and `@shopify/flash-list` is **not** a
dependency — so "switch the chain to FlashList" is not an available fix, and the chain's `FlatList`
(`option-chain.tsx:810-823`) is already configured about as well as it can be. Any recommendation that assumes
either of those two things is not from this tree.

### 9.8 What this pass could not determine without running something

- Whether the 10 Hz ceiling is actually reached in prod, i.e. how many frames/s Breeze publishes per
  subscription, and therefore what share of §9.2's rates is real rather than worst-case. Needs a live socket.
- Whether a mid-drag unmount actually drops `onScrollEndDrag` on this RN version (C2's reachability). The
  defect — an uncounted, unreleased, unwatched flag — is **[V]**; the frequency is not established.
- How many ids `desiredInstruments()` typically holds, which sets H2's constant. It is the union over every
  mounted screen, and the band at `option-chain.tsx:434`, `:440-442` bounds only the chain's share of it. **[D]**
- The share of the reported GC pressure contributed by C1's retained query entries versus H3's clones. Needs a
  heap profile.

I ran none of those, so they stay questions. The one command this pass did run is the typecheck gate:
`npx tsc --noEmit -p apps/mobile/tsconfig.json` → exit 0, no output, 20:46:48 IST on this branch, whose source
tree is byte-identical to `c93996f` — every commit here touches only the two documents. That says §9's citations sit in a tree that compiles. It says nothing about frame times, and no
frame time in this section was measured on this tree.

Everything in §9.2 to §9.6 is a reading of merged main `c93996f`;
the code #51 replaced was read at `37b1056` and is marked "before #51" wherever it still matters.
