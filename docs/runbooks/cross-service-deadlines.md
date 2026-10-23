# Cross-service operation deadlines

Issue [#132](https://github.com/ACM-VIT/Weave/issues/132) is **human-required**.
The code and offline tests prepare a compatible contract; no deployed inventory,
approved UX/service budget, or before/after production measurement is claimed.
Do not close the issue until the environment evidence below is reviewed.

## Source inventory and proposed budgets

Source review: Weave `dev` at `25a4452`; Weave-ml `main` at
`7a7091cc45fda7884cfd21e582c1e7bd9f69d509` (23 October 2026).
These are checked-in values, **not effective deployed values**.

| Operation | Backend proposal | ML checked-in bound | Included work and margin |
| --- | --- | --- | --- |
| Feed foreground generation observer | `FEED_FOREGROUND_WAIT_MS=5000` | Independent of job lifetime | Only waiting for generation; persistence/serve completion has its own lifetime |
| Recommendation transport | `ML_GENERATION_TIMEOUT_MS=15000` | `V2_RECOMMENDATION_TIMEOUT_SECONDS=12` | ML queue + dependencies + model share 12 seconds; 3 seconds for network, response and validation |
| Generation operation | `FEED_GENERATION_TIMEOUT_MS=60000` | Each ML call retains its local cap | Backend preflight/lock/history + recommendation + at most one persona repair + at most one recommendation retry; retry gets only the remaining duration |
| Durable onboarding transport | `ML_ONBOARDING_TIMEOUT_MS=35000` | `EMBEDDING_TIMEOUT_SECONDS=30` | Queue + shared model admission + embedding + writes within ML response bound, 5 seconds transport/acknowledgement margin |
| Durable refresh transport | `ML_REPOSITORY_REFRESH_TIMEOUT_MS=50000` | `V2_REFRESH_TIMEOUT_SECONDS=45` | Queue + dependencies + versioned writes within ML response bound, 5 seconds transport/response margin |
| Durable feedback transport | `ML_DELIVERY_TIMEOUT_MS=30000` (retained) | `V2_FEEDBACK_TIMEOUT_SECONDS=8` | Existing acceptance/transport budget retained pending measurement |
| Durable repository index transport | `ML_REPOSITORY_INDEX_TIMEOUT_MS=240000` (retained) | `EMBEDDING_TIMEOUT_SECONDS=30` default | Existing provider/embedding budget retained; environment-specific summary/provider overrides need explicit inventory before reduction |
| Health transport | `ML_TIMEOUT_MS=5000` (retained) | Tier-specific health settings | Independent diagnostic transport; does not inherit generation lifetime |

Existing explicit `ML_TIMEOUT_MS` still supplies the generation timeout when
`ML_GENERATION_TIMEOUT_MS` is absent. Existing explicit `ML_DELIVERY_TIMEOUT_MS`
still supplies onboarding/refresh when their operation knobs are absent. New
knobs take precedence. This preserves deployed configuration until an operator
approves migration. Templates contain the proposed new settings explicitly.
Invalid/overflowing durations fail closed instead of silently becoming 1ms Node
timers. No automatic discovery of live proxy or ML configuration occurs.

Startup also rejects a generation budget that cannot fit the resolved onboarding
timeout plus its 1000ms acknowledgement margin. For example, legacy
`ML_DELIVERY_TIMEOUT_MS=60000` with the default 60000ms generation budget requires
an explicit, approved `FEED_GENERATION_TIMEOUT_MS` increase or a shorter
`ML_ONBOARDING_TIMEOUT_MS`. This validation catches an impossible repair before
serving traffic; actual repair admission still checks the remaining job budget
after preflight and any first recommendation attempt.

## Ownership, deadlines and backward compatibility

A feed miss starts/coalesces one real generation per user/feed version locally.
Up to 128 such foreground-origin generations may exist per API process, with no
pending generation queue. Redis locks still coordinate other processes, prewarm
and refill work. Each observer waits at most its foreground generation budget;
expiry releases its reservation and uses the existing durable personalized
recovery, optional fallback, or personalized-unavailable response. Production
still has trending fallback disabled. Continuation pages retain their retryable
in-progress/error behavior; a coalesced remote lock-owner wait returns in-progress
when its shared foreground deadline expires. Neither path grants another full
wait window after coalescing.

Queued and recovered candidates are checked against durable deliveries in the
same viewer/session, independently of the 500-item generation history window.
Proven duplicates are discarded through the existing reservation owner with an
atomic refill, bounded to four batches per request. An exhausted duplicate scan
stays retryable instead of persisting an empty terminal page. Personalized serve
writes also serialize the final overlap check for the canonical session UUID, so
concurrent recovery and queue consumption cannot both commit the same repository;
same-request replay still returns its existing durable serve.

Expired observers are removed from a bounded observer set; they attach no
permanent promise callbacks. Real generation slots/keys and Redis ownership
survive observer expiry until the actual generation settles. Shutdown drains
actual work, including lock release and publication acknowledgement. An HTTP
disconnect does not cancel an already owned serve writer or generation.

Each generation starts a monotonic operation deadline before backend preflight.
Every recommendation attempt receives the **same** local deadline; transport is
clipped to its remaining duration. The authenticated recommendation request sends
relative `X-Request-Timeout-Ms`, reserving up to 1 second (10% for short budgets)
inside the transport for return-path overhead. The current ML contract caps this
to its local bound, includes executor queue time, checks cooperative stages and
clips dependency timeouts. Older ML releases may ignore the optional header;
backend transport and circuit behavior remain bounded. No DTO shape changes.

A durable persona repair is admitted only when its full configured onboarding
transport plus 1 second of acknowledgement margin fits the remaining job budget.
There is at most one repair retry. New work/publication cannot start after job
expiry. Once publication starts, its durable acknowledgement finishes even if
the deadline expires. Generation locks retain their heartbeat until real work
exits. Prewarm's claim lease covers the operation budget plus 60 seconds.

Durable feedback, onboarding, refresh and index requests deliberately carry **no**
read-only deadline header. Preserve stable payload/job IDs on outbox retry; do not
abort partially completed writes on a foreground disconnect. Outbox claims must
exceed the longest configured durable transport by at least 60 seconds, and
supervisor stop grace must cover that same bound. Expiry of an ML response await
cannot interrupt a native model call or completed/ongoing durable write. Existing
ML bounded executors retain real occupancy. Existing backend persistence/Redis
client/server limits are unchanged: a connected dependency stall may outlast the
cooperative budget while actual admission/ownership stays retained. The live
inventory must establish command/query limits. This is cooperative admission, not a
promise of hard wall-clock interruption or guaranteed completion after process
termination. ML redirects are refused so retries cannot redirect credentials or
work to an unintended endpoint.

## Authorized environment inventory (pending)

Record values from the running process/supervisor and effective proxy settings,
not the example files. Redact secrets. Attach release IDs, environment, time,
reviewer/approver, measurement method and approval decision.

| Boundary | Effective value / evidence | Owner approval |
| --- | --- | --- |
| Client/feed UX wait and retry policy | Pending | Pending |
| Edge/load balancer idle/request limits and retry policy | Pending | Pending |
| Backend generation, foreground, health and every durable transport setting | Pending | Pending |
| Backend generation/prewarm/outbox leases and shutdown grace | Pending | Pending |
| ML reverse proxy and ASGI/disconnect behavior | Pending | Pending |
| ML recommendation/service/embedding response budgets and executor workers/capacity | Pending | Pending |
| Shared model admission, Qdrant/Redis/HTTP/provider connection/read/retry limits | Pending | Pending |
| Database statement/lock limits and acknowledgement margin | Pending | Pending |

Approve each operation only after queue, model, dependency and transport tails
fit its budget under representative concurrency, including cold models and
capacity rejection. Do not raise all knobs together to hide saturation. Verify
mixed backend/ML releases and proxy header forwarding before enabling shorter
read-only remaining deadlines.

## Measurement and rollback gate (pending live validation)

Capture equal before/after windows at the same release/corpus/load, warm/cold
state and sampling settings. Record count, p50/p95/p99 and errors separately;
record a concrete threshold and decision owner before rollout.

- Feed generation wait expiry: `feed_v2_generation_wait_expired_total` counts
  observers. `feed_v2_generation_after_wait_total{outcome}` and the corresponding
  `feed_v2_generation_after_wait_ms` observation count actual generations that
  settle after their first observer expired, once per generation. Outcomes retain
  `generated`, `stale`, `coalesced`, `capacity`, `satisfied`, or `failed`.
- Feed-ready delay: measure from durable scheduling/profile acceptance to
  successful canonical publication, including retry/queue delay. Join scoped
  prewarm scheduling and generation-attempt evidence, or trace a representative
  test cohort externally; generation transport duration alone is insufficient.
- Backend-aborted/ML-completed: correlate sampled trace/request IDs from backend
  transport timeout spans with ML actual-work completion and executor
  timeout/cancelled-worker-exit metrics. The reviewed ML release exposes
  `stage=late_work` histograms in its authenticated deep diagnostic snapshot;
  these do not alone prove which backend caller timed out. Preserve this
  distinction and verify the deployed release's instrumentation.
- Duplicate delivery: compare stable durable job/event IDs, ML duplicate
  acknowledgements and actual versioned side effects across timeout/retry cases;
  a retried transport count alone is not duplicate applied work.
- Monitor outstanding generations, dependency/executor occupancy, capacity
  rejections, prewarm retry delay and outbox attempt/age/claim recovery. Verify
  no unbounded work or observer retention during slow/dead dependencies.

Rollback if approved feed latency/error, delayed-ready, duplicate-side-effect or
capacity/occupancy thresholds regress, or if deadline propagation breaks mixed
versions. Restore the previously inventoried explicit legacy/operation settings,
keep stable durable IDs and claim recovery, and drain in-flight work before
reducing leases/shutdown grace. Do not disable durable acknowledgements to make
a timeout chart look better. Final approved thresholds/results remain pending.

## Offline verification

Node 22 tests exercise slow recommendation transports, relative remaining budget
propagation, exhausted job admission, one repair retry, no late publication,
short foreground fallback while work continues, repeated observer cleanup,
128-generation admission and shutdown draining. Outbox tests require leases to
cover every configured durable operation. These fixtures establish behavior;
they do not substitute for deployed executor/latency/duplicate measurements.
