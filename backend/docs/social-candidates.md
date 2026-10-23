# Public social candidate channels

Uses the existing ML PR #135 contract at
`c3237ba329483c8a005f8374a7d26958271839ab`, schema SHA256
`8c6956cfc921cb2997dcd965fa579b1d28c21b9fe6366f852f6cebbb36a0dd66`.
Stacks on Weave PR #199. Apply PR #200's `0034`/`0035` migration history before this
follow-up's `0036`/idx39. The exact prerequisite SQL/audit entries are retained in a
separate commit; no #57 feature source is copied. Credential-unlink0037/idx40 must
follow0036. Do not renumber applied history.

## Permission and evidence

`FEED_SOCIAL_CANDIDATES_ENABLED=false` remains the default. The authenticated
backend derives bounded canonical IDs and evidence internally; online ML never
reads product SQL. The provider separately controls shadow/enabled user cohorts.
No private actor identity, board name or membership list is sent to ML.

Sources now include verified/unclaimed followed owners, followed users' public
likes, co-like neighbors sharing the viewer's positive seeds, public-board
co-membership, and topic neighbors of the viewer's own likes/saves. Registered
user likes are already an authenticated public product surface. Raw cross-user
saves and private collections are not sharing authority and are never queried.
Unlisted boards are direct-link resources, not public discovery candidates.

Only active viewers/actors and active canonical catalogue repositories with
positive numeric owner identity and real statistics qualify. Owner identity is
never inferred from handles. Collaborative sources require at least two distinct
supporters; multiple boards from one owner count once. Adjacent support counts
own seed repositories. The shared projection deduplicates, normalizes actual
support by observed stars, and applies owner/source/overall caps. This heuristic
score is not a measured relevance probability.

Permission/evidence reads use one repeatable-read, read-only transaction with a
1,000 ms PostgreSQL statement timeout. Errors propagate for retry; no invented
candidate fallback. The timeout bounds server statements, not shared-pool queue
wait or total feed latency. Source evidence stays request-local.

## Bounded lookup and verification

Membership samples precede fanout: 20 own seeds; 50 followed/co-like actors with 20
likes each; 50 public boards with 20 items; 20 topics with 10 repositories each.
Per-seed membership scans sample 100 deterministic IDs, then recheck visibility
and active identity. Sampling may underfill; it never substitutes private rows.
Output is at most 10,000 raw rows, followed by 100 total candidates, two repositories per owner and20 entries per source
caps (provider quotas can be tighter).`0036` adds the supporting selective indexes.

Opt-in `tests/feed/socialNeighborhoodProjection.test.ts` requires an owned
loopback `/weave_social_neighborhoods_test` database and
`RUN_PUBLIC_SOCIAL_NEIGHBORHOODS_INTEGRATION=1` outside production. It exercises
actual persistence wiring, distinct support, owner/viewer state, private/unlisted
suppression, co-like/own-topic source attribution, revocation, real blocked-read
cancellation and recovery. Parent owner-source acceptance remains separately
covered by `tests/database/socialCandidates.integration.test.ts`.

A matched synthetic owned-PostgreSQL workload used 100 users/5,000 repositories/100,000 likes,
2,000 boards/100,000 memberships/15,000 topic memberships. Identical 3,280 raw rows/hash
were returned before/after indexing. Three query samples were763/379/374ms before
and94/76/76ms after; EXPLAIN execution425→94ms, shared-buffer hits68590→28561.
The owner lookup used its composite index to read two rows without sorting.
These are local query measurements, not production request latency or quality.

Exact-provider Node/Python HTTP tests validate all five source enums and source
scores through real registered routes/auth/admission; model/storage boundaries
are deterministic fixtures. Core strict-heavy, eligibility, canonical hydration,
feedback ACK and durable serving remain unchanged.

## Remaining full issue #34 acceptance

Raw followed-save/co-save channels need explicit shareable provenance or a
product policy; no sharing consent is invented. Representative relevance,
coverage, novelty and source-contribution reports remain outstanding. Generation
permission checks and structural fixtures do not prove production qualification,
quality or rollout approval. Full issue #34 stays open; no deployment or promotion
is performed. ML #24 lineage and #26 historical model/input snapshots are separate
work and are not silently claimed by these channels.
