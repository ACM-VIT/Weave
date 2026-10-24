# Repository labels

Feed repositories expose optional `repository.label`; Trending cards expose `label` on each card. Missing/null means use the current recommendation explanation. Display one badge, never “No relation to your interests.” The payload has stable kinds and factual evidence; client registries own icons, copy and colors.

`contracts/repositoryLabel.ts` defines the additive union. The ordered rule registry and tunable launch defaults live in `services/repositoryLabelService.ts`:

1. `trending`: #1–10 on an active, complete global daily `github-trending` snapshot computed less than 36 hours ago. Uses snapshot position, never feed position. Payload includes rank, period/source, observed_at and expires_at.
2. `recent_likes`: top 10 repositories across the entire active corpus with at least 20 current likes acquired within rolling 168 hours. Copy: “Most liked · 7d”, not a calendar-week claim. Count current `app.reactions` from active users with server-written updated_at in the window; unlike deletes, dislike excludes, repeated like does not refresh time, re-like counts once at its new time. Deterministic ties sort by repo UUID. Payload includes count, rank, window_hours=168 and evidence timestamps.
3. `popular`: most recent GitHub stat snapshot reports at least 1,000 stars, observed less than 7 days ago. Payload includes star_count and evidence timestamps.

All timestamps must be valid and not in the future. Expiry is exclusive. Missing evidence falls through to the next rule; an unknown retrieval source cannot create a factual label. Thresholds are product defaults, not measured launch traffic guarantees.

`adapters/postgresRepositoryLabels.ts` batches rank/stars for up to 100 page IDs and computes community top ten over the full corpus before page matching. Its global ranking cache is public and per API process, coalesced for 60 seconds; it holds no viewer state. There are at most three physical batch loads and one coalesced ranking query per service, even after their callers time out. Each SQL transaction sets a local 100ms statement timeout; the optional enrichment observer returns empty after 150ms, including time waiting for a pool connection. Physical admission remains held until queries really finish, so a stalled pool cannot create an unbounded enrichment queue. Failed global aggregates back off for five seconds.

These are transient response decorations. They refresh on same-request replay, as current repository counters do; durable serve IDs, item order, sources, scores, generation/exposure provenance and queue reservations remain unchanged. Decoration copies the returned repositories. Trending enrichment happens outside the public snapshot cache and before the final private ETag is computed. It skips labels when less than 200ms remain in the main request budget. Label failures preserve a valid feed response.

The client must suppress expired/unknown/malformed labels and retain the current explanation. Add a new label by extending the public union, supplying proven evidence in the batch source, and adding one ordered backend rule and frontend presentation registry entry. No repo label column or ML-ranking change is needed.

## Adding another label

- Extend `backend/contracts/repositoryLabel.ts` and the client wire union/validator in `src/models/repository-label.ts` with its evidence fields.
- Load any new evidence in `backend/adapters/postgresRepositoryLabels.ts`; add its eligibility function at the intended priority in `REPOSITORY_LABEL_RULES`. Keep tunable thresholds in `REPOSITORY_LABEL_POLICY`.
- Add copy, icon and accessible explanation to `src/components/home/repository-label-presentation.ts`, including its typed dispatcher. Reuse a tone from `REFERENCE_THEME.repositoryLabel` or define the new semantic tone there.
- The shared `RecommendationReason` component handles badge spacing, wrapping and expiry for every kind; individual screens need no new conditionals.
- Extend the existing selector, API-mapping and renderer tests for the new kind, its boundaries and fallback behavior.

If the corpus-wide aggregation exceeds its 100ms query budget at scale, measure its plan, add an owner-managed partial recent-like index if warranted, or publish a shared precomputed aggregate. Do not switch to page-local ranking or raw click counts. The current implementation omits unavailable community badges rather than inventing popularity.

Validation: selector/service tests exercise priority, boundary conditions, future/stale dates, cache refresh, coalescing and timeout admission. Feed/trending tests cover durable replay, response copies, optional failures and deadline headroom. The opt-in database fixture tests actual SQL against the guarded disposable loopback `weave_scroll` database.
