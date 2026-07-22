# Weave v2 release gates

Do not enable personalized ML traffic until every gate below has evidence. The
July 21 audit found 578 active repositories, 15 obsolete dead identity-only
onboarding rows, and an ML v2 readiness failure. Recalculate counts at release
time rather than treating those values as constants.

## 1. Backend owner

Keep the rollout dark while deploying:

```dotenv
ML_V2_RECOMMENDATIONS=false
FEED_V2_CANARY_PERCENT=0
TRENDING_FALLBACK=true
ML_FEEDBACK_OUTBOX=true
```

Back up PostgreSQL, then deploy the same reviewed image to the API and outbox
worker. Stop old API instances before exposing the PKCE build; do not run mixed
old/new auth handlers during this transition. Both processes must use the same
PostgreSQL and Redis instances. Run:

```text
cd backend
npm run migrate
npm run schema:audit
npm run build
npm test
```

The GitHub `production` environment is fail-closed: after verifying a
restorable backup, set `PRODUCTION_DATABASE_BACKUP_VERIFIED_SHA` to the exact
release commit. The deploy job builds from the repository root, verifies that
the candidate image contains every journaled migration and the schema manifest,
then runs `dist/scripts/migrate.js` and `dist/scripts/schema-audit.js` inside
that candidate image. It changes the `current` image tag and restarts services
only after both commands pass. Never put `ADOPT_LEGACY_SCHEMA`, reset flags, or
the local auth stub flag in the shared production environment file; automated
deployment rejects them.

The host must keep migration credentials separate from runtime credentials.
`/etc/gh-social/backend.env` contains the application environment and least-
privilege runtime `DATABASE_URL`; root-owned `/etc/gh-social/migrator.env`
contains `NODE_ENV=production` plus the dedicated migrator `DATABASE_URL`.
Docker reads the migrator file last for the preflight, migration, and audit.
The four long-running services never receive it. Both files must be owned by
root with mode `400` or `600`; the remote deployment rejects broader modes.

Migration `0018_auth_profile_integrity` must finish before the new API starts.
It removes the legacy `auth.users -> public.users` signup trigger, adds DOB and
the durable onboarding flag to `app.users`, and preserves existing accounts as
completed. `schema:audit` fails while that trigger or either column remains.

Required public/auth configuration:

```dotenv
BACKEND_URL=https://weave-backend.krishang.dev
CLIENT_URL=ghsocial://callback
OAUTH_REDIRECT_ORIGINS=ghsocial://callback
OAUTH_ATTEMPT_TTL_SECONDS=300
```

In Supabase Authentication URL configuration, allow the exact redirect URL:

```text
https://weave-backend.krishang.dev/api/auth/callback
```

The OAuth handoff state and both PKCE verifiers are short-lived and require the
shared Redis deployment. Do not run API replicas against private Redis stores.

Classify each audited obsolete row through the internal authenticated endpoint;
never update statuses directly:

```text
POST /api/internal/v2/operations/outbox/:outboxId/supersede
```

Require `pending=0`, `claimed=0`, and `dead=0`. The historical rows should be
reported as `superseded`, not delivered. Confirm every historical dead row is
an obsolete onboarding row; a dead feedback row intentionally blocks later
feedback for that user and must be corrected and replayed oldest-first.

## 2. ML owner

Do not deploy the current old `main` image. Review and merge the hardened
candidate `7f1460c0476736594380ac691aac0cdff7515b98` only after its tests and
rollback prerequisites pass. Use external production configuration:

```dotenv
APP_ENV=production
LEGACY_ML_API_ENABLED=false
V2_FEEDBACK_CONSUMER_REQUIRED=true
QDRANT_COLLECTION_NAME=osiris_research_corpus_v2_20260721
MIN_ELIGIBLE_REPOSITORIES=500
V2_HEAVY_RANKER_ENABLED=false
V2_HEAVY_RANKER_REQUIRED=false
V2_HEAVY_RANKER_TRAFFIC_PERCENT=0
```

Take and verify a Qdrant snapshot, create the new versioned collection, and run
the candidate API on a private/loopback port. The backend owner first runs:

```text
npm run reindex:ml -- --campaign=v2-strict-20260721 --batch-size=100
```

Require `active=eligible`, `missing_content=0`, and `invalid=0`, then repeat with
`--execute`. Drain only into the candidate collection. Before cutover require:

- eligible repository count at least 500;
- every current active PostgreSQL repository ID present in Qdrant;
- zero missing, unexpected, legacy, or duplicate repository identities;
- API and feedback worker on the same release SHA;
- feedback heartbeat current, DLQ zero, v2 smoke non-empty, and v1 health 404.

The candidate backend also fails `/readyz` with `503` whenever recommendations
are enabled without an exact positive `eligible_repository_points` value, or
while `ML_FEEDBACK_OUTBOX=true` and
`feedback_consumer_release_mismatch` is missing or true. This runtime floor is
not a substitute for the 500-repository release gate above.

The acquisition repository must also update
`acquisition/backend_client.repository_upsert_record()` to transmit its real
computed pushed-age, 3/7/30-day deltas, contributor count, README/code ratio,
recent commits, timestamps, and discovery fields. Do not map raw daily stars to
`trend_velocity`; ML derives velocity from real deltas.

## 3. Turn on and verify

After ML is healthy, enable a small deterministic recommendation cohort, verify
fallback remains available, and expand only while readiness and latency stay
green. A real Android device must pass:

- email signup/login and 15+ minute token refresh;
- Google and GitHub OAuth, relaunch, logout, and a second login;
- onboarding categories and personalized feed;
- like/dislike, README open, GitHub open, dwell, save-to-board, comments, and
  offline feedback recovery;
- feed refresh/pagination without duplicate or stale pages.

Use a dedicated test account and run the feed load gate against staging first:

```text
LOAD_BASE_URL=https://staging.example/api \
LOAD_CONFIRM_BASE_URL=https://staging.example/api \
LOAD_AUTH_TOKEN=<short-lived-test-token> \
LOAD_CONCURRENCY=25 \
LOAD_DURATION_SECONDS=120 \
npm run load:feed:v2
```

The script fails on empty feeds, excess errors, or p95 over the configured
limit. Review database/Redis/ML CPU, memory, connection saturation, outbox lag,
and p95/p99 during the run before repeating a deliberately bounded production
canary.

## 4. Mobile release

Android artifacts are built locally through the single supported command:

```sh
npm run build:android:artifact
```

The command embeds and verifies
`EXPO_PUBLIC_BACKEND_URL=https://weave-backend.krishang.dev/api`, preflights the
live GitHub and Google OAuth broker contract, and updates
`artifacts/Weave-v2.0.0-internal-QA.apk`. It defaults to `arm64-v8a` and reuses
native Gradle outputs across ordinary frontend changes. EAS is not part of the
Weave release workflow.

This internal-QA APK uses the generated debug keystore and must not be
published. A store release requires a persistent externally managed Android
keystore, a higher version code, an AAB built locally, and every live gate in
this runbook to pass. Configure `EXPO_PUBLIC_SENTRY_DSN` and valid Sentry
organization/project/auth settings before that store build.
