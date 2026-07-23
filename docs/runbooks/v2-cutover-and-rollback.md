# V2 Cutover And Rollback Runbook

## Preconditions

Do not expose traffic unless all verification reports are current,
`schema:audit` passes on the target database, Qdrant reports one canonical V2
identity per active repository, dead outbox count is zero, restore evidence is
current, and named data/runtime operators approve.

## Deployment And Enablement Order

1. Run migration, schema audit, V2 backfill, and reconciliation on an isolated
   staging environment.
2. Deploy backend and ML with every positive V2 gate enabled,
   `FEED_V2_CANARY_PERCENT=100`, and `TRENDING_FALLBACK=false`.
3. Keep the load balancer closed while readiness validates PostgreSQL, shared
   Redis, feedback heartbeat, canonical Qdrant collections, eligible corpus,
   onboarding profile, and production-qualified heavy ranker.
4. Run the authenticated V2 smoke and load gates.
5. Expose traffic only after all checks pass; do not use the removed V1 or
   non-ML feed paths as a rollout mechanism.

## Hold Criteria

- Any unknown or inactive ML repository ID.
- Any duplicate side effect or feedback-version regression.
- Dead outbox rows above zero or oldest pending age above 60 seconds while ML is healthy.
- Feed p95 above 250 ms or interaction p95 above 300 ms.
- Any Qdrant, Redis, heavy-ranker, or feedback-consumer readiness failure.
- Database lock, connection, WAL, or error-rate threshold breach.

## Operational Rollback

1. Remove the release from the load balancer and roll back the complete
   backend/ML image pair to the last known-good strict V2 release.
2. Never switch traffic to V1, hybrid ranking, or the database trending
   fallback.
3. Preserve pending outbox rows; do not delete or reorder durable feedback.
4. Keep V2 database writes enabled after V2 writes have begun. Do not deploy an
   old binary that cannot read the current source of truth.
5. Use the authenticated replay endpoint after the downstream defect is
   corrected, then roll forward a fixed backend/ML release.

## Restore

Before production cutover, record the Supabase PITR restore point, create a verified logical backup, restore into a separate project, run `schema:audit`, recreate `ghsocial_backend`, `ghsocial_worker`, and `ghsocial_migrator`, rotate internal credentials, and record measured RPO/RTO.

## Current Decision

**REQUIRES CURRENT EVIDENCE.** Production approval is prohibited until the
target database, Redis, Qdrant, feedback consumer, heavy-ranker qualification,
authenticated smoke, and load gates all pass for the exact release images.

