# PR #143 merge reconciliation

Merged `upstream/dev` at `b1b139c` into `fix/product-fixes-v2`, preserving the existing Phase 5 product behavior. The root checkout and separate ML repository were not changed.

## Preserved behavior

- Search uses dev's shared Redis snapshots, first-page coalescing, viewer binding, request/creation limits, lease release and cancellation. Cached rankings rehydrate database rows on every request, preserving current visibility and README artifacts.
- Search/Trending retain the shared V2 repository model, version-matched card summaries, distinct structured README digests, actual counts and internal navigation. Trending retains dev's strict rank/period validation and consistent available snapshot selection.
- Explore retains focus-aware keyboard avoidance, drag dismissal and 48px search targets, together with dev's stable search sessions, offline cached results, expired-cursor restart and IME clearing behavior.
- The full repository-detail screen, multi-list Save, share actions, structured README popup, selectable full README and explicit GitHub CTA remain. GitHub-open events are enqueued only after the external open succeeds; delivery failure does not undo an open.
- Authentication starts anonymous and restores actual sessions. No preview user/bypass is restored. Dev's query cancellation/cache clearing runs at session changes, login, logout and expiry; private board/collection/pinned cache keys include the viewer. Existing cache-isolation and late-response regressions pass.
- Dev's vendored braces/URI-decoding patches and dependency security overrides remain. Expo's installer aligned the four newly reported SDK 56 patch mismatches (Expo 56.0.24, Linking 56.0.19, Router 56.2.22, Splash Screen 56.0.16). This does not claim all npm audit findings are fixed.
- DESIGN.md retains dev's runtime theme ownership and adds the existing Phase 5 keyboard, README and Home behavior guidance. No Jira integration or external documentation was changed.

## Migration identities

Drizzle records SQL hashes and timestamps, not just numeric filename prefixes. Dev's `0024_explore_search.sql` and this branch's `0025_explore_search.sql` were byte-identical. Keep the canonical dev file/journal entry and remove the duplicate SQL/rollback files. Previously recorded search hashes remain recognized; no deployed SQL contents or existing timestamps were rewritten.

Keep `0024_repository_summary_artifacts` and `0026_readme_summary_pipeline` with their original SQL hashes/timestamps. The full tags distinguish the two `0024` entries. The existing retroactive reconciliation explicitly applies missing summary/search SQL when a newer recorded timestamp would otherwise skip it. Isolated PostgreSQL regressions cover both README-first and search-first histories, repeat runs and duplicate-hash protection.

A read-only check of the connected database found the summary migrations recorded and search not recorded. No migrations, ingestion jobs or ML calls were run against that database during this merge. All migration/search integration mutations used disposable loopback databases.

## Validation

Node 22.23.2. Lint and frontend typecheck pass. Frontend: 179/179 tests. Backend build and test typecheck pass; backend tests: 150 passed, 15 opt-in skipped. Explicit isolated integrations: search/Redis/HTTP 4 passed; migration-history orders 2 passed; README generator/pipeline 10 passed; canonical catalogue 1 passed; full authenticated V2 HTTP flow 1 passed. The HTTP fixtures now use a supported Trending period, complete the required profile, explicitly seed test-only recommendations, and assert 503 when those recommendations are absent. The search integration additionally checks distinct summary/digest hydration and current README artifacts across shared cached Redis rankings.

Expo dependency check passes; Expo Doctor 20/21 retains the existing react-native-render-html maintenance warning. iOS/Android/web export passes (CLI reports successful export before its lingering-process shutdown message). Diff whitespace check passes.

After restarting the local API and Expo preview, browser checks at 470×674 confirmed real Home data, internal repository-detail routing, structured README popup contents, dismissal/focus restoration and return to the same Home card. Screenshot: `artifacts/pr-143-merge/readme-popup.png`. The local API remains ML-disabled, with healthy PostgreSQL/Redis and no running workers. Earlier screenshots remain evidence of the original Phase 5 run, not a claim of fresh native testing after this merge. iOS keyboard and the full authenticated native interaction matrix remain manual requirements.

## Review findings outside merge conflicts

The existing review of the prior head raises additional issues in Save backward compatibility, outbox retention, generation lock ownership, follow/save pagination, README retry/cache/rendering behavior, API default ports and the schema audit manifest. These are not claimed fixed by this merge. The offline-cache and expired-search findings are addressed by retaining dev's search fixes; the outdated HTTP fixture is corrected and its full flow passes.

The separate #136 compatibility review remains outstanding, including prose validation, Unicode summary length and producer/consumer sentence semantics. No #136 branch or ML-service code was silently merged. Conflict-free does not mean approved to merge or deploy. The PR is kept Draft.
