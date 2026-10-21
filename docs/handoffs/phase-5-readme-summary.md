# Phase 5 addition: versioned README digest

## Product behavior

The repository description stays the one-line subtitle. README SUMMARY uses a separate generated digest: a useful overview, concrete capabilities, practical use cases, and source-supported considerations. The revised technical-writer prompt targets 140–190 words, caps its request at 220, and keeps the independent validator at 90–260 words to avoid padding sparse sources. Overview, capabilities and use cases should complement one another. Acronyms stay as written and use cases must follow explicit examples or stated goals. The existing 360-character ML card-summary contract remains separate.

The feed preview measures its available text viewport and system font scale, reserving two text lines before a minimum 44-point Read more action. Read more opens the complete same digest in the existing scrollable popup. Repository detail's explicit View README action opens the stored full README separately. Description-fallback artifacts and copies of the subtitle are excluded from the summary section. Missing, pending and failed summaries have explicit states; Check again fetches status and does not start a paid generation request.

## Ingestion and regeneration

The old ingestion reference is `gh-social-ml/utils/openrouter_client.py:generate_readme_md`: it rewrites a large README document. Its legacy `readme_summary` was a cleaned text slice, while `structured_summary` was metadata plus an opening-purpose extract. Those legacy tables/contracts are not used for new writes.

Canonical V2 ingestion now queues a durable job in the same transaction as `app.repo_content`. Jobs are unique by repository, content version/hash and prompt version. The separate worker calls OpenRouter outside database transactions, validates a closed JSON schema, and atomically saves a versioned artifact in `app.repo_readme_summaries`. Current-source checks and claim tokens fence stale/duplicate workers; failures have bounded retries, while provider policy failures stop immediately. Regeneration uses a new generation ID and retains prior artifacts. Reads select only the active artifact matching the canonical content version and hash.

`README_SUMMARY_PROVIDER` explicitly selects `gemini`, `openrouter` (the default), or `openai-compatible`. `README_SUMMARY_API_KEY` overrides the key for that selected provider. Otherwise Gemini uses `GEMINI_API_KEY`/`GOOGLE_API_KEY`, OpenRouter uses `OPENROUTER_API_KEY`, and the compatible adapter uses `OPENAI_API_KEY`. A provider never borrows another provider's key or silently fails over. `README_SUMMARY_MODEL_ID` selects its model. Gemini defaults to `gemini-3.1-flash-lite`; OpenRouter defaults to `openai/gpt-4.1-mini`. The compatible adapter requires an explicit model and `README_SUMMARY_BASE_URL` (HTTPS API base including `/v1` where applicable). Its strict Chat Completions contract is ready for a future compatible service; the user's future GPT Luna endpoint/model/protocol are not yet verified.

The user subsequently explicitly requested direct Gemini testing with the existing Gemini key. That key successfully authenticated and generated digests using Gemini's native structured-output API. OpenRouter's policy remains unchanged; only OpenRouter requests require its ZDR routing. Direct Gemini access is the user's chosen provider for this preview. Local `.env.readme.local` contains only provider/model/pacing selection; the existing backend environment still holds the key. Model provenance includes the provider prefix. The technical-writer role and source-fidelity/clarity instructions come from the old prompt; its full-document Markdown output and legacy storage were not reused. Prompt revision `readme-digest-v3` is independent of the unchanged V2 database and `readme-digest-json-v1` artifact format. Each worker paces HTTP attempts, including validation repairs, using `README_SUMMARY_RPM_LIMIT`, otherwise Gemini uses `GEMINI_RPM_LIMIT` or 5 RPM. Keep one worker inside the real key quota. Leases last five minutes to cover pacing plus two bounded provider attempts. Daily quota exhaustion is distinguished from minute throttling, and the CLI stops on daily quota, policy, or authentication failures rather than exhausting the remaining queue. Source sampling is bounded, repository text is treated as untrusted data, and errors/logs exclude provider bodies and keys.

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
- The key cannot manage guardrails (`401 Invalid management key`), and the browser dashboard requires sign-in. The user deferred a replacement key and then explicitly authorized using the separate Gemini API key. See the subsequent Gemini acceptance result below.
- The manifest is `artifacts/phase-5-readme/live-ingestion-report.json`. Only its recorded repository IDs were retried; no additional repositories were ingested during provider testing.

The browser preview uses real authentication and the configured database through localhost:5001. Recommendation ML remains disabled because its deployment is unavailable; no ML ranking/generation endpoint was called. The normal ingestion endpoint was enabled only by using the existing backend internal secret in the local API process. README generation uses its independent provider worker, not the unavailable recommendation service.

## Verification and remaining QA

Automated regressions cover source bounds, schema/length constraints, strict provider parameters, validation repair, no retry after policy rejection, V2 payload serialization with raw/Drizzle clients, enqueue deduplication, concurrent claims, wrong-claim rejection, current-source fencing, retries, immutable regeneration, migration upgrade/history, summary/subtitle separation, complete popup content, and viewport/font-scale preview calculations. Integration tests use an isolated loopback PostgreSQL database, never destructive suites against the configured live database.

Final checks with Node 22.23.2: lint and typecheck pass; frontend 152/152 pass; backend build passes and tests report 148 passed / 11 opt-in integrations skipped; the separately enabled README suite passes 11/11 (nine generator/unit tests and two isolated PostgreSQL integration tests). Expo dependency compatibility check passes. iOS/Android/web export completes successfully. Expo Doctor reports 20/21: the pre-existing unmaintained `react-native-render-html` metadata check remains a failure, with no suppression. `git diff --check` passes.

The authenticated browser loaded LiveKit's real detail page, showed its distinct unavailable-summary state, and opened the separate stored README popup. After the authorized Gemini run, the authenticated browser displayed a real digest and opened its structured popup. Its scrollable lower sections and return to detail are checked separately below. Home remains unavailable because the recommendation service has no active personalized generation; README generation does not manufacture a recommendation feed.

| Check | Viewport/settings | Expected result | Status |
| --- | --- | --- | --- |
| iOS Expo Go | 320x568 points; default/large text | Focus/input/error/action visible; digest truncation and popup scrolling; close preserves feed position | Manual required; no local iOS simulator available |
| Android Expo Go | 320x568 dp; default/large text | Same; Back closes sheet/popup; correct keyboard resize/insets | Original Phase 5 authentication keyboard check completed; new digest interaction still required |
| Browser digest | Current in-app viewport (470x674) | Real summary distinct from subtitle; complete structured popup; lower sections scroll and Close returns to detail | Live artifact display and popup checked; smallest phone/feed preview still manual |
| Browser unavailable digest | Existing signed-in session | Subtitle remains distinct; status retry usable; original README accessible internally | Completed for LiveKit detail |
| Cross-feature interaction | Both native platforms | Reaction/Save preserve feed; swipe does not compete with paging/Tech Stack; accessible actions available | Automated coverage plus original Phase 5 audit; authenticated native recheck required |
| Ingestion acceptance | Ten manifest repositories | Ten current artifacts; inspect source-grounded quality and repeat-safe regeneration | Gemini acceptance recorded below and in the refreshed manifest |

## Gemini test follow-up

The existing Gemini key authenticated successfully. Its `gemini-2.5-flash` model generated real persisted digests. Human inspection caught invented MCP acronym expansions and overly verbose output in the first prompt revision. The next revision explicitly preserves acronyms and requires stated examples; the revised outputs remove those incorrect expansions and the LiveKit summary no longer merges separate README examples into an unsupported integration.

The 2.5 Flash free-tier daily quota was then exhausted: Google reported `GenerateRequestsPerDayPerProjectPerModel-FreeTier`, limit 20. Those requests cannot be fixed by faster retries. Other models available to the same authorized key were tested explicitly, with exact model provenance on each artifact. Gemini 3.5 Flash completed additional jobs but intermittently returned 503; Gemini 3.1 Flash-Lite successfully continued the pending work and is the local preview selection; scoped retries preserve successful artifacts. The refreshed manifest and `gemini-digests.json` record the final counts and model IDs. No additional repositories were ingested.

The backend now supports Gemini native structured output, OpenRouter strict output (with existing ZDR requirements), and an explicitly configured HTTPS Chat Completions-compatible provider. No database migration or schema alteration was needed for this provider change, and no key is committed or sent to the browser. The repository detail loading guard also waits for authentication restoration instead of briefly displaying a false load failure.

Provider-switch configuration (backend environment only):

```dotenv
README_SUMMARY_PROVIDER=gemini
README_SUMMARY_MODEL_ID=gemini-3.1-flash-lite
README_SUMMARY_RPM_LIMIT=5
# GEMINI_API_KEY is already in the existing backend environment.
```

For an approved future compatible service, set `README_SUMMARY_PROVIDER=openai-compatible`, its `README_SUMMARY_API_KEY`, exact `README_SUMMARY_MODEL_ID`, and HTTPS `README_SUMMARY_BASE_URL`. The key alone is insufficient to infer an unknown service's protocol. No frontend change or database migration is required for a compatible endpoint.

### Final acceptance result

**10/10** original sample repositories now have current active digests from prompt revision `readme-digest-v3`; LiveKit components-js has an additional current digest for the user's example. All eleven artifacts match their canonical content version/hash and pass the closed-shape and length validator. Word counts are **97–229**, with sparse source material kept short. Canonical repository count remains **1,599**. No extra ingestion was performed while testing providers. The model-overload retries eventually completed; there are no pending/failed jobs for this sample's current prompt revision.

Manual spot review compared purpose, capabilities and constraints to the stored source. Incorrect initial MCP expansions were replaced through regeneration; the inaccurate earlier REA artifact was explicitly retired, not edited into a fabricated success. A numeric spot-check flagged “over 2,700” in the skills digest: the source lists 2,724+, so the rounded statement is supported. This is source-based summary review, not an independent verification of repository authors' product/performance claims. The public artifacts and model provenance are saved in `gemini-digests.json`; no credentials are included.

Authenticated in-app browser (470x674): verified the refined LiveKit overview differs from the one-line subtitle; Read more opens the complete overview/capabilities/use-cases/considerations; lower sections scroll; Close returns focus to Read more. The full stored README remains a separate action. Screenshot: `/tmp/weave-gemini-summary-popup.png`. Smallest native viewports and populated Home card clipping remain in the manual QA matrix. The README worker's success does not repair the separate missing personalized recommendation generation.
