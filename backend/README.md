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

All timestamps are ISO 8601 UTC. All IDs described as UUIDs must be valid UUID strings. Request bodies are limited to 256 KB. List endpoints accept `limit=1..100` and `offset=0..10000` unless stated otherwise.

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

Trending card responses are shared across viewers inside each API process, with
at most three cached responses of 100 cards and a five-second freshness bound
for counters, summaries, content and repository status. Every request rechecks
eligible active snapshots; snapshot IDs, activation versions and available-period
changes invalidate the response immediately, including ingestion from another
process. `ETag` covers the exact JSON response. Conditional GET/HEAD requests
return an empty `304` when unchanged; `Cache-Control: private, no-cache` requires
clients to revalidate through authentication rather than serving stale responses.
Hydration has a five-second caller deadline and a transaction-local four-second
PostgreSQL statement timeout. Expired pending work accepts no new waiters or
replacement query for that period until the underlying operation settles;
over-budget/busy requests return `503` with `Retry-After: 1` rather than stale cards.
Viewer reactions, saves and List selections must be loaded outside this shared
public cache; any viewer overlay must have its final response ETag recomputed.

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

The response contains `serve_id`, `feed_version`, `source`, `model_version`, `items`, and `next_cursor`. Reusing the same `feed_request_id` is an idempotent replay and returns the same persisted serve. Pass a non-null `next_cursor` with a new `feed_request_id` to consume the next queue page. Cursors are opaque, signed, and bound to the user, session, feed version, and next position; invalid or stale cursors return `400`. `limit` is 1-25. If ML or Redis is unavailable, the backend serves a durable PostgreSQL fallback when possible.

#### Indexed low-watermark refill rollout

`FEED_REFILL_INDEX_READY` defaults to `false`. Leave it false while any legacy
reservation or generation writer is running. First upgrade **all** API, feed,
outbox and maintenance processes that use the feed queue, then drain legacy
reservations or wait at least the largest reservation lease configured on any
old writer after the last old writer stops. Only then may an authorized operator
set the gate to `true` in compatible processes. An empty index is not evidence
that this prerequisite is satisfied. Enabling the gate is a separate deployment
decision; these source changes do not perform that rollout.

With the gate enabled, successful personalized serves schedule best-effort
refill below `FEED_REFILL_LOW_WATERMARK` (default 15), up to
`FEED_REFILL_TARGET_DEPTH` (default 45, maximum 100). The watermark must be lower
than the target. The per-process scheduler holds at most 128 pending/active
user-version jobs and two actual generations, retaining ownership until each
operation settles. Dropped/failed precomputation is reconstructed by a later
serve; normal on-demand generation remains available.

Reservation/refill Lua returns remaining depth atomically, so production cursor
and scheduling decisions do not need an extra depth read. Indexed generation
snapshots and atomically deduplicates against queued and live reserved items,
never replaces outstanding reservations, checks the generation lock token at
append, and rejects invalidated versions. Lua snapshots fail closed above 128
active reservation keys or 500 queued/reserved entries; append never grows the
queue past its configured target or total tracked occupancy past 500.
Reservations use the per-user/version sorted-set key
`feed:v2:reservation-index:<user_id>:<version>`; members are reservation meta
keys and scores are Redis-clock lease deadlines in milliseconds. Reserve/refill
maintains the lease and commit/release removes membership. Reconciliation must
reuse this index contract rather than introduce competing reservation tracking.

Reconciliation reuses that index with a bounded legacy repair pass, even while
indexed refill is disabled or writers are mixed. Each cycle performs exactly two
SCAN calls: up to 16 reservation indexes (8 members each), plus up to 128 legacy
feed keys. Metadata/TTL snapshots and repair are pipelined, with at most 256
unique reservation candidates. SCAN COUNT is a hint: oversized replies are
consumed over subsequent cycles at the same cursor with an offset, rather than
retaining an unbounded pending array. As with SCAN itself, concurrent mutation
can duplicate or omit observations; repeated passes repair missing tracking.
This bounds processed work, not Redis's SCAN reply size or the number of cycles
needed to revisit every key. It is not a guarantee of recovery before expiry.

Queue writes and reservation transitions also maintain
`feed:v2:version-index:<user_id>`, a sorted set of decimal version strings capped
at 128 members by compatible writers. Eviction removes tracking only, never
queue data; the bounded legacy pass repairs omitted versions. Each reconciled
user gets one current-version lookup and one cleanup per cycle. Cleanup checks
at most 128 indexed versions and deletes only exact queue keys strictly older
than the captured version, preserving future versions and all reservation/lock
data. It does not treat an absent index entry as proof that data is absent.
No keyspace scan is performed per reservation or per user. These changes do not
alter the default-off rollout gate or authorize enabling indexed refill.

To roll back to legacy binaries, disable the gate on **all** compatible writers
and let active indexed generations settle before starting old writers. Queue
precomputation is expendable, but do not delete active reservation data. Feed
cursor format, durable request replay and version namespace stay unchanged.

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
| `POST /api/v2/collections/save` | `{repositoryId,collectionIds[]}` | Atomically synchronizes a repository across owned collections |
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

For verification use `npm run build`, `npm test`, database integration with `RUN_DATABASE_INTEGRATION=1`, parent-history migration integration with `RUN_MIGRATION_UPGRADE_INTEGRATION=1`, and HTTP integration with `RUN_HTTP_INTEGRATION=1`. The integration suite uses Redis database 14 by default and clears only that test database.

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

For a strict ML collection rebuild, run `npm run reindex:ml -- --campaign=<id>`
first as a dry run, then repeat with `--execute` only after reviewing the counts
and confirming the ML target collection. The campaign is idempotent and only
adds new outbox rows; see the outbox worker runbook.

Repository summary compatibility requires the ML repository-index endpoint to
return its versioned `card_summary` response. Deploy that ML contract before
enabling this backend worker. Apply `0025_repository_summary_artifacts` and run
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
