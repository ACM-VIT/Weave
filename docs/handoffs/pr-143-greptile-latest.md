# PR 143: seven review findings

Personalized continuation recovery now rejects a catalogue page before changing loaded history. A real first-page refresh may still change modes, including multi-page query replacements. The README popup uses the complete validated summary rather than the shortened card preview; a 360-codepoint emoji regression covers the boundary.

Trending no longer selects full README Markdown. Public card metadata and summary provenance remain available, while repository detail fetches the document on demand. A PostgreSQL fixture with million-character READMEs verifies bounded card responses. Viewer reactions and List state remain outside the shared public cache.

The existing share sheet scrolls vertically. Its successful GitHub-open callback is distinct from sharing, and both Home and repository detail use their existing viewer-bound activity paths. Failed and pending external opens do not record success.

Final Board removal, Board deletion and List deletion now record the membership transition in the same transaction as saved-state changes. Server-origin events have no feed-serve attribution. They use the existing membership-managed marker so processing telemetry cannot mutate saved state or invalidate the feed twice. Retried/no-op removals and partial membership removal emit no additional event. Six PostgreSQL regressions assert counters, feedback jobs, feed versions and exactly-once history.

Drizzle now declares both README tables with their generation keys, constraints, foreign keys and partial indexes. The original migration SQL and its hash are unchanged. A PostgreSQL metadata check verifies the declarations against the migrated storage.

## Verification

- Lint/typecheck and 258 frontend tests passed.
- Backend build/test typecheck and 260 tests passed; 52 opt-in tests skipped.
- Separately enabled PostgreSQL removal/schema checks: 8 passed; Trending checks: 2 passed.
- Authenticated HTTP flow passed, including distinct summary/README data, viewer-specific state and conditional-response isolation.
- Expo dependency check and all-platform export passed. Doctor reports the existing unmaintained `react-native-render-html` dependency (20/21).
- Strict frontend project audit: zero findings.
- Chrome browser checks: 320x300 and 320x568, reduced motion, local intercepted API fixtures, no live writes. Both confirm the GitHub action is reachable. Screenshots and measured scroll/bounds are in `artifacts/pr-143-review/`.

Native iOS/Android share-sheet and keyboard checks were not rerun in this review pass. The existing manual QA matrix still applies. No production migration, merge or deployment was performed. A fresh independent review is required on the pushed head.

The final dev integration retains #161’s per-request fallback hydration reuse alongside successful-empty-generation and personalized-recovery guards. A regression verifies the fallback projects cards once for the requesting viewer.
