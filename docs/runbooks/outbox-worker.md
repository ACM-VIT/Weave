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
  shorter `ML_TIMEOUT_MS=5000` bound. Repository summary generation and
  embedding use `ML_REPOSITORY_INDEX_TIMEOUT_MS=240000`.
- Set `OUTBOX_LEASE_MS=300000`. Startup/claiming fails closed if the lease is
  less than 60 seconds longer than the repository-index timeout. Abandoned-claim
  reconciliation reads the same value, so any override remains consistent.
- Keep `ML_V2_RECOMMENDATIONS=true`; production readiness must remain red until
  the ingestion canary returns a non-empty set of canonical backend `repo_id`
  UUIDs.
- Leave `WORKER_ROLE` blank in the shared environment file. The worker unit
  passes `--role=outbox`, while the API process remains role `api`.
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
match. Each run claims one row immediately before delivery, so the configured
database lease never expires behind an older queued request. The systemd unit
gives the container 300 seconds after `SIGTERM` (plus 30 seconds of supervisor
margin), which exceeds the 240-second repository-index request bound and lets
the single active row finish before shutdown.
`SIGTERM` completes the active run and closes Redis/PostgreSQL connections.
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
