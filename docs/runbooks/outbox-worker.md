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
- Keep `ML_V2_RECOMMENDATIONS=false` until the ingestion canary returns a
  non-empty set of canonical backend `repo_id` UUIDs.
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
match. Each run claims at most five rows, one immediately before each delivery,
so the 60-second database lease never expires behind an older queued request.
`SIGTERM` completes the active run and closes Redis/PostgreSQL connections.
Avoid `SIGKILL`, which can leave the current row claimed until reconciliation
releases its lease.

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
