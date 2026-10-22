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

Public/outbox roots sample 1/16 traces (first random trace byte <16). Metrics cover
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
- `outbox_delivery`: one transport attempt, excluding subsequent durable DB commit
  and post-delivery hook. Each retry starts a new root with an ML child.
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

The focused existing ML-client fixture source covers distinct attempt identity,
shared parent trace, stable idempotency and histogram overflow/outcome separation.
It is not executed in this change. Deferred checks: execute backend focused and
full suites; paired ML auth/context propagation and concurrency fixtures; two
instance aggregation; synthetic load comparing tracing enabled/disabled CPU,
RSS and p50/p95/p99 scrape/request latency; unexplained total-minus-stage time.
No overhead, fleet percentile accuracy or runtime correctness is yet measured.

Durable enqueue-to-delivery linkage is NOT implemented: outbox rows do not store
trace metadata, and no schema or producer semantics change here. Delivery-attempt
roots cannot reconstruct the originating HTTP span after restart. Client first
render/feed-ready instrumentation is also absent. Remote worker queue/model lock,
encoding/Qdrant/ranking/serialization and late work must come from the paired ML
change, not be inferred from transport latency. These gaps keep issue #134 open.


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
not HTTP success. Focused regression fixture source is supplied without execution.
