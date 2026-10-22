# PR 143: integrated validation and remaining rollout gates

Developer checks on source head `4d70762a6e96de8c313c774b29f99039d957acab`, Node 22.23.2. This report's commit adds evidence only. Earlier handoff counts describe their historical heads; this report records the current integration.

Krishang's integration companion #168 (`3d51ecc`) and current dev #162 (`ed5c05b`) are ancestors. The integration preserves public Trending caching with uncached authenticated viewer state, bounded viewer admission/deadlines, adaptive counter batches, independent five-minute outbox repair, numeric and timestamp retention witnesses, and one chronological migration journal. The canonical summary filename is 0025; its SQL hash is unchanged from the historical 0024 alias. All 32 journal entries are ordered, and fresh, skipped-hash, historical README-first and legacy upgrade paths were executed locally.

Three subsequent Greptile findings are fixed:

- Legacy membership calls without an event continue relying on their client's follow-up interaction. Only removal paths explicitly synthesize server telemetry. PostgreSQL regressions exercise save, unsave and retries alongside six final/partial membership-removal cases, including counters and ML feedback.
- Both manual and scheduled supersession require a delivered index to retire a failed index. A delivered refresh can still supersede a failed refresh. PostgreSQL tests preserve replayability and reject older or unrelated index witnesses.
- Explore/catalogue, Liked, Saved, Board and Collection cards omit raw README documents. Summary/digest provenance, viewer state and selected Lists remain. Registered authenticated HTTP routes with a million-character README assert bounded card payloads and complete explicit-detail retrieval.

The outbox runbook now distinguishes previously purged index checkpoints from dead jobs and already-accepted invalid artifacts. A real local PostgreSQL regression exercises dry-run/execute of a fresh scoped reindex campaign, idempotency, actual completion and subsequent refresh eligibility. Production recovery was not executed.

## Completed checks

Machine-readable commands, exit codes and counts: [checks.json](../../artifacts/pr-143-final/checks.json).

| Check | Result |
| --- | --- |
| Lint / frontend typecheck | Passed |
| Frontend tests | 258 passed |
| Backend build / test typecheck / suite | 264 passed, 63 opt-in skipped, zero failures |
| Explicit PostgreSQL database flows | 35 passed; separately enabled counter reconciliation 10, Trending 2, projection 1, older-schema reads 1 |
| Registered authenticated HTTP flow | Passed, including viewer-specific conditional requests and large README card/detail separation |
| README generator, migration histories, concurrent pipeline, Drizzle parity | 21 passed |
| Fresh migrations, repeated migration and schema audit | Passed; all writes confined to disposable loopback databases |
| Legacy upgrade / summary migration reapply | One passed each |
| Redis reservations / search / retention / catalogue | 2 / 4 / 2 / 1 passed |
| Current merged ML main (`1f49cdb`) compatibility suites | 233 passed; provider/encoder/lock boundaries use doubles |
| Paired ML producer / Node consumers | 69 passed, including 189 authenticated local ML HTTP responses through actual delivery; no live providers |
| Expo dependency check / iOS+Android+web export / diff whitespace | Passed |
| Expo Doctor | 20/21: existing unmaintained `react-native-render-html` warning remains; not suppressed |

Browser authentication forms were rerun at 320×568, 360×640 and 320×300; all input/actions were reachable without horizontal overflow or page errors. Intercepted local fixtures also covered profile save failure retaining the draft, Explore empty/error/retry/fallback/clear focus, and onboarding long bio/invalid username. Browser results do not simulate native keyboards or certify live authentication.

Expo Go ran on an isolated Android AVD data copy at 640×1136 pixels / 320 dpi (320×568 dp). Login email and password stayed visible above docked Gboard; the password bounds were [95,296][545,408] with keyboard top 522 pixels. Drag dismissed the keyboard and made Log In reachable. Forgot-password email also remained above docked Gboard, and its reset/back actions were reachable after drag dismissal. Screenshots are in `artifacts/pr-143-final/`. Loopback UI fixtures and synthetic input were used; no real account, successful auth or mail delivery is claimed. This does not certify standalone Android manifest resize behavior.

## Still required

The full [native and accessibility QA matrix](phase-5-usability.md#cross-feature-review-and-remaining-manual-qa-matrix) remains explicit: native iOS was unavailable (`simctl` missing); authenticated Android sheets, real save/comment persistence, gesture arbitration, native share/deep links, large text, TalkBack/VoiceOver and standalone Android resize still need device checks. Browser and source checks do not clear these rows.

These are developer execution results, not independent approval. Fresh Greptile 5/5 and independent current-head source/security review remain merge gates. The authorized rollout must pause writers, audit schema/history and execute any required scoped recovery before resuming. No production migration, deployment, PR merge or paid model call was performed in this pass. The companion is integrated into #143 without closing or merging #168.
