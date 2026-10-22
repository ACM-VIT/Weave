# GH Social Backend v2

This service is the system of record for users, repositories, social state, feed serves, and interaction history. Product and ML integrations use the V2 APIs documented here. The former `/api/users`, `/api/repos`, `/api/activity`, `/api/comment`, `/api/boards`, `/api/containers`, `/api/onboarding`, and `/api/feed` routes are not registered.

## Authority boundaries

| Component | May read/write | Must not do |
|---|---|---|
| Frontend | Public backend HTTP API | Query Supabase tables, Redis, ML, or Qdrant directly |
| Backend | PostgreSQL `app` and `telemetry`; Redis feed queues; authenticated ML HTTP API | Store product state only in Redis or accept client-supplied user ownership |
| ML | Backend-delivered jobs; Qdrant vectors; its own model artifacts | Query product tables, create canonical user/repository IDs, or serve frontend traffic |
| Qdrant | Vectors and searchable ML payloads written by ML | Act as the repository catalog or decide record identity |
| Ingestion job | GitHub/source data; internal ingestion API | Write PostgreSQL or Qdrant directly |

Supabase Auth owns credentials and provider identities. `app.users.user_id` equals `auth.users.id`; the backend owns the product profile. PostgreSQL owns durable state. Redis is an expendable feed queue. Qdrant is an expendable projection that can always be rebuilt from backend repository mappings.

## Canonical identity

- `user_id`: UUID created by Supabase Auth and registered transactionally in `app.users`.
- `repo_id`: UUID created only by `POST /api/internal/v2/ingestion/repositories/upsert`.
- `github_id`: immutable numeric GitHub repository ID, represented as a decimal string over HTTP.
- `owner_github_id`: immutable numeric GitHub user or organization ID, represented as a decimal string over HTTP. This is required for owner/follower ranking; do not derive ownership from mutable logins.
- ML and Qdrant must use `repo_id` as the canonical key. Qdrant points may use another point ID only if payload field `repo_id` is present and uniquely identifies the backend repository.
- Names, URLs, GitHub handles, and `full_name` are attributes, never identifiers.

## Response and authentication conventions

Public API successes use:

```json
{ "success": true, "data": {} }
```

Public API errors use:

```json
{ "success": false, "error": "Human-readable message." }
```

Feed, interaction, ingestion, and operations v2 endpoints return their versioned contract directly. Authentication uses `Authorization: Bearer <accessToken>`. The access token lasts 15 minutes. Refresh tokens are rotated in a secure HTTP-only cookie scoped to `/api/auth`. Internal routes require `x-internal-secret`; during rotation they accept `INTERNAL_API_SECRET_PREVIOUS` as well.

All timestamps are ISO 8601 UTC. All IDs described as UUIDs must be valid UUID strings. Request bodies are limited to 256 KB, except canonical internal ingestion, whose JSON parser is applied only after internal-secret authentication and is limited to 8 MiB. List endpoints accept `limit=1..100` and `offset=0..10000` unless stated otherwise.

## Frontend API

### Authentication

| Method and path | Body | Result |
|---|---|---|
| `POST /api/auth/signup` | `{email,password,username,full_name?,date_of_birth}` | Creates Supabase identity plus backend profile, returns `{accessToken,token,user}` |
| `POST /api/auth/login` | `{email,password}` | Returns access token and rotates refresh cookie |
| `POST /api/auth/refresh` | none; refresh cookie required | Consumes old refresh token and returns a new access token/cookie |
| `POST /api/auth/logout` | none | Revokes refresh token and clears cookie |
| `GET /api/auth/oauth/:provider` | `redirect_uri`, `code_challenge`, `auth_intent`, optional signup `date_of_birth` | Creates the server-side OAuth/PKCE attempt and returns the same-origin continuation URL |
| `GET /api/auth/oauth/continue` | `oauth_attempt` | Starts the provider authorization using the stored one-time attempt |
| `GET /api/auth/callback` | provider redirect | Consumes the provider attempt, creates a five-minute client exchange code, and redirects to the app |
| `POST /api/auth/exchange` | `{code,code_verifier}` | Verifies client PKCE, consumes the code, and returns the application access token/cookie |

Signup/profile creation and ML onboarding enqueue are one backend transaction. OAuth callback ensures the product profile exists before issuing a code. ML downtime never blocks authentication because onboarding delivery uses the outbox.

### User and onboarding

| Method and path | Body/query | Result |
|---|---|---|
| `GET /api/v2/users/me` | none | Private profile, stats, topic slugs, feed and feedback versions |
| `PATCH /api/v2/users/me` | Any subset of `{username,full_name,bio,avatar_url}` | Updated profile; unknown fields are rejected. GitHub identity fields are provider-managed and immutable through this endpoint. |
| `GET /api/v2/users/:userId` | none | Public active profile and stats |
| `PUT /api/v2/users/:userId/follow` | none | Idempotently follows; `204` |
| `DELETE /api/v2/users/:userId/follow` | none | Idempotently unfollows; `204` |
| `GET /api/v2/users/:userId/followers` | `limit`, `offset` | Followers |
| `GET /api/v2/users/:userId/following` | `limit`, `offset` | Following users |
| `GET /api/v2/users/:userId/likes-given` | `limit`, `offset` | Repositories liked by the user |
| `GET /api/v2/onboarding/status` | none | `{completed,profile_version}` |
| `PUT /api/v2/onboarding` | `{bio?,topics:[slug,...]}` | Replaces interests, increments profile version, enqueues ML onboarding |

Topic slugs are lowercase letters/numbers/hyphens, 1-50 characters. Onboarding accepts 1-50 unique topics.

### Repositories

| Method and path | Body/query | Result |
|---|---|---|
| `GET /api/v2/repositories` | `q?`, `limit`, `offset` | Active repository cards with latest stats and active ML summary |
| `GET /api/v2/repositories/:repoId` | none | Repository detail including README and topics |
| `GET /api/v2/repositories/:repoId/share` | none | Public minimal repository metadata for sharing |
| `GET /api/v2/repositories/trending` | `period` default `daily` | Active complete trending snapshot, ordered by position |
| `GET /api/v2/repositories/saved` | `limit`, `offset` | Current user's saved repositories |

Public Trending card projections are shared across viewers inside each API process, with
at most three cached responses of 100 cards and a five-second freshness bound
for counters, summaries, content and repository status. Every request rechecks
eligible active snapshots; snapshot IDs, activation versions and available-period
changes invalidate the response immediately, including ingestion from another
process. `ETag` covers the exact JSON response. Conditional GET/HEAD requests
return an empty `304` when unchanged; `Cache-Control: private, no-cache` requires
clients to revalidate through authentication rather than serving stale responses.
The full handler has one five-second caller deadline across public lookup, private
hydration and final serialization/hash, with monotonic pre/post work checks. Public
card hydration also retains its transaction-local four-second PostgreSQL timeout.
Expired pending work accepts no new waiters or
replacement query for that period until the underlying operation settles;
over-budget/busy requests return `503` with `Retry-After: 1` rather than stale cards.
Viewer reactions, saves and List selections are batch-loaded on every request
outside this public cache, with at most three private hydrations in flight. A
timed-out request retains its private admission slot until its actual transaction
settles. After connection acquisition, expired work rolls back before projection;
the local query timeout is the smaller of four seconds and the remaining caller
budget. The final viewer-specific JSON is serialized and hashed for its ETag;
conditional requests cannot reuse another viewer's private state or skip this read.

The frontend cannot import or mutate repository metadata. It records likes, saves, views, and other behavior through the interaction endpoint below. Repository details come from PostgreSQL, not ML/Qdrant.

### Feed

`POST /api/v2/feed`

```json
{
  "feed_request_id": "client-generated UUID",
  "session_id": "stable UUID for this app session",
  "limit": 10,
  "cursor": null
}
```

The response contains `serve_id`, `feed_version`, `source`, `model_version`, `items`, and `next_cursor`. Reusing the same `feed_request_id` is an idempotent replay and returns the same persisted serve. Pass a non-null `next_cursor` with a new `feed_request_id` to consume the next queue page. Cursors are opaque, signed, and bound to the user, session, feed version, and next position; invalid or stale cursors return `400`. `limit` is 1-25. Home feed fails closed: if live generation is unavailable, it may reuse only a previously served personalized ranking for the same user and feed version. It never substitutes a generic or trending list.

### Interactions

`POST /api/v2/interactions/batch` accepts 1-50 events:

```json
{
  "events": [{
    "event_id": "client-generated UUID",
    "schema_version": 2,
    "session_id": "UUID",
    "serve_id": "UUID or null",
    "repo_id": "backend UUID",
    "position": 0,
    "event_type": "like",
    "dwell_ms": null,
    "client_occurred_at": "2026-07-15T12:00:00.000Z",
    "context": {}
  }]
}
```

Allowed events: `impression`, `dwell`, `readme_open`, `github_open`, `like`, `unlike`, `dislike`, `undislike`, `save`, `unsave`, and `share`. `dwell` requires 3000-300000 ms; other events require `dwell_ms:null`. `event_id` provides durable idempotency. The backend applies reaction/save state, updates counters and versions, and inserts ML feedback into the same transaction. It returns `202` with accepted/duplicate counts.

### Comments

| Method and path | Body/query | Result |
|---|---|---|
| `GET /api/v2/repositories/:repoId/comments` | `limit`, `offset` | Chronological comments with author projection |
| `POST /api/v2/repositories/:repoId/comments` | `{body,parent_comment_id?}` | Creates comment; parent must belong to same repo |
| `PATCH /api/v2/comments/:commentId` | `{body}` | Updates only the current user's comment |
| `DELETE /api/v2/comments/:commentId` | none | Deletes only the current user's comment; `204` |

Comment bodies are 1-5000 trimmed characters.

### Collections and boards

| Method and path | Body | Result |
|---|---|---|
| `GET /api/v2/collections` | `repository_id?` | Current user's collections, repository counts, timestamps, and optional membership state |
| `POST /api/v2/collections` | `{name,description?,icon?,color?}` | Creates collection |
| `POST /api/v2/collections/save` | `{repositoryId,collectionIds[],boardIds[],event?}` | Atomically synchronizes a repository across all owned product Lists; a stable save/unsave event records feedback only when the saved union changes |
| `PUT /api/v2/collections/:collectionId` | `{name,description?,icon?,color?}` | Replaces mutable fields |
| `DELETE /api/v2/collections/:collectionId` | none | Deletes collection; boards become ungrouped |
| `GET /api/v2/boards` | none | Current user's boards and repo counts |
| `POST /api/v2/boards` | `{name,description?,visibility,collection_id?}` | Creates board |
| `PUT /api/v2/boards/:boardId` | same fields | Replaces mutable fields |
| `DELETE /api/v2/boards/:boardId` | none | Deletes board |
| `GET /api/v2/boards/:boardId/repositories` | none | Owner or public/unlisted board contents |
| `PUT /api/v2/boards/:boardId/repositories/:repoId` | none | Idempotently adds repository; owner only |
| `DELETE /api/v2/boards/:boardId/repositories/:repoId` | none | Removes repository; owner only |

Visibility is `private`, `public`, or `unlisted`. User ownership always comes from JWT, never request JSON.

## Ingestion API

Only a trusted ingestion process calls these endpoints.

### Repository upsert

`POST /api/internal/v2/ingestion/repositories/upsert`, maximum 100 records:

```json
{
  "repositories": [{
    "github_id": "123456789",
    "owner_github_id": "987654321",
    "github_node_id": "R_kg...",
    "full_name": "owner/repository",
    "owner": "owner",
    "name": "repository",
    "url": "https://github.com/owner/repository",
    "description": "...",
    "readme": "...",
    "primary_language": "TypeScript",
    "languages": ["TypeScript"],
    "topics": ["expo"],
    "star_count": 100,
    "fork_count": 5,
    "open_issues_count": 2,
    "pushed_at": "2026-07-15T12:00:00Z",
    "observed_at": "2026-07-15T12:05:00Z"
  }]
}
```

The response is `{mappings:[{github_id,repo_id,content_version,changed}]}`. The ingestion process must retain this mapping for the run. When content changes, the backend inserts a `repo_index` outbox job. Do not send data to Qdrant before receiving `repo_id`.

### Trending snapshot

`POST /api/internal/v2/ingestion/trending/snapshots` accepts `{snapshot_id,period,computed_at,source,repositories}` where repository entries use the upsert shape plus unique non-negative `rank` and optional `score`. Activation is atomic: incomplete snapshots never become frontend-visible.

The maintenance worker also builds a canonical GitHub trending candidate snapshot immediately on startup and every `TRENDING_INGESTION_INTERVAL_MS` (six hours by default) when `TRENDING_INGESTION=true`. These repositories expand the indexed candidate corpus; the home feed still requires the ML service to rank that corpus against the current user persona.

Run the same bounded ingestion once with `npm run ingest:trending`; the command closes its database pool before exiting and is safe to retry because the daily snapshot ID is deterministic.

To repair persona vectors after an ML collection restore or drift event, first dry-run `npm run reindex:personas -- --campaign=<incident-id>`, then repeat with `--execute`. The campaign key makes reruns idempotent and queues only completed users with real embedding context.

## Backend-to-ML API

The backend is the client and ML implements these internal endpoints. Every request includes `x-internal-secret`, `x-request-id`, `idempotency-key`, and `schema_version:2`.

| ML endpoint | Purpose | Required response behavior |
|---|---|---|
| `POST /api/v2/recommendations/generate` | Generate canonical `repo_id` ranking | Echo `generation_id`, `user_id`, `feed_version`; return unique known repo UUIDs, scores, model and embedding versions |
| `POST /api/v2/feedback/batch` | Apply durable interaction feedback | Idempotent by event IDs/idempotency key |
| `POST /api/v2/users/onboard` | Create/update user vector/profile | Idempotent by `job_id` and monotonic `profile_version` |
| `POST /api/v2/repositories/embed` | Create vector from canonical repo content | Idempotent by `job_id`; payload includes `repo_id` and `content_version` |
| `POST /api/v2/repositories/refresh` | Refresh derived features | Idempotent by `job_id` and feature version |
| `GET /api/v2/health` | ML/Qdrant readiness | Non-2xx when ML cannot safely accept work |

ML must return 2xx only after durable acceptance. Use `429` or `503` for retryable pressure/failure and an optional `Retry-After`; use other 4xx responses for terminal contract errors. The backend outbox retries with capped jitter, leases jobs with `SKIP LOCKED`, and moves terminal/expired work to `dead` for operator replay.

### Concise summary backfill

Roll out the Phase 3 contract in this order:

1. Stop the old outbox worker before changing ML. Confirm no `repo_index` row
   remains `claimed`; leave pending rows durable in PostgreSQL. An old worker
   would accept a strict ML `2xx` and mark it delivered without storing the
   returned summary artifact.
2. Deploy the backward-compatible ML release first and canary the strict
   repository-index response, including its bounded versioned `card_summary`.
   Do not allow repository-index jobs to drain through an older backend during
   this compatibility window, because that backend cannot persist the artifact.
3. Apply migration `0025_repository_summary_artifacts`, run `schema:audit`, and
   deploy the matching backend/outbox worker. The migration deliberately makes
   legacy or ambiguous summary rows inactive; do not reverse that normalization.
4. Start only the new outbox worker. Verify a live isolated ingestion canary stores `response_payload` and an
   active current-version summary. Only then enqueue the bounded, dry-run-reviewed
   summary backfill below. Do not run a production backfill as part of deployment.

Repository summary reindexing is dry-run only unless `--execute` is supplied,
and every run requires a stable campaign name. To inspect only active repository
content versions that do not have a matching active card summary:

```bash
npm run reindex:ml -- --campaign=phase3-card-summary-v1 --summary-backfill
```

After reviewing the report against fixtures or isolated local services, enqueue
the same idempotent campaign explicitly:

```bash
npm run reindex:ml -- --campaign=phase3-card-summary-v1 --summary-backfill --execute
```

Re-running the command with the same campaign does not duplicate outbox jobs.
An active `description_fallback` remains eligible for a later campaign until a
generated summary is active. ML identifies that bounded fallback with
`model_version: "repository-description-fallback-v1"`, so a recovered provider
can insert and activate a distinct generated tuple. Use a new campaign ID for
an intentional fallback-upgrade pass; the original campaign remains immutable.
Do not point this command at production without a separately approved migration
and rollout window.

Recommendation response shape:

```json
{
  "schema_version": 2,
  "generation_id": "UUID",
  "user_id": "UUID",
  "feed_version": 12,
  "model_version": "model-2026-07",
  "embedding_version": "embed-v3",
  "items": [{"repo_id":"UUID","score":0.91,"source":"personalized"}]
}
```

## Qdrant contract and rebuild

Qdrant is not an HTTP consumer of this backend. ML owns Qdrant reads/writes and receives all authoritative changes through backend jobs.

Recommended repository payload fields are `repo_id`, `github_id`, `content_version`, `content_hash`, `embedding_version`, `model_version`, and `indexed_at`. Create a fresh versioned collection for a dimensionality or distance change. Ingest backend mappings, embed only active repositories, verify every point has a unique valid `repo_id`, then switch the ML collection alias atomically. Old collections may be deleted only after ML health and recommendation contract checks pass.

After a database reset: run repository ingestion first, allow the outbox worker to deliver all `repo_index` jobs, verify `pending=0`, `dead=0`, and Qdrant point count equals indexed active repositories, then enable recommendation traffic. Never restore old Qdrant points into a database whose backend `repo_id` values were regenerated.

## Processes and production configuration

The production image is immutable and runs as four systemd-managed containers
so HTTP scaling never duplicates periodic jobs:

```text
gh-social-api.service
gh-social-outbox.service
gh-social-feed.service
gh-social-maintenance.service
```

Use one or more outbox workers; claiming is concurrency-safe. Run one feed and one maintenance worker initially. `WORKER_ROLE=all` is for local development only.

CI builds `backend/Dockerfile` from the repository root so the immutable image
contains `database/migrations` and `database/audits`. It validates those assets,
transfers the commit-SHA image, and requires the protected production variable
`PRODUCTION_DATABASE_BACKUP_VERIFIED_SHA` to equal the release commit after a
restorable backup has been verified. On the host it runs the compiled migration
and schema-audit commands from the candidate image before changing the
`gh-social-backend:current` tag or restarting any service. A failed preflight,
migration, or audit leaves the current containers untouched. After cutover it
rolls back to `gh-social-backend:previous` when `/readyz` fails. The host must
provide Docker, a root-owned `/etc/gh-social/backend.env` for runtime services,
and a root-owned `/etc/gh-social/migrator.env` whose `DATABASE_URL` uses the
dedicated migration role. The candidate migration and audit receive both files,
with `migrator.env` taking precedence; runtime containers receive only
`backend.env`. Both files must have mode `400` or `600`. Credentials are never
copied into the image. Changes under `database/` also trigger this workflow, so
a migration cannot merge without producing a candidate deployment.

Build the production image with the repository root as its context:

```sh
docker build -f backend/Dockerfile -t gh-social-backend:local .
docker run --rm --entrypoint node gh-social-backend:local dist/scripts/verify-deployment-assets.js
```

`docker build backend` is intentionally unsupported because Docker cannot read
the top-level database assets from that context.

Required production environment variables: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `CLIENT_URL`, `BACKEND_URL`, `OAUTH_REDIRECT_ORIGINS`, `REDIS_URL`, `GITHUB_TOKEN`, `ML_SERVICE_URL`, and `INTERNAL_API_SECRET`. Start from `.env.production.example`. Production requires the complete V2 path, `FEED_V2_CANARY_PERCENT=100`, and `TRENDING_FALLBACK=false`; readiness stays red until the ingestion canary, feedback consumer, and strict heavy-ranker gates pass. Rotate internal secrets only through the documented primary/previous overlap, not when adding another worker process.

The outbox launch script sets `--role=outbox` portably and fails startup when `ML_FEEDBACK_OUTBOX` is disabled. A hardened systemd template and install/acceptance procedure are in [the outbox worker runbook](../docs/runbooks/outbox-worker.md).

Apply migrations through `0031_profile_generation_epoch` before starting the updated workers.
Migration `0028_counter_reconciliation_progress` is already in the journal.
Apply migrations in journal order: `0028`, the unchanged published `0029`, then
the additive `0030` safety upgrade and `0031` profile-epoch boundary. Existing
installations apply only unapplied migrations; fresh installations apply the full sequence. This integrated
history also retains `0026_readme_summary_pipeline`; do not combine the alternate
JSON-outbox prewarm migration with this dedicated-table migration. Before applying
`0031` or enabling the new code, drain and replace ALL old API, outbox and
feed-generation processes, not only dedicated workers. API processes can also
generate feeds and write profiles; old instances can publish into the new namespace
or change profiles without advancing it. Old outbox workers can still run the
synchronous prewarm hook and do not write publication witnesses.

Outbox inserts and pending transitions emit payload-free PostgreSQL notifications
only after commit. Notifications wake idle workers; they never acknowledge jobs.
The existing bounded idle poll (default 30 seconds) remains the recovery path
when a signal is lost or the listener is unavailable. Reconnection subscribes
again and immediately checks durable work. Wake hints coalesce into one pending
run while a task is busy; delivery tasks never overlap within one process.
Prewarm checks also report the next eligible job or expired claim, so an early
notification cannot replace a scheduled retry with the full idle interval.

LISTEN needs a direct or session-pool PostgreSQL connection. If `DATABASE_URL`
uses transaction pooling, set `OUTBOX_LISTEN_DATABASE_URL` to a direct/session
connection to **the same database**. Credentials stay in the worker environment.
Each outbox process uses one dedicated notification session, closed on shutdown;
failed startup/reconnect attempts fall back to polling and retry every 30 seconds.

Successful onboarding delivery atomically records `telemetry.feed_prewarm_jobs`.
Prewarm runs separately when both ML delivery and recommendations are enabled:
one generation at a time per process, with one durable slot per user. Repeated
deliveries of the same profile/feed version coalesce. New profile versions
supersede old claims; older deliveries cannot replace newer profile targets.
Claims adopt the current feed version and require exact equality with the current
ML profile version. Every profile-version increment (including non-material edits)
advances the feed namespace in its source transaction. Before requesting ML,
generation requires exact-profile successful delivery evidence in the durable
prewarm slot, then rechecks both captured versions before publication. Missing
legacy evidence uses synchronous persona repair under the generation lock and
heartbeat. Repair acknowledges only a still-active, unchanged profile in a short
user-before-feed transaction after network I/O; repeated identical proof preserves
the existing retry horizon. Migration `0031` invalidates every existing feed
namespace once and removes only ephemeral slots lacking retained exact-profile
delivered-outbox proof. Lost legacy proof forces repair, never assumed success;
serve history and business data remain intact. Failed/stale/coalesced generations retry durably, with generation failures
backing off up to 60 seconds; crashed claims expire after `ML_TIMEOUT_MS + 60000`
milliseconds (65 seconds by default). Disabled users are skipped and deleted
users cascade out of the queue. An immutable scheduling time bounds retries to
seven days; older jobs become visibly `expired`. For jobs already present when
`0030` is applied, the horizon starts at upgrade because original `0029` had no
immutable scheduling timestamp. Their status, claims and retry counters are retained.
Only a new profile/feed target
resets this horizon, never a retry. Claim tokens, lease expiry and current profile
and feed versions are rechecked before prewarm publication and are required for
completion. PostgreSQL checks and Redis publication are not one transaction: a
claim that expires in that gap may make an identical-version first publication,
but cannot acknowledge a replaced claim or overwrite an existing Redis success
witness. No PostgreSQL row lock is held across Redis or ML network I/O.

A successful live or prewarm publication satisfies later prewarm for that feed
version without resetting the remaining queue, even for empty/consumed feeds.
The Redis publication script atomically checks generation-lock ownership and
writes an eight-day success witness with the queue; prewarm cannot replace an
existing witness. PostgreSQL stores a monotonic `last_published_feed_version`
after publication. Retained completed generation attempts are
also success evidence when a Redis witness is missing. A prior serve alone may
be fallback or an ambiguous lost publication, so prewarm fails closed without
marking it successful and eventually expires visibly. These
checks preserve process-crash/retry recovery, including a crash after Redis
publication but before SQL completion. They are not an exactly-once guarantee
under simultaneous Redis data loss and process failure before a durable witness;
existing durable success/serve evidence is handled fail-closed. Completed slots stay until user deletion;
this migration schedules future deliveries and does not backfill old ones.

The authenticated operations response includes separate prewarm pending, claimed,
expired, retrying, expired-claim counts and oldest-pending age. Its aggregate SQL
has a two-second statement budget; expiry cleanup handles at most 100 jobs/run.
`feed_prewarm_run_ms` measures generation-lane occupancy. Run focused PostgreSQL
checks alone on a migrated disposable loopback database (no live ML needed):

```sh
DATABASE_URL=postgresql://postgres@127.0.0.1:55425/weave_scroll \
  RUN_OUTBOX_WAKEUPS_INTEGRATION=1 \
  node --import tsx --test tests/database/outboxWakeups.integration.test.ts
```

The fixtures create/remove their own users/jobs and test commit/rollback,
reconnection without polling, notification loss, version fencing and slow/failed
prewarm. Timing diagnostics compare actual producer-call-to-claim-response upper
bounds at the same fallback interval, including transaction execution. They are
local samples, not production latency guarantees. Rollback may stop the new
scheduler and retain its additive table/triggers; pending prewarm can resume
after re-upgrade. Old workers still use their synchronous prewarm hook.

The coordinated backend, ML, OAuth, corpus, device, and load gates for v2 are in [the Weave v2 release runbook](../docs/runbooks/weave-v2-release.md).

Set `TRUST_PROXY=true` only when exactly one trusted ingress proxy is in front of the service. Authentication endpoints have a Redis-backed per-IP/path limit of 20 requests per minute; configure broader request and connection limits at the ingress as well.

`GET /healthz` is process liveness. `GET /readyz` checks PostgreSQL, Redis, ML,
the durable outbox, and feature dependencies. Production defaults
`OUTBOX_MAX_DEAD` to zero, so permanently failed ML delivery cannot hide behind
a green deployment. Internal `GET /api/internal/v2/operations/status` adds
metric state. `POST /api/internal/v2/operations/outbox/:outboxId/replay` retries
a dead outbox row. Identity-only version-1 onboarding jobs that are provably
obsolete are classified, never replayed, with
`POST /api/internal/v2/operations/outbox/:outboxId/supersede`; see the outbox
worker runbook. A historical repository job can use the same endpoint only
after a newer canonical job for that repository has been delivered.

## Search SQL capacity

Search uses a lazy, exclusive pool with at most three additional PostgreSQL
connections per API process, separate from the main pool. Admission allows three
active transactions and at most 16 waiting operations. Waiting operations are
removed on cancellation or deadline before submitting `BEGIN`; an admitted
transaction retains its permit through actual commit/rollback. The common search
budget is five seconds, with each search statement limited to at most 1.8 seconds
or the remaining budget. Driver connection establishment has a two-second timeout
with no reconnect backoff; idle search connections close after 20 seconds. Both
API and worker shutdown close an existing search pool without creating an unused
one.

Compatibility restriction: search fails closed with multi-host or target-session
failover configurations because the pinned driver does not reliably bound those
retry paths. A single endpoint (including a one-element host list) and the default,
unset target are supported. The configured endpoint,
credentials, main pool and existing v2 search cursors are unchanged.

## Database deployment and clean ingestion

1. Back up Supabase and verify restore access.
2. Set the target `DATABASE_URL` and run `npm run migrate`.
3. Run `npm run schema:audit`; do not deploy on any missing table, index, function, role, or prohibited frontend grant.
4. Stop API and workers before a clean reset.
5. Verify the database host and project manually. Run `npm run db:reset:v2` only with both `RESET_V2_DATABASE=I_UNDERSTAND_THIS_DELETES_DATA` and `ALLOW_REMOTE_DATABASE_RESET=1`.
6. The reset clears `app` and `telemetry`, not `auth.users`. Existing users will be recreated in `app` on their next login. Delete Supabase Auth users separately only if account deletion is intended.
7. Start API plus three worker roles. Run repository and trending ingestion.
8. Wait for outbox drain and rebuild Qdrant from the new backend-issued mappings.
9. Require `/readyz` healthy, outbox `dead=0`, integration tests passing, and ML health healthy before frontend release.

Databases with the known parent-journal history are upgraded directly: the migrator executes and records the retroactive `0004_add_likes_given` and `0005_add_is_saved` SQL before `0008`. Do not set `ADOPT_LEGACY_SCHEMA` for that normal upgrade. The one-time `ADOPT_LEGACY_SCHEMA=1` escape hatch is only for an audited schema whose baseline Drizzle history is genuinely absent or incomplete. The migrator structurally verifies each legacy/v2 migration before recording its hash and refuses adoption when a required table, column, grant, view, or role is missing. Exercise it on a clone and run `schema:audit` before using it against the target.

For verification use `npm run build`, `npm test`, database integration with `RUN_DATABASE_INTEGRATION=1`, parent-history migration integration with `RUN_MIGRATION_UPGRADE_INTEGRATION=1`, seeded Phase 3 migration/reapply integration with `RUN_REPOSITORY_SUMMARY_MIGRATION_INTEGRATION=1`, and HTTP integration with `RUN_HTTP_INTEGRATION=1`. Migration integration is destructive and refuses non-local PostgreSQL; use only an isolated local database. The integration suite uses Redis database 14 by default and clears only that test database.

Trending caches only public card content. Viewer reactions, saved state and List
memberships are loaded per request, then included in that response's ETag;
conditional requests cannot reuse another viewer's state. README content and
summary provenance remain distinct in the cached projection.

Run the PostgreSQL Trending cache checks separately from other database suites:

```sh
# From backend/, after migrating an otherwise empty disposable weave_scroll database:
DATABASE_URL=postgresql://postgres@127.0.0.1:55424/weave_scroll \
  RUN_TRENDING_INTEGRATION=1 \
  node --import tsx --test tests/trending/trending.integration.test.ts
```

Use your disposable PostgreSQL instance's port and credentials. This suite requires
a migrated database named `weave_scroll` on a loopback host, outside production,
with no URL query/hash and no pre-existing active, complete Trending snapshots.
It creates and removes its own synthetic repositories and snapshots; do not run
it alongside other suites that change those tables. Redis and ML are not needed.
Without `RUN_TRENDING_INTEGRATION=1`, these PostgreSQL checks are skipped.

### Counter reconciliation

Apply `0028_counter_reconciliation_progress` before starting the updated
maintenance worker. `COUNTER_RECONCILIATION_BATCH_SIZE` bounds each repository
and user transaction to 250 candidate counter rows by default (range 1–1000).
The worker continues every second while a sweep has remaining work, then waits
five minutes. Abandoned outbox claims and superseded repository-job repairs
retain their independent five-minute scan.

PostgreSQL stores the last UUID and fixed upper UUID for each sweep. Repairs and
cursor advancement commit together; a restart resumes the same range. A rotating
audit finds drift without relying on dirty markers. Both scopes finish the same
sweep before the worker backs off. Inserts behind the cursor
and rows skipped under foreground locks are retried on the next sweep. Missing
counter rows themselves are not created by this audit.

Each batch locks only its bounded candidate IDs with `FOR UPDATE SKIP LOCKED`,
then computes grouped source aggregates in a **new READ COMMITTED statement**.
Interaction writers must update their source rows and counters in the same
transaction; maintenance never locks source rows. Separate repository/user
transactions preserve foreground lock ordering. Only differing counters are
updated; follow counts are outside this repair's scope. Transaction-local
statement/lock timeouts are 3000/250 ms. These bound individual statements, not
the entire sweep; exceptionally large source histories can time out and require
a smaller batch or query investigation.

`counter_reconciliation_batch_ms` and `counter_reconciliation_rows` expose
per-scope batch duration and scanned/updated/skipped counts. Run the dedicated
concurrency, restart, rollback and WAL checks alone against an empty, migrated
disposable loopback `weave_scroll` database:

```sh
DATABASE_URL=postgresql://postgres@127.0.0.1:55429/weave_scroll \
  RUN_RECONCILIATION_INTEGRATION=1 \
  node --import tsx --test tests/database/counterReconciliation.integration.test.ts
```

Use your local instance's port and credentials. These fixtures create and remove
their own users/repositories and reset the maintenance cursors. Redis and ML are
not needed. The WAL comparison is a local sample, not a production benchmark.

For a strict ML collection rebuild, run `npm run reindex:ml -- --campaign=<id>`
first as a dry run, then repeat with `--execute` only after reviewing the counts
and confirming the ML target collection. The campaign is idempotent and only
adds new outbox rows; see the outbox worker runbook.

Repository summary compatibility requires the ML repository-index endpoint to
return its versioned `card_summary` response. Deploy that ML contract before
enabling this backend worker. Apply `0024_repository_summary_artifacts` and run
`npm run schema:audit` before starting the updated backend. These are release
steps requiring the normal environment authorization; local tests do not run
them against a deployed service.

Authenticated canonical ingestion accepts JSON bodies up to 8 MiB; other JSON
routes retain 256 KB. Canonical README text and its source metadata are stored
separately from summaries. Repository-index delivery commits the summary and
outbox acknowledgement together. `ML_REPOSITORY_INDEX_TIMEOUT_MS` defaults to
240000, and `OUTBOX_LEASE_MS` must exceed it by at least 60000 milliseconds.

To backfill missing generated summaries, review a dry run with
`npm run reindex:ml -- --campaign=<id> --summary-backfill`, then add `--execute`
only after approving the counts and target ML collection. Description fallbacks
remain eligible for recovery. Repeating the same campaign does not duplicate
its jobs; use a new campaign ID to retry a completed fallback after provider
recovery. Roll back the application first if necessary and retain the additive
summary columns/artifacts; do not delete canonical content or migration history.
