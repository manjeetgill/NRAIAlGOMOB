# Audit — speed of live price updates (tabs + chart) and speed of order execution

**Date:** 2026-11-24
**Tree:** `main` @ `c3082a5` + uncommitted edits, **plus** the prod backend on disk at `../backend/python/nraialgo`
**Mode:** read-only. No source file was modified. No order, cancel, preview or dry-run was fired.
**Companion document:** `PERFORMANCE_AUDIT.md` (general app speed). This one is the two paths you asked for.
**⚠ Superseded for the server-side parts by `AUDIT_ICICI_ONLY_PRICES_AND_ORDER.md`.** This document was written
assuming a market-data vendor feed plus several connected brokers. Only ICICI Direct is connected and used, so
its vendor-based conclusions (origin cadence, the 0.25 s "rate limit", post-close LIVE, per-provider fan-out,
`DAILY_LIMIT`, multi-leg pacing, the post-ACK observation) do not apply — read §4 of the ICICI-only document for
the retraction list. The mobile-side findings in this document (per-frame re-render cascade,
`StyleSheet.create`-per-render, WebView full-array `postMessage`, dead routes) still hold and are restated there.

## Method, and what is *not* in these numbers

Every value below is a literal read from source — an interval, a timeout, a TTL, a semaphore size, a `sleep()` —
attributed to `file:line`. **Nothing here is a measured latency.** No request was sent, no service was started,
no trace was taken, so there is not one millisecond of observed end-to-end time in this document.

Commands run, all read-only: `ls`, `grep`, `sed -n`, `git status`, `git diff`, `find`, `python -c` over
sourcemap JSON, and the Read tool. Two subagents did the same over the backend under the same constraints.

Prod already instruments three of these paths and its own numbers are the fast way to replace my estimates —
see "Read the numbers prod already emits" at the end.

Legend: **[V]** verified by me in this session · **[A]** from a delegated backend trace · **[D]** derived from
code bounds, not measured.

---

# PART 1 — Speed of live price updates

## 1.1 Where prices come from: push, not poll **[A]**

| Fact | Value | Evidence |
|---|---|---|
| Vendor feed (Accelpix `pix-apidata==1.3.5`, TrueData `truedata==7.0.3`) is **callback push** | no tick interval | `backend/python/nraialgo/services/market_data/vendor_worker.py:125-179`, `:149-152`, `:182-223` |
| Explicitly un-throttled on the vendor side | "Each callback batch is drained fully, **without tick throttling**" | `vendor_worker.py:4-5` |
| No sampling or fixed tick rate in routing | "there is **no tick sampling, fixed tick rate, or quiet-instrument failover timer**" | `services/market_data/routing.py:6-8` |
| Broker streams (ICICI Breeze, Zerodha, Kotak) are also push; their 5 s timers are heartbeats only | 5 s heartbeat | `brokers/stream_worker.py:444-457`, `:221-222`, `:566-568`, `:595`, `:659` |
| In default `role=all` config, **nothing polls the broker for quotes on a timer** | not found | `deploy/docker/Dockerfile.api:48`, `deploy/vps/compose.yaml:72` |

The 5 s loops in `vendor_worker.py:170-176` and the `time.sleep(1)` at `:220` are health monitoring. They are
**not** a price poll, and mistaking them for one would put 1-5 s of latency on a path that has none.

## 1.2 The one tick's journey, stage by stage **[A][D]**

| # | Stage | Bound in code | Evidence |
|---|---|---|---|
| 1 | Vendor/broker callback fires | 0 (push) | `vendor_worker.py:131-137`, `stream_worker.py:444` |
| 2 | Child process → API process, line-delimited JSON on stdout | 30 s health deadline only | `services/market_data/runtime.py:328-342`, `brokers/streams.py:435-451` |
| 3 | Validate + write into an in-process dict | synchronous | `routing.py:134-173`, `streams.py:202-228`, `:222` |
| 4 | `notify(workspace)` → drop projection cache, `event.set()` | synchronous | `streams.py:271-280` |
| 5 | **Coalescing window: the projection cache is TTL 0.25 s** | **0.25 s** | `brokers/streams.py:843-854` (`now - cached[0] < 0.25`, LRU 64) |
| 6 | Build delta frame, `send_json` | send deadline 5 s | `api/quotes.py:22-28`, `:161` |
| 7 | Idle floor — a client with **no** ticks still gets a frame | every **5 s** | `api/quotes.py:163` `asyncio.wait_for(event.wait(), timeout=5)`, TimeoutError swallowed `:166-167` |
| 8 | Client parses frame, merges into `published` Map | — | `mobile-app/packages/shared/src/api/websocket.ts:153-166` |
| 9 | Client publishes a snapshot per watcher, per frame | — | `websocket.ts:129-131`, `:119-127` |
| 10 | Client sets React state per frame | — | `websocket.ts:288-290` |

**So the server-side floor between an exchange tick and a frame leaving prod is ~0.25 s**, set by
`brokers/streams.py:848`. That is the only deliberate coalescing on the path, and it is a good number.
The stall cases are elsewhere:

- A silently stalled ICICI socket is only detected after **20 s** of in-session silence (`streams.py:97`,
  `LIVE_SILENT_STREAM_SECONDS`), then reconnects on `min(60, 2 ** min(attempt, 6))` s backoff (`:557`).
- An idle stream is reaped after **90 s** (`streams.py:917`), and a vendor book is dropped when its consumer
  stops (`runtime.py:391`) — the comments state plainly that a restart "clears every tick the socket had
  already accepted" (`streams.py:876-892`) and reconnect "cannot revive old session data as current"
  (`runtime.py:320-323`). **A phone returning after 90 s+ idle therefore reconnects onto an empty tick book
  and shows no prices until resubscribe** — and this app has no `AppState` handling to notice the return
  (`PERFORMANCE_AUDIT.md` §C).

## 1.3 Freshness labels: the numbers that decide what a price is *called* **[A]**

| Label rule | Value | Evidence |
|---|---|---|
| `LIVE` max age | **15 000 ms** (`DEFAULT_LIVE_MAX_AGE_MS`) | `services/market_data/freshness.py:67`, clamps 100 ms…10 min at `:95-99` |
| `DELAYED` ceiling / `STALE` boundary | **60 000 ms** | `freshness.py:68` |
| Broker `fresh` test | `price > 0 and -5 <= age <= live_max_age_seconds()` and stream state `== 'streaming'` | `brokers/streams.py:190-199`; `services/quote_selection.py:97` |
| Vendor `fresh` test | exactly `dataStatus == LIVE` | `routing.py:264-266` |
| Tick rejected as too far in the future | `> 5` s | `streams.py:208` |
| Network-gap figure published on every quote | `networkLatencyMs = received_at - market`; `lateDelivery` when it exceeds 15 s | `freshness.py:238`, `:270` |
| Order-entry price guard | `ORDER_MAX_QUOTE_AGE_SECONDS = 15`, `min(15, live)` | `freshness.py:114-119` |
| `ageMs` deliberately **not** published | "they change on every snapshot, which would turn every delta frame into a full frame" | `freshness.py:277-279` |

**Useful consequence:** `networkLatencyMs` is already in every frame, so prod's own vendor-stamp-to-receipt gap
is observable without any new instrumentation — that is the number to watch, not a guess.
`[A]` Env overrides `NRAIALGO_LIVE_MAX_AGE_MS` / `NRAIALGO_STALE_MAX_AGE_MS` exist (`freshness.py:59-60`) but are
not set anywhere in `deploy/`; the runtime `.env.api` is outside the repo, so **could not determine** whether
prod overrides them.

## 1.4 Where the phone loses time: the client re-renders the whole book once per frame **[V]** P0

No coalescing exists on the client side of step 10 above:

- `setFeed({ ...next, reason })` creates a **new object identity per frame, per watching screen** —
  [websocket.ts:288-290](file:///C:/Users/manje/Downloads/NRAIAlgo-Python-main/mobile-app/packages/shared/src/api/websocket.ts#L288)
- `snapshotFor()` copies **every** published tick and then filters, per watcher, per frame —
  [websocket.ts:119-127](file:///C:/Users/manje/Downloads/NRAIAlgo-Python-main/mobile-app/packages/shared/src/api/websocket.ts#L119)
- Each screen's memo is keyed on that fresh array, so the entire book is re-marked per frame:
  [portfolio.tsx:128-130](file:///C:/Users/manje/Downloads/NRAIAlgo-Python-main/mobile-app/apps/mobile/app/(tabs)/portfolio.tsx#L128),
  [watchlist.tsx:216-217](file:///C:/Users/manje/Downloads/NRAIAlgo-Python-main/mobile-app/apps/mobile/app/(tabs)/watchlist.tsx#L216)
- **`React.memo` appears nowhere in the app** (`grep -rn "React.memo\|= memo(" apps/mobile` → 0 hits), so every
  visible row re-renders with it.

Practical effect: at a busy 4-8 ticks/s the JS thread does `frames × (rows × columns)` formatting work per
second. The frame arrives in ~0.25 s; the *displayed* price is behind by however long that reconciliation takes.

## 1.5 The chart path — good data layer, bad paint layer **[V]** P0

The tick→bar logic is genuinely fast and correct:
[live-candles.ts:226-285](file:///C:/Users/manje/Downloads/NRAIAlgo-Python-main/mobile-app/packages/shared/src/api/live-candles.ts#L226)
folds each tick into the forming bar incrementally, keyed by symbol+interval+bucket start, and never re-polls.
Everything slow about the chart is **after** that, in the WebView:

| # | Defect | Evidence |
|---|---|---|
| 1 | **Whole candle array JSON-serialised across the RN bridge on every data change** — `postMessage(JSON.stringify({ type: "update", data }))` | [KLineChart.tsx:152](file:///C:/Users/manje/Downloads/NRAIAlgo-Python-main/mobile-app/apps/mobile/src/components/KLineChart.tsx#L152) and `:165` |
| 2 | **Full dataset reset per update** — the handler calls `chart.applyNewData(klineData)`, which replaces the series, instead of the incremental update API | [KLineChart.tsx:118](file:///C:/Users/manje/Downloads/NRAIAlgo-Python-main/mobile-app/apps/mobile/src/components/KLineChart.tsx#L118) |
| 3 | **Intraday is unbounded**: daily is capped at 120 bars but every other bucket passes `limit = 0`, which means *all* bars the record returns, and all of them are re-serialised per tick | [terminal-charts.tsx:100](file:///C:/Users/manje/Downloads/NRAIAlgo-Python-main/mobile-app/apps/mobile/app/terminal-charts.tsx#L100) (`isDaily ? DAILY_CANDLES_SHOWN : 0`) |
| 4 | Per-tick O(n) min/max done with **argument spreads** — `Math.max(...highs)`, `Math.min(...lows)` — over the full array | [terminal-charts.tsx:122-127](file:///C:/Users/manje/Downloads/NRAIAlgo-Python-main/mobile-app/apps/mobile/app/terminal-charts.tsx#L122) |
| 5 | Every frame re-runs 1-4 because `live.points` is a new array per tick, feeding `useEffect([data])` | [terminal-charts.tsx:107-116](file:///C:/Users/manje/Downloads/NRAIAlgo-Python-main/mobile-app/apps/mobile/app/terminal-charts.tsx#L107) → `KLineChart.tsx:163-166` |
| 6 | Symbol or interval change **reloads the entire WebView and re-reads the 234 KB library from disk** | [terminal-charts.tsx:220](file:///C:/Users/manje/Downloads/NRAIAlgo-Python-main/mobile-app/apps/mobile/app/terminal-charts.tsx#L220) (`key={chartKey}`) + [KLineChart.tsx:41-45](file:///C:/Users/manje/Downloads/NRAIAlgo-Python-main/mobile-app/apps/mobile/src/components/KLineChart.tsx#L41) |

So per tick on a live chart today: new array → `JSON.stringify` of every bar → bridge → `applyNewData` full
series reset → chart repaint. That is the dominant cost of "the chart updates slowly", and it is not the feed.

## 1.6 Tabs that are REST-polled, and what each is actually bounded by **[V][A]**

| Surface | Client cadence | Server TTL / cold cost | Bound by |
|---|---|---|---|
| Index strip | 15 s poll, staleTime 5 s — [hooks.ts:704-713](file:///C:/Users/manje/Downloads/NRAIAlgo-Python-main/mobile-app/packages/shared/src/api/hooks.ts#L704) | `STRIP_TTL = 5` s; REST refill at most every `STRIP_REST_SECONDS = 30` s and only when the held row is ≥ `STRIP_REFILL_AGE = 40` s old — `services/option_chain_service.py:74-78`, `:732-743` | Cache. Poll is slower than TTL → most polls are hits. Worst-case strip age ≈ 40 s + 15 s poll |
| Watchlist | 2 s while `pricesPending`, else 5 s — `hooks.ts:379-384` | First-paint budget `DRAWER_PAINT_SECONDS = 0.35` s (answers fast, **without prices**, `pricesPending: true`); seed budget 6.0 s; hard 8.0 s — `services/watchlist.py:81-83`, `:208-232` | **ICICI REST pacing** when a row has no streamed tick — see below |
| Option chain | 1 s streamed-tick read while market open, TTL 5 s / 30 s streamed / 60 s closed — `hooks.ts:691-699`, `option_chain_service.py:79-82` | `QUOTE_CAPACITY = Semaphore(6)`, `CAPACITY = 4`; 429 at 24 in-flight per workspace, `Retry-After: 2` — `brokers/runtime.py:30-41`, `:100`, `:292-295` | Admission queue under load, not the tick |
| Portfolio | 5 s account poll, staleTime 3 s — `hooks.ts:343-347` + `useIciciAccount` `:355-362` | Account read = **6 ICICI calls**; dirty check every 1 s, account cadence 30 s, read-model TTL 120 s — `services/account_feed.py:20-28`, `services/account_read_model.py:27-30` | Server dirty-propagation (fast, ~1 s) then the phone's 5 s poll |
| Orders tab | account poll 5 s + GTT 10 s — `orders.tsx:80-81`, `hooks.ts:679-685` | as above | the phone's poll |

**The dominant watchlist number, and it is a pacing limit not a bug** **[A]**: ICICI is read at
`WATCH_READ_PACE_SECONDS = 0.65` per symbol with `PACED_BATCH_SIZE = 5`
(`brokers/shared/watch.py:15-27`, sleep at `brokers/icici/watch.py:38`), so one 5-symbol batch costs
`4 × 0.65 + 5 × 0.15 = ` **3.35 s**, and the 50-symbol cap (`MAX_WATCH = 50`) would need ~33.5 s against a
6.0 s seed budget — so **only about 2 batches (≈10 symbols) can ever be priced per pass**. Rows beyond that are
not slow; they are never reached by the REST fallback. This is exactly why the socket (0.25 s) matters more
than the poll, and why `pricesPending` exists.

## 1.7 Dead price pollers found — none currently costing anything, all latent traps **[V+A]**

| Client code | Cadence | Reality |
|---|---|---|
| `useMarketQuotes` → `GET /v1/quotes` | `refetchInterval: 1000`, staleTime 500 — `hooks.ts:691-699` | **No such route.** The only quote routes are `/v1/quotes/stream` (websocket), `/v1/quotes/session`, `/v1/quotes/preferences` — `api/quotes.py:35,45,58`. Nearest is `/v1/hub/quotes` (`api/hub.py:51`). Currently no caller in mobile (`grep useMarketQuotes apps/mobile` → none), so today's cost is zero; the moment anything mounts it, it requests a 404 once a second |
| `useBrokerLiveOrders` → `GET /v1/orders/broker-live` | 10 s — `hooks.ts:592-603` | **No such route** (`grep -rn "broker-live" backend/python/nraialgo/` → 0 hits; the orders router is `execution/api.py:133`, routes listed at `:145-337`). No mobile caller today either |
| `/v1/indices`, `/v1/depth/{symbol}` in client constants | — | Neither route found under `backend/python/nraialgo/api/` — `constants/index.ts:51-53` |

## 1.8 Live-price scorecard

| Question | Answer from code |
|---|---|
| Fastest a streamed price can reach the phone | ~**0.25 s** server coalescing (`streams.py:848`) + one frame send + network |
| Rate at which a screen re-renders | **once per frame**, uncoalesced, whole book re-marked, no memo — P0 client defect |
| Chart paint | full-array bridge reserialise + `applyNewData` reset per tick — P0 client defect |
| Intraday chart size | **unbounded** (`limit = 0`) |
| After the app has been backgrounded >90 s | empty tick book until resubscribe; nothing notices the return |
| A quiet symbol | frame every 5 s whether or not anything changed (`api/quotes.py:163`) |
| A row with no streamed tick on the watchlist | REST fallback at 3.35 s per 5 symbols → ~10 symbols per pass |
| Label honesty | LIVE ≤15 s, DELAYED ≤60 s, order guard ≤15 s |

---

# PART 2 — Speed of order execution

## 2.1 Two different send paths, and they are not equally fast **[V]**

| Path | Awaits before the broker could possibly know | Evidence |
|---|---|---|
| **Cash ticket** (watchlist / chain / terminal → `BuySheet`) | **1** round-trip: `POST /v1/orders` | [useOrderTicket.tsx:196](file:///C:/Users/manje/Downloads/NRAIAlgo-Python-main/mobile-app/packages/shared/src/hooks/useOrderTicket.tsx#L196), payload built at `:181` |
| **Options basket** (`spread-builder`) | **2 serial** round-trips: `POST /v1/orders/option-drafts` **then** `POST /v1/orders` | [spread-builder.tsx:633-641](file:///C:/Users/manje/Downloads/NRAIAlgo-Python-main/mobile-app/apps/mobile/app/spread-builder.tsx#L633), comment at `:631-632` states "Two calls, one press" |

The two-call design is deliberate and correct for safety — prod refuses the whole basket if any leg is not a
contract it can trade, so nothing reaches the broker unless the set resolves. It is not the thing to remove.
What is actionable is the cold path underneath the first call (§2.3) and the timeout mismatch (§2.4).

## 2.2 What the server does inside the 202 — no broker call at all **[A]**

`POST /v1/orders` is `@router.post('', status_code=202)` (`execution/api.py:223`); the docstring at `:130`
says admission returns 202 *because execution and reconciliation are asynchronous*.

Handler spine (`execution/service.py:203-271`), all synchronous in the request, **zero broker HTTP**:

| Step | Kind | Note |
|---|---|---|
| session identity SQL (4×EXISTS CTE) | S | `api/auth.py:58-88`; `:64` reuses only for GET/HEAD, **so a POST always re-runs it** |
| membership proof | S | `core/private_members.py:34-62`, no SQL for an owner workspace |
| edition/policy check | S | contextvar reads only — `core/editions.py:118-130` |
| idempotency probe `repository.get(user, clientId)` | S | `service.py:222` → `execution/repository.py:131-138` |
| enabled gate / worker heartbeat gate / rate bucket | S | `models.py:44-50`; `repository.py:233-238` (heartbeat within **30 s** else 503); `reserve_attempt(user,'execution-admission',12,60)` → **429 on a 13th press in 60 s** |
| `configuration` + `session` in parallel, + AESGCM decrypt | S | `api/brokers.py:263-297` |
| **`repository.accept(...)`** — the heavy transaction | S | `service.py:264-266` → `repository.py:240-417`; ~20-25 statements incl. `users FOR NO KEY UPDATE`, `lock_execution_halt()`, `execution_accounts FOR UPDATE`, ~10 risk/control reads, INSERT intent + per-leg INSERTs |
| `repository.view` + `admissionMs` | S | `:270-271` |
| claim / lease / SDK subprocess / broker place | **D** | separate process role — `execution/worker.py:175-225`, `:454-476` |

~**10-11 serial DB transaction groups** before the client gets its 202, each needing a pooled connection
(`database/store.py:103-110`: pool max 16 default, acquire timeout 10 s, `statement_timeout=5000`,
`lock_timeout=3000`). The receipt already reports **`admissionMs`** (`service.py:271`) — that is prod's own
measurement of this section, and it is the first number to look at.

## 2.3 The deferred half, and the number that actually sets perceived speed **[A][D]**

| Phase | Bound | Evidence |
|---|---|---|
| Wake the worker | ~0 s via `pg_notify('nraialgo_execution_wakeup')` + `LISTEN` | `repository.py:414`, `execution/wakeups.py:12-35` |
| Idle fallback | ≤1 s poll of `wake.wait()` | `worker.py:639` |
| Claim | `FOR UPDATE ... SKIP LOCKED`, lease 120 s | `repository.py:463`, `:478` |
| Broker place | **≤30 s**, exactly **one** write, **no placement retry** | `worker.py:54-60`, `:88`, `:463`; `brokers/shared/external_execution.py:113`; `execution_policy.py:925-942` |
| ICICI write read timeout | **30 s** (`(3, 30)` connect/read for non-GET) | `brokers/icici/transport.py:200-203` |
| Broker-confirmed state, **single-leg** order | next pass: **3 s** default | `worker.py:188` (`delay, message = 3, None`) → `repository.py:494-504`; `next_delay()` returns `None` for `< 2` legs at `worker.py:517-518` |
| Multi-leg basket | 1.1 s / 1.5 s | `worker.py:50-51`, `:508-525` |
| Stream hint bypass | throttled to 1/s, sets `next_attempt_at = now()` and re-notifies | `brokers/streams.py:513-516`, `repository.py:1045-1068` |
| Client sees it | poll every **1000 ms** while unsettled | [hooks.ts:638-641](file:///C:/Users/manje/Downloads/NRAIAlgo-Python-main/mobile-app/packages/shared/src/api/hooks.ts#L638) |

**Most important finding on perceived speed** **[A][D]**: an *immediate* confirmation lookup exists only in the
non-broker-first path — `worker.py:424-433` "Replace the first delayed poll with one immediate, bounded
observation" — and is **deliberately absent** from broker-first: `worker.py:473-474` "No immediate status
lookup here". Since `NRAIALGO_BROKER_FIRST` defaults to `'true'` (`models.py:53-59`) and the comment at
`service.py:258-260` says broker-first is the placement path for *every* order, a **single-leg order normally
waits the 3 s re-check (or a ≤1 s stream hint) before its state is confirmed at all**, and the phone then adds
0-1 s of poll. Multi-leg baskets get 1.1-1.5 s; single orders do not.

## 2.4 The timeout mismatch I could prove from both sides **[V+A]** P0

| Fact | Value | Evidence |
|---|---|---|
| Mobile aborts **every** request at | `timeout = 30_000` default → `AbortController.abort()`, surfaced as **408 / `"TIMEOUT"`** | [client.ts:66-69](file:///C:/Users/manje/Downloads/NRAIAlgo-Python-main/mobile-app/packages/shared/src/api/client.ts#L66), `:136-140` |
| A cold contract resolution can take | `chain_contracts` **`timeout=45`**, or the measured cold derivatives-master query at **21.9-30.2 s** | `execution/option_drafts.py:160-161`, comment at `:84-85` |
| Consequence | **The phone gives up before prod finishes resolving contracts.** The basket never reached the broker (drafts create nothing, `hooks.ts:616-620`), yet the copy the trader then sees is the ambiguous one: "This basket may still reach the broker. Do not send it again - check Orders." | [spread-builder.tsx:649-654](file:///C:/Users/manje/Downloads/NRAIAlgo-Python-main/mobile-app/apps/mobile/app/spread-builder.tsx#L649) |

Two fixes fall out, and they are independent: raise or special-case the drafts timeout above the server's own
45 s ceiling, and distinguish *"the resolver timed out — nothing left this device"* from *"the answer to a send
was lost"*. The current `refused = typeof error.status === "number"` test at `:653` cannot tell a 408 from a
408-on-a-send, so both land on the scary message.

Mitigations already in place server-side: in-process `_CONTRACTS` cache (`option_drafts.py:24-25`, 16
underlyings), `warm()` (`:110-136`), a 60 s prewarm loop (`worker.py:643-673`), and the on-disk
`InstrumentCache` (`brokers/shared/instrument_cache.py:45-95`). A *warm* drafts call is milliseconds; the
exposure is a cold master, which is a startup and a first-order-after-deploy problem.

## 2.5 Re-send safety and its time cost **[V+A]**

| Fact | Value | Evidence |
|---|---|---|
| All mutations retry once, 1 s apart — **including `POST /v1/orders`** | `retry: 1`, `retryDelay: 1000` | [queryClient.ts:23-26](file:///C:/Users/manje/Downloads/NRAIAlgo-Python-main/mobile-app/apps/mobile/src/utils/queryClient.ts#L23), `constants/index.ts:256` |
| That re-POST is harmless because the key is the client's own UUID and the server answers a repeat from the DB without touching the broker | `clientId: UUID`, `repository.get`, `repeat: True` | `execution/api.py:77-91`; `service.py:222-229` |
| But on a timeout it doubles the wait | worst case ~30 s + 1 s + 30 s | derived from `client.ts:66` + `queryClient.ts:25` **[D]** |
| The server never replays an ambiguous place | `unknown("Broker acknowledgement is uncertain. Reconcile; do not resend.")`; a place that times out becomes `state: 'unknown'`, delay 30 s | `execution_policy.py:175-202`; `worker.py:465-469`, `:211` |
| Client-side guard against double-press | `sending` state + `setSentId("")` on every edit | `spread-builder.tsx:628`, `:643`, `:494`, `:506` |

Recommendation stands to verify rather than assume: for the order mutation specifically, `retry: 0` is the
honest policy — the resend is safe, but it buys nothing and can add 31 s to a "did it go?" answer.

## 2.6 What the mobile app does **not** do after a cash order **[V]** P1

`usePlaceOrder.onSuccess` invalidates `orders.intents` and `positions.open`
([hooks.ts:605-613](file:///C:/Users/manje/Downloads/NRAIAlgo-Python-main/mobile-app/packages/shared/src/api/hooks.ts#L605))
— but the Orders tab reads **neither**: it uses `useIciciAccount` (5 s) and `useGttOrders`
([orders.tsx:80-81](file:///C:/Users/manje/Downloads/NRAIAlgo-Python-main/mobile-app/apps/mobile/app/(tabs)/orders.tsx#L80)),
and `useOrderIntents` has no mobile caller. And unlike the basket screen, the cash ticket never starts
`useOrderSnapshot`, so there is **no per-order status poll at all** on that path
(`useOrderTicket.tsx:196-206`; the ticket only calls `config?.onSuccess?.(...)`).

Consequence: after a market order the phone's confirmation depends on the server's 1 s dirty check plus the
phone's **5 s** account poll, not on the 1 s snapshot that already exists for exactly this purpose. Typical
derived figure 3 s + 0-5 s **[D]**.

## 2.7 Shared resources that make one slow order slow everyone else **[A]**

- `asyncio.timeout()` **encloses the semaphore wait**, so queued work burns the caller's ceiling —
  `brokers/runtime.py:188-192` ("queued work cannot remain alive indefinitely")
- `EXECUTION_CAPACITY = Semaphore(4)` (`:40`) gates every execution op **and** `chain_contracts` /
  `equity_order_symbols` → four 30 s places saturate order-path work process-wide
- Per-account warm SDK process holds one `asyncio.Lock` for the whole command — `warm_reader.py:42`,
  `:64-67`, docstring "**commands for one account run one at a time**", `LIMIT = 8` processes `:25`
- Worker concurrency default 2 (`NRAIALGO_EXECUTION_CONCURRENCY`, `worker.py:610`), DB pool forced to 4 in
  that process (`:585`), heartbeat 5 s (`:614-623`), and admission returns **503** if the heartbeat is older
  than 30 s (`service.py:237-238`)
- Locks taken *before* any send: `lock_execution_halt()` instance-wide (`execution/controls.py:21`),
  `users FOR NO KEY UPDATE` per user (`repository.py:297`), `execution_accounts FOR UPDATE` per account
  (`:369`); cross-process quarantine refuses while `dispatched_at` is within 60 s ("SDK calls are bounded to
  45 s") — `repository.py:933-936`, `recovery.py:79-83`
- An order that never gets an account slot dies at `authority_seconds()` (default **60 s**, bounds 30-300) —
  `models.py:143-152`, `repository.py:393-395`, `expire_unstarted()` `:1018-1038`
- `execution/errors.py:59-86` defines per-stage PostgreSQL budgets (`execution_place: 30000`,
  `preflight: 45000`, `execution_lookup: 15000`, …) but **nothing imports them** — only `preflight_timeout`,
  `preflight_total_timeout`, `preflight_error`, `MESSAGES` are used anywhere. So the global 5 s
  `statement_timeout` is the only DB bound in force, and the accept transaction's heaviest reads run
  un-budgeted. **[A]** — worth a second look before acting.

## 2.8 End-to-end timeline for the default manual ICICI order **[D]**

| Phase | Bound | Source |
|---|---|---|
| Drafts, warm | ~ms | `option_drafts.py:24-25` |
| Drafts, cold | up to **45 s** / measured 21.9-30.2 s | `option_drafts.py:160-161`, `:84-85` |
| Client aborts at | **30 s** | `client.ts:66` |
| `POST /v1/orders` receipt | ~10-11 DB groups, 0 broker calls, reported as `admissionMs` | `service.py:203-271`, `:271` |
| Wake → claim | ~0 s (`pg_notify`), ≤1 s idle | `repository.py:414`, `wakeups.py:22`, `worker.py:639` |
| Broker place | one write, ≤**30 s**, never retried | `worker.py:56-60`, `external_execution.py:113` |
| First broker-confirmed state | **3 s** single-leg / 1.1-1.5 s multi-leg / bypassed by a ≤1 s stream hint | `worker.py:188`, `:50-51`, `:517-518`, `streams.py:513` |
| Client sees it | within **1 s** poll | `hooks.ts:639-641` |
| Cash order instead | no snapshot poll; account poll every **5 s** | `useOrderTicket.tsx:196-206`, `orders.tsx:80` |

**Nothing was placed to produce any number above.** No endpoint was called, no script was run, no service
started. Every figure is a bound read out of source.

---

# Read the numbers prod already emits — do this before changing any code

Three instruments already exist and would replace every `[D]` above with a measurement:

| What | Where it is emitted | What it answers |
|---|---|---|
| `admissionMs` on the order receipt | `execution/service.py:271` (also on repeat, `:228-229`) | how long `POST /v1/orders` holds the trader |
| `queue_ms`, `ack_ms`, `state_age_ms` per leg | `GET /v1/orders/{client_id}` → `repository.py:49-57`, `:86-97` ("This is the read a speed desk polls", `api.py:292-293`) | exactly where an order's wall-clock goes after admission |
| `Server-Timing: option_chain;dur=…` | `api/option_chain.py:55` | chain/strip server cost per call |
| `networkLatencyMs`, `lateDelivery` on every quote | `services/market_data/freshness.py:238`, `:270`, published in `PUBLISHED` `:280-281` | vendor-stamp → prod-receipt gap, already in each frame |

Plus one client-side figure that is not instrumented anywhere: the gap between a frame arriving in
`websocket.ts` `onmessage` and the row actually repainting. That is the number the P0 client findings are about,
and nothing currently measures it.

## Priority, if you want fixes next

| # | Fix | Path | Why it ranks here |
|---|---|---|---|
| 1 | Coalesce to one `setFeed` per ~250 ms in `useRegistration`, and memo the row components | §1.4 | The phone throws away the server's 0.25 s budget by reconciling the whole book per frame |
| 2 | Raise/scope the drafts timeout past prod's 45 s ceiling, and separate "resolver timed out, nothing was sent" from "send answer lost" | §2.4 | The only finding here that can make a safe action look like a committed order |
| 3 | Chart: incremental `updateData` instead of `applyNewData`, send only the changed tail, cap intraday bars | §1.5 | Turns the per-tick cost from O(all bars × bridge) into O(1) |
| 4 | Have the cash ticket poll `useOrderSnapshot` like the basket screen does | §2.6 | 1 s confirmation using an endpoint built for it, replacing a 5 s account poll |
| 5 | Add `AppState` resume handling: reconnect the stream and refetch on foreground | §1.2 | Removes the empty-tick-book-after-idle blank screen |
| 6 | `retry: 0` for the order mutation | §2.5 | Removes up to 31 s from a "did it go?" answer; safe either way because of `clientId` |
| 7 | Measure first with the four prod instruments above | — | Converts every `[D]` in this document into a number |

Nothing in this document was applied.
