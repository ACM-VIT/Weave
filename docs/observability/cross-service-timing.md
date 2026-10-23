# Bounded cross-service timing (Weave #134)

This is instrumentation, not a measured speedup. No new collector, credentials,
configuration, or public endpoint is introduced. Deployment and load collection
remain separate work. The paired ML implementation must validate the contract
below; sending headers to an older ML version remains backward compatible.

## Identity and trust

Public HTTP requests start fresh random trace roots, ignoring inbound traceparent,
tracestate and baggage. Legacy nonempty request IDs up to 128 characters remain
response-only correlation IDs; missing or longer values are replaced. Incoming request headers themselves are not modified,
so feed idempotency behavior remains unchanged. Request IDs never enter span
storage or metric labels. Job, generation and idempotency IDs are unchanged.

Every ML HTTP attempt receives a fresh UUID x-request-id and fresh child span ID.
The traceparent header is exactly `00-<32 lowercase hex>-<16 lowercase hex>-00|01`.
Neither hex identifier may be all zero. ML must accept this identity only after
internal-secret authentication and exact syntax validation, otherwise create a
new root. Its server span gets a fresh span ID and the supplied client span as
parent. Children inherit sampling. No baggage or arbitrary attributes propagate.

Public roots and legacy outbox roots sample 1/16 traces (first random trace byte <16). Metrics cover
all instrumented operations, independent of sampling. Each process keeps only
its latest 256 sampled completed spans, each <=512 UTF-8 JSON bytes, at most
128 KiB serialized record payload plus bounded container/object overhead.
The authenticated operations status endpoint returns `trace_spans`. Fields are
only opaque trace/span IDs, allowlisted operation/stage/outcome, duration and end
time. No URLs, request bodies, query strings, user/repository IDs or secrets enter
this store. The ring is diagnostic and lossy, not a durable tracing backend.

## Metrics and semantics

Existing counters/distributions remain. HTTP route labels now use registered
Express templates and known literal mounts; unmatched routes become `other`.
Methods are bounded. Existing sliding p50/p95/p99 are process-local diagnostics,
not fleet percentiles. Completed-response legacy HTTP metrics exclude disconnects. Middleware coverage
starts after existing CORS/body parsing, so earlier rejects are not counted.

`metrics.stage_duration_ms` adds cumulative millisecond histograms keyed by JSON
`{operation, stage, outcome}` with count, sum and cumulative upper-bound buckets.
The last `+Inf` bucket equals count. Finite bounds: 5,10,25,50,100,250,500,1000,
1800,2500,4000,5000,10000,30000,60000,120000,240000 ms.

- Operations: http, recommendations, search, feedback, onboard, repo_index,
  repo_refresh, health, other (9 maximum).
- Stages: http_completion, ml_transport, outbox_delivery, outbox_age, other.
- Outcomes: success, rejected, failure, timeout, cancelled.
- Hard maximum: 225 histogram families (9*5*5), each 17 finite
  buckets plus +Inf/count/sum. No identity-valued labels. Invalid durations drop.
- `http_completion`: response finish or connection close, not client render or
  feed-ready. Status 408/504 is timeout; other 4xx rejected; 2xx/3xx success.
- Paired ML HTTP middleware timing ends when its response object is returned,
  not when all bytes are sent or the client receives/renders them. It must not
  be compared as equivalent to backend response-finish timing.
- `ml_transport`: serialization, HTTP wait/body read and transport envelope parse;
  not isolated remote model service time. Abort deadline is timeout. Semantic
  search distinguishes caller cancellation from its attempt deadline.
- `outbox_delivery`: one outbox member attempt, excluding subsequent durable DB
  commit and post-delivery hook. Feedback batches count each member, while only
  the first member parents the shared ML RPC. Each retry has a fresh attempt span
  under its stored enqueue parent, with a fresh ML child and request ID.
- `outbox_age`: created_at to attempt start, includes retries/backoff and clock
  skew; not executor queue wait. Negative/nonfinite samples drop. Outcome success
  means age observation, not successful delivery.

## Collection and deferred verification

Using the existing internal-authenticated operations status route, collect each
instance's stage_duration_ms twice with a fixed interval and record process
identity/restarts outside metric labels. Subtract earlier buckets/count/sum from
later values per family, discarding reset intervals; sum corresponding deltas
across instances. Estimate percentiles from summed buckets, never average local
percentiles. Compare success against rejection/failure/timeout families separately.
Scrape interval must not be presented as span retention guarantee: the ring can
wrap between scrapes. Do not record response bodies from product/ML calls.

Durable outbox payloads now carry reserved internal `_traceparent` metadata,
captured from server-owned async context at enqueue. It never changes job IDs or
idempotency keys; duplicate inserts preserve the original payload/context. Workers
validate the exact v00 context before adoption and remove metadata before strict ML
DTO transport. Legacy/malformed rows start fresh roots. A batched feedback RPC has
one parent (its first member); separate member-attempt spans preserve the other
enqueue lineages, but no multi-parent RPC span links are represented.

The response `traceparent` header exposes the server-issued HTTP context to the
app, including through CORS. It does not authorize adoption of inbound public
headers. Existing clients and ML versions may ignore additive headers; old outbox
workers do not strip the new reserved payload field, so deploy compatible workers
before enabling new enqueue producers. Drain traced pending rows before reverting
to an old worker. No schema migration or feature-flag activation is required.


## Separate worker processes

The protected operations status response also exposes `worker_telemetry`. Each
worker publishes only stage histograms and the bounded span ring into the existing
private Redis, once every 15 seconds. There are 16 fixed slots across worker roles,
with 60-second expiry, a maximum 256 KiB JSON snapshot per slot, and atomic
process-token claim/refresh/release. The opaque per-start process UUID is snapshot
metadata, never a metric label. No new listener, credential, setting, or service
is introduced. A stopped/restarted process must not be treated as the same series.

Redis calls have a one-second caller deadline. A timed-out publish/read retains
its overlap guard until the underlying command actually settles, preventing an
unbounded backlog. Telemetry failure cannot reject an outbox job. Fixed warning
codes report unavailable Redis, slot exhaustion or an oversized snapshot; the
protected response reports empty/unavailable/partial collection, occupied slots,
capacity exhaustion and invalid-or-stale snapshot count. Expired slots disappear;
empty collection is not proof that workers are healthy or idle. Snapshots older
than 60 seconds or over five seconds in the future are rejected, so clock skew
also produces explicit partial collection rather than trusted timestamps.

Scrapes are snapshots, not additive events: repeated API polls may read the same
worker snapshot. Deduplicate by process_id and captured_at_ms; calculate bucket,
count and sum deltas only between distinct snapshots for the same process, then
aggregate deltas across processes. Never add repeated snapshots or assume Redis
contains durable fleet counters. Missing intervals, eviction/restart, capacity
exhaustion and stale data mean incomplete collection and must be disclosed.

Outbox delivery carries an optional timeout failure kind from an aborted ML
transport, preserving its timeout histogram instead of collapsing status zero
into generic failure. This metadata does not change acceptance/retry behavior.
Rejected Axios redirects (redirect following remains disabled) record failure,
not HTTP success. The local backend regression suite exercises these cases.


## Home readiness and first visibility

`src/services/feedTiming.ts` exposes `snapshotFeedTiming()` for local debug
collection, with cumulative millisecond histograms (including +Inf/count/sum) and
at most 128 sampled diagnostic records. It performs no network export and includes
no user, repository, session or request IDs. Families are bounded by three stages,
three modes and five outcomes (45 maximum); trace IDs are record fields only.

- `feed_ready`: Home fetch start through response-body decode, including retries
  and catalogue fallback; success and empty responses are separate. Cancelled,
  rejected and failed loads use unknown mode. This is not query commit time.
- `first_visible`: initial-page fetch start to the first card reported at least
  50% viewable by FlatList. Counted once per timing object; later pages, empty
  pages and remounting an already observed cached page do not add samples.
- `ready_to_visible`: the corresponding local post-decode interval. This is
  unattributed app scheduling/visibility time, not isolated React render cost.

These are visibility proxies, not GPU paint, image completion or an app startup
SLO. Failed/cancelled loads never count as successful first visibility. Sampled
records link to the final successful personalized or catalogue HTTP response;
earlier retries/fallback attempts are not represented by that one header. Client
histograms are device-local diagnostics, not automatically collected fleet metrics.

## ML stage export and attribution

The paired ML change adds `ml_stage_duration_seconds` to the existing `/metrics`.
Its fixed ten operation, ten stage and five outcome domains cap stage families at
500 (7,500 bucket/count/sum series). Bounds in seconds are
.005,.025,.1,.5,1,4,5,8,12,30,45,120 and +Inf. The added 4/5/8/12/45-second
boundaries resolve the default search/health/feedback/recommendation/refresh
budgets. Existing metrics remain. ML outcome `ok` corresponds to backend success;
`error` corresponds to failure. Keep rejected/timeout/cancelled separate.

Existing executor `queue`, `service` and `late_work` measurements retain real worker
exit accounting after caller abandonment. New `model_lock` measures encoder lock
acquisition; `encoding` covers the model call while held; `qdrant` wraps actual
repository retrieval/search calls; `ranking` covers recommendation ranking;
`response_build` measures recommendation dictionary/dataclass construction. The
last stage excludes framework validation, JSON encoding and network flush. These
nested stages overlap executor service time; never sum them as independent costs.
Admission rejections have a separate `queue/rejected` series and never claim a
service-time sample. Sampled stages record the remaining local deadline at entry
without cancelling expired work, plus their wall-clock end time and monotonic
duration. Never compare a process's absolute monotonic deadline with another clock.

## Reproduction and local evidence

Run from the corresponding worktree with its locked dependencies:

```sh
# Weave: no services needed for the synthetic overhead measurement.
node_modules/.bin/tsx scripts/measure-tracing.mts 20000
node_modules/.bin/tsx --test tests/feed-timing.test.ts tests/feed-pagination.test.ts tests/home-feed.test.ts
# Weave-ml: prepare dependencies with uv sync --locked --group dev first.
# The tracing microbenchmark requires no model download or external service.
.venv/bin/python -m scripts.benchmark_tracing --iterations 20000 --scrapes 100
.venv/bin/python -m pytest tests/ -m 'not integration and not benchmark' -q
```

The live loopback tracing contract has its own checkout selector because this
instrumentation is additive to the pinned ML DTO release. It checks identical
OpenAPI artifacts, then runs the actual Node HTTP client against FastAPI auth,
feedback contracts, executor admission and copied worker context. Storage is a
test double. It tests distinct attempt/request IDs and JSON-serialized outbox
lineage; database durability is covered by the separate database fixtures.

```sh
# From Weave/backend; use the matching ML checkout and its Python environment.
DATABASE_URL=postgresql://test:test@127.0.0.1:9/test \
WEAVE_ML_TRACING_ROOT=/absolute/path/to/Weave-ml \
WEAVE_ML_PYTHON=/absolute/path/to/Weave-ml/.venv/bin/python \
node_modules/.bin/tsx --test tests/contracts/tracingCrossRepo.integration.test.ts
```

Local Node 26.11.1 sample on October 23: 20,000 sequential root+child pairs took
403 ms wall (20.2 us/pair), versus 1.55 ms for bare callbacks. Serializing 1,000
snapshots took 428 ms with two populated families and 10,329 ms with all 225
families populated.
Raw CPU and RSS deltas are emitted by the script; RSS deltas include GC/allocator
noise and are not peak memory. The complete sampled synthetic root-minus-child
residual was p50 .0112 ms, p95 .0241 ms across 128 traces. This is a local overhead
fixture, not unexplained production latency or an HTTP endpoint scrape benchmark.

Local Python 3.12.14 sample with native thread limit one: 20,000 scopes took
13.7 ms baseline, 273 ms unsampled and 537 ms sampled. One hundred full-domain
metrics renders took 550–553 ms and emitted 743,430 bytes/render, versus 14.1 ms
for 100 empty renders. Peak Linux RSS was about 64–67 MiB. Sampling still records
every histogram sample. Host load, CPU policy and allocator state affect results.
These sequential microbenchmarks are not a production load or throughput claim.

Local verification: frontend 313 passed/5 skipped; backend 380 passed/110 skipped
with the tracing loopback fixture enabled; ML 1,745 passed/1 skipped/50 deselected
(`not integration and not benchmark`). After moving service rejection accounting
into native submit to also cover health coordinator calls, its runtime, API and
metrics regressions passed again (53 tests). Backend build and both frontend and
backend TypeScript checks passed. The earlier disposable-PostgreSQL tracing flow
fixture passed two tests; the resumed run did not rerun database integrations.

For real collection, join sampled parent/child span IDs and report missing spans;
use local elapsed clocks only. To estimate unexplained backend time, subtract the
**union** of direct child intervals from each complete parent interval, never the
sum of overlapping nested stages. The lossy ring stores end time and duration,
so interval reconstruction is approximate and subject to wall-clock skew. Do not
subtract remote process durations from client clocks or equate HTTP completion
with app visibility. Use `ready_to_visible` directly for the local app gap. Fleet
histograms require per-process reset-aware deltas as described above. Live load,
network scrape cost and rollout verification remain #135 work.
