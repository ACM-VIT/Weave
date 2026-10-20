# Runtime data integrity and real local testing

## Corrective change

The earlier browser session used an existing development-only auth bypass and three static repositories. Their engagement numbers were sample values. Those paths have now been removed from application source: the preview user, sample repository module, feed/detail/profile substitutions and FollowButton's local-only success path. Authentication, repositories, follows and activity delivery now use the normal API paths in development as well as release builds. Test fixtures remain confined to tests/QA scripts.

Home retains its personalized-feed contract. If recommendations are unavailable, its error view offers both Retry and a real Explore destination. No automatic Trending substitution or ranking-policy change has been made while the user preference is pending.

## Where likes come from

1. PostgreSQL `app.repo_engagement.likes_count` is selected by `backend/adapters/postgresFeedPersistence.ts:listActiveRepositories`.
2. Node sends each canonical repository in `POST /api/v2/feed`.
3. `src/api/feed.ts` decodes feed pages; `src/utils/repository-mapper.ts` maps `likes_count` into `repository.stats.likes`.
4. The feed renders that count, with an optimistic adjustment for the viewer's pending reaction. The durable activity outbox sends `POST /api/v2/interactions/batch`.
5. `backend/services/activityV2Service.ts` transactionally updates `app.reactions`, the aggregate likes/dislikes in `app.repo_engagement`, and the viewer's `app.user_stats`. Duplicate event IDs and reaction transitions prevent double counting. PostgreSQL engagement updates happen independently of the ML worker delivering its outbox.

A read-only transaction against the configured database on 2026-10-20 counted **1,589 repositories, all active, with stored likes on 32 repositories**. No rows were seeded or modified during this inspection. No authenticated live mutation is claimed verified without a user session.

## Current local browser session

- Browser: `http://localhost:8096/login`.
- Frontend: branch `fix/product-fixes-v2`, normal authentication, `EXPO_PUBLIC_BACKEND_URL=http://localhost:5001/api`.
- Node API: loopback `127.0.0.1:5001`, this branch's built backend, existing configured PostgreSQL and Supabase authentication.
- Redis: isolated local Redis at `127.0.0.1:6385`; the old local configuration referenced a Redis hostname that no longer resolves. The local Redis is a cache/session service, not a substitute repository dataset. It has no persistence or automatic startup service.
- `ML_V2_RECOMMENDATIONS=false`, `ML_FEEDBACK_OUTBOX=false`, and empty ML URL/internal secret for this local process. Runtime ML client/generation objects are asserted absent. Search takes the existing lexical fallback when semantic configuration is absent. The API process registers no workers and runs no migrations.
- Local `/readyz` returns **200** with PostgreSQL/Redis healthy, ML explicitly disabled and no workers. Local browser CORS preflight returns **204**.
- Normal browser actions use the real configured database and auth service. Saves, comments and reactions initiated by the signed-in user persist normally. No demo account or forged authentication token is supplied.

The deployed Node `/healthz` returns 200, while deployed `/readyz` returns 503: ML requests time out and an existing ML outbox dead job is reported. Deployed CORS also rejects localhost origins. No deployed configuration, database migration, worker, job state or ML deployment was changed. A readiness success for the ML-disabled local process does not establish that the production ML pipeline is healthy.

## List delay diagnosed on 2026-10-21

The authenticated List page initially returned HTTP 500 because the connected database has not received migration `0024_repository_summary_artifacts.sql`. Both summary artifact metadata (`highlights`, provenance/version fields) and README path metadata were absent. TanStack Query's default retries amplified the delay with repeated failures/backoff. Warm PostgreSQL `SELECT 1` round trips measured roughly 486–537 ms; loopback health requests were approximately 1–20 ms. ML was disabled throughout.

Repository list, detail and feed reads now tolerate these optional columns through PostgreSQL JSON projections. Artifacts without explicit generated/description-fallback provenance are excluded, preserving the Summary/README distinction; real descriptions and full README content remain available. This does not replace the migration required before artifact writes/workers are enabled. No live schema was changed. List failures now surface immediately with the existing manual retry action.

The signed-in user's actual Medhansh List was verified in the browser after the repair: one saved repository, codedogQBY/ReadAny, loaded instead of the server error. No repository was added, removed, or fabricated by this verification. Remote database latency remains; this is not a production performance benchmark.

## Validation

- Lint and typecheck pass.
- Frontend: **144 tests pass**, including new regression checks for exact backend-like-count mapping and absence of runtime demo/auth-bypass/local-only mutation paths.
- Backend build passes; **139 tests pass, 9 opt-in integration tests skipped**. Tests used loopback-only dummy configuration, never the production environment file. The destructive opt-in database suites were not run against the configured live database.
- iOS/Android/web export succeeds with the configured deployed Node API URL; export contains no preview-user or development-repository substitution strings.
- Strict UI audit and `git diff --check` pass.
- The authenticated List page loads real saved data. Live feed pagination, reaction persistence across reload, multi-List writes, comments and OAuth completion still require verification. No account was created and no credentials were requested or entered by the agent.
- A new isolated PostgreSQL regression test passes against both pre-migration and current artifact/README schemas. It executes all nine production summary subqueries, rejects missing/legacy provenance, stale content and inactive artifacts, and verifies generated/description-fallback artifacts and README metadata. The test uses temporary tables in a separate loopback database and never runs against the configured live database.

This correction removes the demo behavior and enables real local testing. It is not a claim that the app is ready for a store release: authenticated end-to-end verification, native release QA and repair/verification of the deployed ML pipeline are still outstanding. No push or deployment was performed.
