# Backend Code Fixes — ICICI (Breeze) Execution and Market Data

Actionable fix list derived from `AUDIT_ICICI_ONLY_PRICES_AND_ORDERS.md` (§2 prices, §3 execution, §8 stream-vs-REST).
This document contains **proposed changes only**. Nothing in it was applied.

| | |
|---|---|
| Code root | `C:\Users\manje\Downloads\NRAIAlgo-Python-main\backend` (git `90209e83e`), package `python\nraialgo` |
| Companion doc | `MOBILE_CODE_FIXES.md` — the client half of B5, B7, B8 |
| Written | 2026-11-24, ~15:00 IST |
| Source of every line number | Re-read in this session against the tree above. Where the audit doc's §2/§3 numbers have since shifted, this document uses the current ones and says so |

### Rails — read before touching anything

1. **No live order, cancel, amend, preview or dry-run** may be used to verify any item here. Verification is
   source reading, unit tests, log lines and Postgres reads only.
2. **Do not call a Breeze endpoint to "see what it returns."** Breeze REST calls are charged against roughly
   5,000 per day (`services/stream_marks.py:3-5`); a discovery loop spends the same budget the trader needs to
   trade. **[V]**
3. **Every item below keeps its REST fallback.** While an account is flagged `needsRead`, socket prices are
   deliberately suppressed (`services/stream_marks.py:72`, `services/quote_selection.py:81-82`). Removing a REST
   read as part of a push change is a correctness regression, not a cleanup. **[V]**
4. B2, B4 and B6 sit in the send path. Land **one behaviour per branch** there, not several at once — that is a
   standing rule for this system because a wrong state can lock an account and hold margin.

---

## P0 — the two that change what the trader sees

| ID | Fix | Where |
|---|---|---|
| B1 | Vendor-less post-close must produce `LAST_CLOSE`, not `STALE` | `services/quote_selection.py:139-142` |
| B2 | Pre-flight `BROKER_SESSION_EXPIRED` must classify as `rejected`, not `unknown` | `brokers/registry.py:63-66`, `execution/worker.py:465-469` |

### B1 — after close, every ICICI price is forced to STALE

**Symptom.** From 15:40 IST to the next 09:15, every price badge reads "old price" even though the broker printed
a real final price. LIVE/LAST_CLOSE is unreachable ~19 h/day in this deployment, because there is no vendor feed.

**Exact cause.** `services/quote_selection.py:139-142`:

```python
elif book is None:
    # No vendor: a broker's last observation is display-only, never LIVE.
    chosen = {**chosen, 'priceStatus': 'stale', 'dataStatus': 'STALE', 'fresh': False,
              'fallbackReason': 'broker-last-observation'}
```

This arm runs whenever `book is None` — which in an ICICI-only deployment is **always** — and it fires for
`CLOSED`, `HOLIDAY` **and** `PRE_MARKET` (`:135-136`). It overwrites a price the broker actually printed with a
STALE verdict.

**The state already exists; this arm just never reaches it.** `services/market_data/freshness.py:36` declares
`LAST_CLOSE`; `:244` assigns `status, reason = Freshness.LAST_CLOSE, 'official-session-close'`; `:323` maps
`Freshness.LAST_CLOSE: 'last-trade'`; and `:69` `DEFAULT_LAST_CLOSE_WINDOW_MS = 30 * 60_000` is the NSE
last-30-minutes close derivation. **[V]**

**Change.** Split the arm by session state instead of collapsing it:
- `CLOSED` / `HOLIDAY` → the dated-close route (`LAST_CLOSE`, `fresh` stays False, reason
  `official-session-close`), and `priceStatus` a non-STALE word the client can render as "last close".
- `PRE_MARKET` → keep an explicit pre-open status, distinct from both LIVE and STALE.
- Leave `:143-144` (`else: chosen = None`, the vendor-present case) exactly as it is.

**Verification, offline.** Assert on the returned dict for a broker tick plus a CLOSED session: `dataStatus ==
'LAST_CLOSE'` and `fallbackReason != 'broker-last-observation'`. Then assert the vendor-present branch is
byte-for-byte the same as before — that branch is what other deployments trade on.

**The client already knows this word, so no client change is needed.** `packages/shared/src/api/live-candles.ts:168`
maps `LAST_CLOSE: "Last close"` and `:183` uppercases before lookup, and `apps/mobile/src/components/IndexStrip.tsx:17-24`
is fed by lowercase `priceStatus` (`option_chain_service.py:680`), which the strip rows do have and `dataStatus` they
do not. Verified in `MOBILE_CODE_FIXES.md` ("B1's client half is already done"). **[V]**

**Risk.** A badge that now says "last close" must not read as tradable. `fresh` stays `False`, and the client's
order-pricing path uses `fresh` reads, not display status, so an order cannot inherit this value — confirm that
boundary holds before shipping. **[A]** for the tradability claim: I read the display path, not every consumer.

### B2 — an expired session is recorded as an uncertain send

**Symptom.** Place one ICICI order after the Breeze session has expired. The order lands in `unknown`, the account
is quarantined, margin is held for roughly the lease window, and a human has to resolve it — at the exact moment
re-auth is least available.

**Exact cause.** The refusal is deterministic and happens *before any broker call exists*:

`brokers/registry.py:63-66`
```python
if not isinstance(payload, dict) or not isinstance(payload.get("session"), dict):
    raise BrokerFailure("BROKER_SESSION_EXPIRED")
if moment(payload["session"].get("expiresAt")) <= datetime.now(UTC):
    raise BrokerFailure("BROKER_SESSION_EXPIRED")
```
`:67` is `adapter = adapter_class(...)`. So both raises precede the first line that can talk to ICICI. Nothing was
sent — that is not an inference, it is the control flow. **[V]**

`execution/worker.py:465-469` then collapses that exception into uncertainty along with genuine timeouts:
```python
except (BrokerFailure, TimeoutError) as error:
    code = failure_code(error)
    LOGGER.warning('execution_place_uncertain reference=%s code=%s', REFERENCE.get(), code)
    result = {'state': 'unknown', 'message': 'Broker acceptance is uncertain; this command will not be sent again.',
              'failureCode': code}
```

**Change.** Separate the two before `command_result` records them. A `BrokerFailure` carrying
`BROKER_SESSION_EXPIRED` (message already at `execution/errors.py:20`: *"The broker session expired. Reconnect
before submitting."*) — and any other pre-flight failure raised inside `registry` rather than by the adapter —
must yield `state='rejected'` with that message, not `state='unknown'`. `TimeoutError`, and any `BrokerFailure`
raised from inside the adapter after the socket was reached, keep `unknown`.

**Why safe.** `worker.py:475-476` already routes `state == 'rejected'` to `skip_queued`, so a multi-leg basket
stops sending the remaining legs — the behaviour you want here. **[V]**

**Verification, offline.** Force the expiry check to fail with a stubbed session and assert the recorded state is
`rejected`, the account is *not* quarantined, and no subprocess was spawned (the `adapter_class` line was never
reached). Then the paired case: stub a transport timeout and assert `unknown` is still what gets recorded. Proving
both halves matters — over-correcting would turn real uncertainty into a false "rejected".

**Blast radius.** Small, and it removes the worst-case incident in §3.2.

---

## P1 — order-path correctness and confirmation

| ID | Fix | Where |
|---|---|---|
| B3 | Give `broker_refusal` a session-key arm so our own failure stops being reported as ICICI's | `brokers/shared/external_execution.py:31-50` |
| B4 | Reconsider the deliberate absence of a post-ACK observation in broker-first | `execution/worker.py:471-474`, `brokers/streams.py:512-518` |
| B5 | Align the drafts timeout with the client's abort budget (paired with client M4) | `brokers/runtime.py:128`, `api/strategy_drafts.py` |
| B6 | State whether today's ICICI instrument masters are actually warm, in a line you can grep | `execution/worker.py` prewarm / `warm_icici_masters` gate |

### B3 — two refusals that did not come from ICICI

`broker_refusal(provider, response)` at `external_execution.py:31` returns
`{'state': 'rejected', …, 'failureCode': 'BROKER_REJECTED', 'message': f'ICICI rejected this order: {reason}'}`
whenever the dict has an int `Status` that is not 200 and a non-blank `Error`, and no `Success` (`:41-50`). **[V]**
That is the right shape for a genuine Breeze refusal — and it also fires for a non-200 that our own code produced
locally (an expired session surfacing through the SDK, or an SDK-local 500), which then tells the trader *ICICI
rejected your order* when ICICI never saw it. At that moment the trader's reasonable next action is to change the
order, when the actual fix is to reconnect.

**Change.** Before classifying, check the response for the session/authentication markers Breeze uses and route
those to `BROKER_SESSION_EXPIRED` (`errors.py:20`) instead of `BROKER_REJECTED`; keep the plain-text sanitising
that is already there (`:47-48` strips non-word characters and anything token-shaped). **[V]** for the current
behaviour; **the exact Breeze strings for a session-level 401/500 are [D]** — I would not invent them, I would read
them off the next real occurrence in the logs, which is why B6 matters.

### B4 — the gap between ACK and the first evidence

`worker.py:471-474` is explicit: `observe()` runs, cache is invalidated, and the comment says *"No immediate
status lookup here: the accepted order releases the account … and fills arrive from stream hints or the next
check."* **[V]** The push side that would close it already exists — `streams.py:512-518` takes a Breeze order
event and, throttled to 1/s, calls `Repository.wake_from_stream(...)` — so a hint can wake the worker instead of
waiting for the periodic re-check. **[V]**

**Change.** Not a code change first: count it. Read how many orders had their first non-`queued` state supplied by a
stream hint versus by the periodic check (`AUDIT_ICICI_ONLY_PRICES_AND_ORDERS.md` §7 lists the columns already in
the order records). If the hint path is rarely the winner, the fix is in the hint plumbing, not in adding a lookup.
If it is the winner but arrives late, the useful change is to make the confirmation frame go out on the wake rather
than on the next tick. **[D]** until that count exists — I am deliberately not proposing a latency number.

### B5 — the abort window on a basket send

The client aborts at 30 s (`packages/shared/src/api/client.ts:66` `timeout = 30_000`, `:68-69` the abort timer,
`:136-140` maps `AbortError` → status 408 `TIMEOUT`). `brokers/runtime.py:128` gives `call_sdk(..., timeout=45)`,
and `api/strategy_drafts.py` sets no per-route override. **[V]** So a drafts call that legitimately needs 31-45 s
is abandoned by the phone *while the server is still working and may still commit* — an ambiguous outcome the
client's honest copy mitigates but does not fix.

**Change (backend half).** Either lower the effective server budget for the drafts endpoint to something the client
will not outrun, or make drafts+place one idempotent round-trip keyed on the existing `clientId`. **[A]** for which
is cheaper — it depends on how much of the 45 s is Breeze latency versus local work, and that is exactly what B6's
log line would tell you.

**Do not** solve this by raising the client timeout alone. That only moves the window; the trader waits longer on a
spinner that may already have committed.

### B6 — make the invisible state visible

Two things in this audit could not be determined from source, and both are cheap to answer from logs the code
already writes:

1. Whether today's `prewarm()` actually built the ICICI masters — `execution_masters_ready` /
   `execution_masters_unavailable` already exist as log lines, so a cold NFO master (which can rebuild ~85,000
   contracts inside its own place budget) is detectable before an order pays for it.
2. Whether a given client poll costs an **ICICI** REST call or is served from `quote_cache` — `notify()` drops that
   cache entry at `brokers/streams.py:273`, but no line says which routes hit or missed. **[D]** today.

**Change.** One counter per workspace per day of ICICI calls actually spent, tagged with the originating route.
That converts the poll-versus-push argument in audit §8 from reasoning into arithmetic, and it protects the budget
the trader needs.

---

## P2 — push surface: the backend already offers four transports the client ignores

Full case in the audit §8. Restated as backend work, because some of it is genuinely backend-side:

| ID | Item | Where | Kind |
|---|---|---|---|
| B7 | `/v1/hub/ws/orders` exists and is authenticated (`api/hub.py:158-201`), but I did not read `stream_reconciler.subscribe` to confirm whether it emits **fills and terminal states** or only reconciled order rows | `api/hub.py:196` | Read the reconciler, then either document the gap or close it |
| B8 | `/v1/quotes/stream` payload is prices only (`api/quotes.py:22-28`): `{asOf, mode, quotes, removed}` — no depth ladder, no order/position events, no market-status change | `api/quotes.py:22-28`, `:35-43` | Decide: add frames, or point the client at the SSE routes |
| B9 | Index prices are reachable server-side (`services/option_chain_service.py:701-731` `strip_quotes()`; `brokers/streams.py:306-319` force-subscribes the five headline names) but I could not confirm `NSE:INDEX:` ids reach a client through the quotes WS | `brokers/stream_worker.py:333-340`, `services/market_data/index_recording.py:31` | **[D]** — resolve before the client drops its 15 s strip poll |
| B10 | SSE capacity is 3 per kind per workspace, 20 globally (`api/overview.py:422-425`, `:483-486`, `:548-551`). If the client adds order + account + strip consumers naively it will hit 429 | same | Publish the intended topology: **one multiplexed connection per workspace**, not one per hook |
| B11 | `/v1/orders/broker-live` does not exist — `grep -rn "broker-live" api/*.py` returns nothing — while a shared hook polls it | client `hooks.ts:599-607` | Either add the route or delete the hook. A poller aimed at a missing route is a guaranteed 404 loop |
| B12 | Option/depth: socket depth views are cash-EQ only (`brokers/streams.py:653`, `:714` build the identifier with `'EQ'`/`'CASH'`) **[V]** — so an NFO depth request can never be satisfied by the stream | `brokers/streams.py:653`, `:714` | Return an explicit reason for a non-EQ depth request instead of an empty book, so the UI can say why instead of showing a blank |

B12 is deliberate: a blank with a durable source behind it is a defect. Say what is unavailable and why.

---

## Must stay REST — do not "optimize" these

Breeze has nothing to push here. Each row was read at the adapter call site.

| Data | Read site | Label |
|---|---|---|
| Positions | `brokers/icici/account.py:46` `get_portfolio_positions` | [A] no push subscription found |
| Holdings | `account.py:47`, `:49` | [A] |
| Funds / margins | `account.py:48` `get_funds`, `:76` | [A] |
| Order list / detail | `account.py:53` | [V] the order-notification socket is reduced to id/remark/status (`brokers/stream_worker.py:256-274`, `:416-420`), so quantities and averages still need REST |
| Trade list / detail | `account.py:77`, `:97` | [A] |
| Candles / intraday | `services/market_data/chart_history.py:85`, `:113`, `:162` `get_historical_data_v2` | [A] request/response by design |
| Option master | `brokers/icici/market_data.py:129-150` — HTTP zip | [A] a file download, not a feed |
| Whole-expiry chain ladder | `services/option_chain_service.py:1098-1100` `chain_quotes`; `:1235-1244` bhavcopy closes | [V] the stream carries subscribed strikes, not a range it was never asked for |
| GTT | `execution/gtt_orders.py:111`, `:128`, projector `:162` | [V] our own Postgres rows; [A] no Breeze GTT feed found |

Correct replacement pattern for all of them: **push-to-invalidate**, then exactly one REST read. The worker already
does this (`execution/repository.py:1045-1068`, which only sets `next_attempt_at` and issues `pg_notify`, and
`brokers/streams.py:559-598`). **[V]**

## Already correct — do not touch

| What | Evidence |
|---|---|
| Chain leg marks need **no REST read** when the stream covers every wanted leg plus the spot | `services/option_chain_service.py:946-954` returns early on `streamed["complete"]`; completeness defined at `:1010` **[V]** |
| Index strip REST reads are already rate-limited | `:702` docstring, `STRIP_REST_SECONDS = 30` (`:77`), `STRIP_REFILL_AGE = 40` (`:78`) **[V]** |
| Duplicate-name subscriptions are already prevented | `brokers/streams.py:331-332`, `:336-338` explain that a duplicate moves the fingerprint and replaces a working stream; fingerprint over `[session, desired]` at `:351` **[V]** |
| Tick payload is already sanitised | `brokers/stream_worker.py:165-181` rejects non-finite prices and malformed times **[V]** |
| Broker refusal text is already redacted | `brokers/shared/external_execution.py:47-48` strips non-word characters and token-shaped strings before storing **[V]** |
| ICICI sessions and masters warm up on their own timers | `execution/worker.py` `prewarm()` and the master-warm gate **[V]** — open question is coverage, which is B6, not a code defect |

## Order of work

1. **B2** first — smallest change, worst failure mode removed, and it is provable offline.
2. **B1** — biggest visible effect on the trader's screen, 19 h/day, no execution risk.
3. **B6** — costs one log line and unblocks B3's [D], B5's [A] and the entire client §8 argument.
4. **B3**, **B11**, **B12** — small, self-contained correctness/observability fixes.
5. **B7-B10** — decide the push topology as one design, then land it with `MOBILE_CODE_FIXES.md` M6-M9 in the same
   release, since neither half is useful alone.
6. **B4**, **B5** — last, and only after B6's numbers exist.

## Status

Proposed changes only. No file in `backend\python\nraialgo` was modified by this document's author, no test was run
against it, no Breeze endpoint was called, no websocket or SSE connection opened, and **no order was placed,
cancelled, amended, previewed or dry-run**. The three commands used were `git rev-parse`, `grep`/`find` and `sed`
on source. No secret, token, API key, TOTP or session value appears anywhere in this document or was printed while
writing it.
