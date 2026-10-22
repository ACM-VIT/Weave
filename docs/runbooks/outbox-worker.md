# Outbox worker deployment

The outbox worker is a separate long-running backend process. It claims durable
PostgreSQL rows and delivers onboarding, feedback, repository indexing, and
repository refresh jobs to the authenticated ML v2 endpoints.

## Required invariants

- Keep `ML_SERVICE_URL=https://weaveml.krishang.dev` with no trailing API path.
- Reuse the API process's existing `INTERNAL_API_SECRET`; do not rotate it just
  to add a worker process.
- Keep `ML_FEEDBACK_OUTBOX=true` and `DB_SCHEMA_V2_WRITES=true`.
- Set `ML_DELIVERY_TIMEOUT_MS=30000`; health/recommendation reads retain the
  shorter `ML_TIMEOUT_MS=5000` bound.
- Repository indexing uses `ML_REPOSITORY_INDEX_TIMEOUT_MS=240000` by default.
  Keep `OUTBOX_LEASE_MS` at least 60000 ms above that timeout (default 300000 ms).
- Keep `ML_V2_RECOMMENDATIONS=true`; production readiness must remain red until
  the ingestion canary returns a non-empty set of canonical backend `repo_id`
  UUIDs.
- Leave `WORKER_ROLE` blank in the shared environment file. The worker unit
  passes `--role=outbox`, while the API process remains role `api`.
- Apply `0029_onboarding_prewarm_ready_index` and pass the schema audit before
  enabling the onboarding-prewarm lane. Migration execution requires separate
  environment authorization; this runbook is not permission to run it.
- Reconcile the complete migration lineage first: PR #162 owns
  `0028_counter_reconciliation_progress`, which must precede this index's 0029
  journal timestamp. Preserve the agreed canonical 0025 / README 0026 /
  revision 0027 history when composing PR #143. Do not apply this review
  branch's 0029 before that combined lineage has been reviewed.
- Deploy only an image that passed `npm run build` and `npm test`. The worker
  intentionally fails startup if its owning feature is disabled or its role conflicts.

The checked-in production example is `backend/.env.production.example`. Store
the real environment outside the checkout, owned by root and readable only by
the service group. The systemd template expects `/etc/gh-social/backend.env` and
does not contain secrets.

## Systemd installation

The template assumes Docker is installed at `/usr/bin/docker`, the immutable
image is tagged `gh-social-backend:current`, and the root-owned environment file
is `/etc/gh-social/backend.env`.

1. Build and test `backend/Dockerfile` in CI.
2. Copy `backend/deploy/systemd/gh-social-outbox.service` to
   `/etc/systemd/system/gh-social-outbox.service`.
3. Validate the unit with `systemd-analyze verify`.
4. Reload systemd, then enable and start `gh-social-outbox.service`.
5. Inspect `systemctl status gh-social-outbox` and its journal before ingestion.

For another container supervisor, the process command is:

```text
node dist/worker.js --role=outbox
```

The script passes `--role=outbox`; an explicitly supplied `WORKER_ROLE` must
match. Each run defaults to one delivery, claimed immediately before its HTTP
request. The default database lease is 300 seconds; repository indexing has a
240-second request bound, leaving at least 60 seconds for persistence/recovery.
Jobs do not wait in a claimed batch behind an earlier request. After a crash,
reconciliation can reclaim a job once its configured lease expires.
Source transactions request a payload-free PostgreSQL notification; PostgreSQL
publishes it only on commit. Outbox workers wake on that hint without overlapping
an active run, and immediately catch up when postgres-js establishes or restores
its LISTEN subscription. `OUTBOX_ACTIVE_INTERVAL_MS` and
`OUTBOX_IDLE_INTERVAL_MS` still bound fallback polling when notifications are
lost or unavailable. LISTEN requires a session-compatible database connection;
transaction-pooling deployments continue to deliver through polling if LISTEN
is unsupported. Neither the configured interval nor this change is a measured
commit-to-claim latency improvement.

Onboarding prewarm runs in its own single-capacity supervised lane, not in the
delivery hook. After ML accepts onboarding, its fenced acknowledgement also
stores backend-owned `backend_onboarding_prewarm` metadata in that row's
`response_payload`. The delivered status, original payload, and any other
response fields are preserved. This metadata is never populated from provider
response fields. A separate claim token and a five-minute lease recover work
after a crash; retries use capped jitter and stop after ten attempts or seven
days. Restarting the worker reconstructs pending work directly from PostgreSQL,
with no unbounded process-local queue. While prewarm is unfinished, the delivered
row's native `available_at` holds its next ready time or claim-expiry deadline;
the original delivery value is preserved as backend `delivery_available_at`
metadata. The partial `ml_outbox_onboarding_prewarm_ready_idx` matches the
unfinished-status predicate and `(available_at,outbox_id)` claim order, rather
than scanning/sorting retained delivered JSON history. Stop any older prewarm
worker before applying the transition; migration 0029 reconstructs native ready
times from existing backend metadata if present. Duplicate wakeups do not
duplicate work;
the onboarding idempotency key and the existing user/feed-version generation
lock coalesce it. Coalesced generation is retried, not acknowledged as completed.
Deleted/inactive users and superseded profile/feed versions are discarded.
Generation rechecks the profile, feed version, and prewarm claim before it
publishes. Changed bio/onboarding context and material GitHub persona updates
also advance the feed version in their source transaction, isolating a racing
old prewarm under an obsolete Redis key. Duplicate context submissions and
unchanged persona repair do not advance the feed version (existing profile
version/response behavior is unchanged). Retention excludes only unfinished
prewarm within those bounded retry limits; terminal or expired work remains
eligible for normal retention.
Only an additive scheduling index is required; no external service or new
credentials are needed. Activity takes its user `KEY SHARE` before locking feed
state; profile/onboarding/persona take user `FOR UPDATE` before key changes and
feed invalidation. This avoids a user-lock upgrade after a competing activity
already holds feed state. Existing social-profile reconciliation order remains
unchanged.

`SIGTERM` completes the active run and closes Redis/PostgreSQL connections.
Both delivery and prewarm stop accepting wakeups before their active runs drain.
The outbox unit gives Docker 300 seconds to stop and systemd 330 seconds,
covering the default 240-second index request and cleanup. When increasing
`ML_REPOSITORY_INDEX_TIMEOUT_MS`, increase Docker's `ExecStop --time` to at least
the request timeout in seconds plus 60, and `TimeoutStopSec` to at least another
30 seconds beyond that. For a 600000 ms index timeout, use 660 and 690 seconds.
Avoid `SIGKILL`, which can leave the current row claimed until reconciliation
releases its lease.

The backend test command runs files serially because database integration files
share destructive fixtures. Use `RUN_DATABASE_INTEGRATION=1 npm test` only with
an isolated disposable PostgreSQL database and isolated Redis test database;
direct test invocations must also set `--test-concurrency=1` across those files.

## Acceptance before ingestion

Check the authenticated operations endpoint at
`GET /api/internal/v2/operations/status`. Require all of the following:

- process logs show `Backend worker running with role=outbox` and no repeating
  delivery errors;
- `pending=0`, `claimed=0`, and `dead=0` after the existing queue drains;
- backend `/readyz` reports PostgreSQL, Redis, and ML healthy;
- the ML health URL and all current `/api/v2/...` paths remain unchanged.

Before release, verify rollback produces no notification-backed work, lost
signals and LISTEN reconnects recover through a catch-up poll, and delayed or
failed prewarm does not block unrelated delivery. Exercise repeated wakeups,
profile/feed invalidation, prewarm lease/token recovery, bounded retries and
retention of unfinished work on disposable fixtures. Measure commit-to-claim
delay and delivery-lane occupancy separately from configured poll intervals.

If pending age grows while ML is healthy, stop ingestion and inspect the worker
journal. Stopping the worker is recoverable: jobs remain in PostgreSQL. Do not
delete or reset outbox rows to recover delivery; use the authenticated replay
endpoint for terminal rows after correcting the underlying fault.

## Obsolete identity-only onboarding jobs

Older API builds could enqueue profile-version-1 onboarding jobs before a user
provided a bio, interests, skills, or technology stack. Those jobs cannot create
a useful recommendation embedding and must not be replayed. After migration
`0014_outbox_superseded.sql` and the matching API build are deployed, classify
each verified row through the authenticated endpoint:

```text
POST /api/internal/v2/operations/outbox/:outboxId/supersede
```

The endpoint returns `202` only for a dead `onboard` job with
`profile_version=1` and no semantic profile context. It returns `409` for every
other row. It never accepts pending, claimed, delivered, contextual, or newer
profile jobs. The operation-status response reports these rows separately as
`superseded`; they no longer count as dead and cannot be replayed.

Use a read-only database query to obtain candidates, call the endpoint once per
candidate, and then require `pending=0`, `claimed=0`, and `dead=0`. A user who
has not completed onboarding will receive a new versioned onboarding job when
they submit a bio or categorized onboarding selections. Do not edit payloads or
bulk-update outbox status directly in SQL.

## Strict repository reindex campaign

Historical delivered `repo_index` payloads predate the strict ML v2 source
allowlist and must not be replayed into a new collection. The backend provides a
campaign-scoped enqueue command that reads active canonical repositories,
content, topics, and latest observed counts from PostgreSQL and rebuilds each
payload through the same strict projection used by live ingestion.

Run the report-only pass first:

```text
npm run reindex:ml -- --campaign=v2-strict-YYYYMMDD
```

Require `invalid=0`, `missing_content=0`, and `active=eligible`; inspect
`would_queue` and `skipped`,
and confirm the ML owner has selected the intended versioned target collection.
Then enqueue in bounded transactions:

```text
npm run reindex:ml -- --campaign=v2-strict-YYYYMMDD --batch-size=100 --execute
```

Execution only inserts new durable outbox rows. It never deletes, resets, or
rewrites historical rows and preserves each repository's current
`content_version`. The idempotency key includes the campaign ID, so rerunning
the same command is safe: completed batches report as `already_queued`. Use a
new campaign ID only for an intentional new complete reindex.
