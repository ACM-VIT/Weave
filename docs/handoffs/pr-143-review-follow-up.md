# PR #143 review follow-up, 22 October 2026

Development scope: the user requested remediation of Krishang's remaining review findings and merge conflicts on the existing PR. This pass merges dev `77a3f07` into `fix/product-fixes-v2` (previous head `b7e1056`), with paired ML #92 at `e3878ac`. It supplies developer validation, without independent approval, merge or deployment.

## Resolved findings and reconciliation

- Detail share/GitHub-open and Home outbox flushes capture the session generation before asynchronous storage work. The production outbox binds both viewer/token owner and generation, checking after loading, durable writes and immediately before dispatch. An account switch preserves the original viewer's pending events. Regression tests execute the actual helper, factory, durable queue, batch sender and API client with synthetic tokens and intercepted I/O; they cover switching accounts during enqueue and same-owner session replacement during loading, then successful delivery after returning to the original owner.
- The backend now uses the same explicit ASCII abbreviation boundaries as ML #92, including mixed-script adjacency, quoted endings, GPL subject matter and unfinished abbreviation tails. Both repositories share identical compatibility fixtures. ML revalidates stored artifacts on duplicate/current replay, and the new fallback safety check prevents metadata such as `license-checker` or `reference` from generating artifacts rejected by its own replay validator.
- PostgreSQL's column/table alias ambiguity in `to_jsonb(summary)` suppressed real card summaries. Explicit row references (`summary.*`) preserve current summary IDs, source and version metadata in feed hydration. The database regression verifies those fields and historical serve identity.
- Dev's incremental outbox storage, pagination controller, cancellation/session restoration, recommendation circuit, batched interaction persistence, reconciliation and indexed search remain. Phase 5 keyboard behavior, canonical V2 projections, distinct README digests, internal details, multi-List saves and real catalogue recovery remain. Raw interaction save/unsave events reconcile actual List membership rather than erasing authoritative saves.
- The three previous source fixes remain: save-state-only viewer-feed invalidation, complete scoped-migration prerequisite hashes, and repaired persona generation IDs in completion/status records. They are covered by the executed suites below.

## Executed validation

Node 22.23.2; PostgreSQL 17 and Redis on disposable loopback instances. No configured production database, ML service or paid model was used in this pass.

| Check | Result |
| --- | --- |
| Frontend lint / typecheck | Pass |
| Frontend tests | 250 passed |
| Backend build / test typecheck / standard tests | Pass; 225 passed, 34 opt-in skipped |
| Python summary, card-summary and V2 contract suites | 187 passed |
| Node ML client with companion Python enabled | 54 passed; 119 authenticated FastAPI/Qdrant responses validated through Node delivery |
| Batched activity + feed persistence, real PostgreSQL | 14 passed; concurrent counters, exclusions, summary provenance and serve replay |
| PostgreSQL search + shared Redis privacy/rate limits + authenticated ML timeout fallback | 4 passed |
| Registered V2 HTTP flow, real PostgreSQL/Redis/JWT middleware | 1 passed; details, Lists, comments, follows, outbox, cursor errors and feed |
| V2 database/outbox/Redis flow | 1 passed |
| Redis restart recovery and generation fencing | 2 passed |
| Repository summary atomic completion / terminal replay | 1 passed |
| Retention integration | 1 passed |
| README generation + migration histories | 4 passed; README-first, search-first, incomplete baseline refuses without journal advancement, normal recovery |
| Legacy parent-journal upgrade / partial summary migration reapply | 1 + 1 passed |
| Expo dependency compatibility | Pass |
| iOS / Android / web export | Pass |
| Expo doctor | 20/21; existing unmaintained `react-native-render-html` warning remains unsuppressed |
| Diff whitespace / conflict markers | Pass |

Cross-language tests use actual FastAPI authentication/contracts/routes, summary processing and local Qdrant applied/duplicate/current persistence and malformed-artifact repair. Provider, encoder and Redis-lock boundaries are doubles; Node's upstream HTTP response server is a local fixture. The V2 HTTP suite uses real application JWT middleware with a synthetic signed test token and non-routable Supabase settings; it does not certify live Supabase login. No server-side acceptance exploit is claimed for the account-switch regression.

## Remaining review and rollout boundaries

Obtain independent review on these new heads; prior approvals and Greptile scores describe their original heads. Keep ML-first compatibility rollout and explicitly replay reviewed terminal jobs through the authenticated operations endpoint: deployment alone cannot revive them. See [summary compatibility and recovery](../summary-compatibility.md). No production migration or recovery was executed.

No fresh browser or native-device run is claimed in this review pass. The existing [Phase 5 QA matrix](phase-5-usability.md) and [README QA matrix](phase-5-readme-summary.md) retain their original device/head limits; smallest-screen iOS/Android authenticated keyboard, gesture, focus and share rechecks remain manual. The earlier review's other security/operational gates require the independent reviewer; these developer results do not approve merge or deployment.
