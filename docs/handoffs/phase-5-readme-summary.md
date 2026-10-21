# Phase 5 addition: versioned README digest

## Product behavior

The repository description stays the one-line subtitle. README SUMMARY uses a separate generated digest: a useful overview, concrete capabilities, practical use cases, and source-supported considerations. Generation targets 120–220 words, with validation accepting 90–260 words to avoid padding sparse sources. The existing 360-character ML card-summary contract remains separate.

The feed preview measures its available text viewport and system font scale, reserving two text lines before a minimum 44-point Read more action. Read more opens the complete same digest in the existing scrollable popup. Repository detail's explicit View README action opens the stored full README separately. Description-fallback artifacts and copies of the subtitle are excluded from the summary section. Missing, pending and failed summaries have explicit states; Check again fetches status and does not start a paid generation request.

## Ingestion and regeneration

The old ingestion reference is `gh-social-ml/utils/openrouter_client.py:generate_readme_md`: it rewrites a large README document. Its legacy `readme_summary` was a cleaned text slice, while `structured_summary` was metadata plus an opening-purpose extract. Those legacy tables/contracts are not used for new writes.

Canonical V2 ingestion now queues a durable job in the same transaction as `app.repo_content`. Jobs are unique by repository, content version/hash and prompt version. The separate worker calls OpenRouter outside database transactions, validates a closed JSON schema, and atomically saves a versioned artifact in `app.repo_readme_summaries`. Current-source checks and claim tokens fence stale/duplicate workers; failures have bounded retries, while provider policy failures stop immediately. Regeneration uses a new generation ID and retains prior artifacts. Reads select only the active artifact matching the canonical content version and hash.

`README_SUMMARY_API_KEY` falls back to the backend-only `OPENROUTER_API_KEY`. `README_SUMMARY_MODEL_ID` selects the model; `OPENROUTER_MODEL_ID` is a secondary fallback. The selected default is `openai/gpt-4.1-mini`. Requests require structured-output support and zero data retention. Provider policy is never weakened and no direct-provider bypass is used. Source sampling is bounded, repository text is treated as untrusted data, and errors/logs exclude provider bodies and keys.

Commands from `backend/`:

- `npm run worker:readme` starts the independently managed compiled worker.
- `npm run readme:regenerate -- --once --limit=10 --regenerate --repo-id=<canonical UUID>` regenerates explicitly scoped repositories; repeat the ID argument for more repositories.
- `npx tsx scripts/ingest-readme-sample.ts --execute --count=10 --github-cli --report=<path>` ingests ten previously unknown public GitHub repositories through the normal local V2 endpoint and processes their jobs. Without `--execute`, it is read-only. Do not rerun ingestion just to retry summaries; use the recorded IDs with scoped regeneration.

Deployment must apply migration 0026 and start the dedicated worker. No application deployment, worker service installation, push, or Phase 6 work was performed in this task.

## Authorized live acceptance run, 2026-10-21

Initial inspection found 1,589 canonical repositories, 1,585 with README content, zero `app.repo_card_summaries`, and zero legacy `public.repo` rows. After the user explicitly requested the missing pipeline and ten real ingestions:

- Applied only migrations 0024 (artifact metadata) and 0026 (README digest/jobs) using the scoped migrator. No unrelated search migration was applied. This is a real schema mutation to the configured database.
- Ingested ten new public repositories with their actual README, languages, topics and GitHub metadata. Canonical count increased from **1,589 to 1,599**. No fake repository, like count, account or authentication bypass was introduced.
- All ten digest generation attempts failed at the OpenRouter policy boundary. The configured Gemini Flash Lite model violates the key's ZDR guardrail; the selected GPT-4.1 mini is blocked by the model allowlist. **Zero current digests were persisted.** A separate LiveKit components-js generation attempt was also blocked.
- The key cannot manage guardrails (`401 Invalid management key`), and the browser dashboard requires sign-in. The user has been asked to allow the selected model while retaining ZDR. No claim is made that live generation or summary quality passed.
- The manifest is `artifacts/phase-5-readme/live-ingestion-report.json`. Retry only its repository IDs after account configuration is corrected.

The browser preview uses real authentication and the configured database through localhost:5001. Recommendation ML remains disabled because its deployment is unavailable; no ML ranking/generation endpoint was called. The normal ingestion endpoint was enabled only by using the existing backend internal secret in the local API process. README generation uses its independent provider worker, not the unavailable recommendation service.

## Verification and remaining QA

Automated regressions cover source bounds, schema/length constraints, strict provider parameters, validation repair, no retry after policy rejection, V2 payload serialization with raw/Drizzle clients, enqueue deduplication, concurrent claims, wrong-claim rejection, current-source fencing, retries, immutable regeneration, migration upgrade/history, summary/subtitle separation, complete popup content, and viewport/font-scale preview calculations. Integration tests use an isolated loopback PostgreSQL database, never destructive suites against the configured live database.

Final checks with Node 22.23.2: lint and typecheck pass; frontend 152/152 pass; backend build passes and tests report 143 passed / 11 opt-in integrations skipped; the separately enabled isolated README integration suite passes 6/6. Expo dependency compatibility check passes. iOS/Android/web export completes successfully. Expo Doctor reports 20/21: the pre-existing unmaintained `react-native-render-html` metadata check remains a failure, with no suppression. `git diff --check` passes.

The authenticated browser loaded LiveKit's real detail page, showed its distinct unavailable-summary state, and opened the separate stored README popup. No positive live digest preview/popup or digest quality is claimed verified while provider generation is blocked.

| Check | Viewport/settings | Expected result | Status |
| --- | --- | --- | --- |
| iOS Expo Go | 320x568 points; default/large text | Focus/input/error/action visible; digest truncation and popup scrolling; close preserves feed position | Manual required; no local iOS simulator available |
| Android Expo Go | 320x568 dp; default/large text | Same; Back closes sheet/popup; correct keyboard resize/insets | Original Phase 5 authentication keyboard check completed; new digest interaction still required |
| Browser digest | 320x568, 360x640 and tall phone | Height-based preview; two lines reserved; same complete digest in popup | Requires successful live artifact |
| Browser unavailable digest | Existing signed-in session | Subtitle remains distinct; status retry usable; original README accessible internally | Completed for LiveKit detail |
| Cross-feature interaction | Both native platforms | Reaction/Save preserve feed; swipe does not compete with paging/Tech Stack; accessible actions available | Automated coverage plus original Phase 5 audit; authenticated native recheck required |
| Ingestion acceptance | Ten manifest repositories | Ten current artifacts; inspect source-grounded quality and repeat-safe regeneration | Ten ingestions complete; generation blocked by provider allowlist/ZDR policy |
