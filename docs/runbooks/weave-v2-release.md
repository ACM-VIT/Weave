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

There are three distinct Android artifacts:

- A local `./gradlew assembleRelease` APK uses the generated debug keystore in
  this project. It is QA-only, must not be published, and is not an
  upgrade-safe distribution artifact.
- The EAS `release-apk` profile produces an Expo-credential-signed internal APK
  for testers. It is shareable but is not a Play Store release.
- The EAS `production` profile produces the signed store artifact (AAB). Do not
  submit it until every live gate in this runbook passes.

EAS production must define
`EXPO_PUBLIC_BACKEND_URL=https://weave-backend.krishang.dev/api`. Configure
`EXPO_PUBLIC_SENTRY_DSN` and valid Sentry organization/project/auth settings
before a store release; disabling source-map upload is acceptable only for a
local or EAS internal APK.
