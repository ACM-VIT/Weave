# Social candidates: initial followed-owner slice

Pairs with Weave-ml PR #135, commit `c3237ba329483c8a005f8374a7d26958271839ab`,
schema SHA256 `8c6956cfc921cb2997dcd965fa579b1d28c21b9fe6366f852f6cebbb36a0dd66`.
This consumer stacks on PR #193's generated contract and feedback ACK integration.
It does not complete or close full ML issue 34.

`FEED_SOCIAL_CANDIDATES_ENABLED=false` is the default. When enabled, feed
generation derives evidence internally for the authenticated viewer. Public
feed input cannot supply source actors/scores. Online ML never reads product SQL.

The query reads current follows of active, verified registered GitHub users and
active, unclaimed GitHub social profiles. Repository ownership joins use positive
canonical numeric GitHub identity, never mutable handles. Only active public
catalogue repositories with an actual statistics snapshot qualify. The query
never reads private boards, saves or another account's activity.

The 50 most recently followed owners each supply at most two repositories. The
projection caps output at 100 entries, two repositories per owner and 20 entries
per source. Distinct actors provide support; actor identities stay backend-only.
Only `followed_owner` is populated by this initial adapter. Its score derives
from actual support and latest observed stars:
`support/(support+1)/sqrt(1+log1p(stars))`. This popularity control is not a measured
relevance probability. Query/projection errors fail generation and release its
lease rather than inventing evidence.

Deploy the pinned provider before enabling this flag. ML separately controls
disabled/shadow/enabled mode and stable user traffic cohorts. Begin with shadow;
genuine source-quality evidence is required before promotion. Eligibility,
canonical hydration, exclusions, feed-version fences, strict-heavy ranking and
durable serving remain enforced. The legacy `social_repo_ids` boost stays
compatible. Node validates bounded finite source scores returned by ML.

## Verification

Normal backend tests discover pure projection/generation cases under `tests/feed`.
SQL acceptance requires `RUN_SOCIAL_CANDIDATES_INTEGRATION=1`, `NODE_ENV=test` and
an owned loopback `DATABASE_URL` ending in `/weave_social_candidates_test`, with
migrated schemas. Run `node --import tsx --test tests/database/socialCandidates.integration.test.ts`.
The fixture cleans only its own IDs and checks viewer scope, verified identity,
rename, block/unfollow, unknown owner, missing stats and per-owner bounds.

`WEAVE_ML_CONTRACT_ROOT=<exact-provider-checkout>` enables the existing
`tests/contracts/mlCrossRepo.integration.test.ts` and new
`tests/contracts/socialCrossRepo.integration.test.ts`. The latter uses real
registered HTTP/auth/admission/strict DTOs, with a deterministic model boundary.
It proves the rich payload and source-score wire, not production ranking/storage.

## Remaining full issue 34 criteria

Followed-user likes/saves, co-like/co-save, board/topic and adjacent-interest
sources still need actual permission-aware adapters and support/fanout tests.
Their enum values do not implement those channels. Representative offline
relevance, coverage, novelty and source-contribution reports remain outstanding.
No production quality, rollout or private-board safety claim is made for those
unimplemented sources. No migration or model promotion is included.
