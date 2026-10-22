# Repository summary compatibility

The Weave backend and Weave-ml producer retain a two-or-three-complete-sentence
contract. Their identical `summary_compatibility.json` fixtures cover examples,
titles, comparisons, inline lists, initialisms, license subject matter and bounds.
Keep both fixture copies synchronized when changing this policy.

- Inline `e.g.`, `i.e.`, titles and `vs.` do not terminate sentences. `etc.` and
  dotted uppercase initialisms keep their ending before a capitalized next
  sentence; their periods are ignored before a lowercase continuation. The Latin
  abbreviation boundary is explicitly `not preceded by [A-Za-z0-9_]` in both
  languages, so adjacent non-Latin text has identical behavior. Sentence counts,
  GPL-label boundaries, and final-ending checks all use this masked text. A final
  abbreviation dot cannot complete an unfinished tail; closing quotes and
  brackets can follow a complete ending without adding another period.
- ML uses the same boundaries for generated-output validation and description
  fallback extraction. Clipping must still leave two or three complete sentences.
  Previously stored malformed summaries are revalidated and regenerated on
  duplicate/current replay even with a correct fingerprint and no provider.
  Replay checks exclusions, normalized content, sentence endings, model versions,
  and the existing generated-output length and near-copy rules against the
  canonical source. Summary-only CAS retains the content identity and embedding.
- Sentence-ending and exclusion boundaries share the same permitted closing
  quotes/brackets. A standalone GPL label following a quoted complete sentence
  is excluded in generated output and stored replay. JavaScript's ASCII
  abbreviation lookbehind stays case-sensitive, with explicit `[eE]`/`[gG]`
  alternatives: Unicode Kelvin-sign/long-s folding must not broaden `[A-Za-z]`.
  Shared fixtures cover these characters, uppercase abbreviations and ASCII
  controls without relaxing sentence counts or copy detection.
- `GPL` as project subject matter is allowed. Standalone and versioned license labels
  such as `GPL v3+` and `GPL v3 or later`, plus `licensed under` clauses, remain
  excluded; commands and section leakage stay blocked.
- Summary length is 1–360 Unicode codepoints; each highlight is 1–96 codepoints,
  with at most three highlights. Python `len(str)`, JavaScript string iteration
  and PostgreSQL `char_length` use this unit. An emoji is one codepoint, while a
  combining sequence may contain several. No grapheme or UTF-16 limit is implied.
- Copy protection is unchanged. The backend's 80-character contiguous threshold
  and ML's word/near-copy rules still differ. Unifying them requires a separate
  policy decision; this compatibility fix does not relax either protection.

## Explicit terminal-job recovery

1. Deploy compatible ML #92 first, retaining the existing migration, schema-audit,
   provider/encoder readiness, and ingestion-canary gates. Verify applied,
   duplicate and current delivery, including repair of a fingerprinted legacy
   artifact during a provider outage. Deploy compatible backend #136 afterward.
2. Inspect affected `dead` `repo_index` rows and their `last_error` read-only.
   Confirm each payload still matches the canonical repository content version
   and hash. Do not reset unrelated terminal errors or bypass copy protection.
3. For each reviewed current-content job, explicitly call the existing
   authenticated endpoint with the existing internal-secret header:
   `POST /api/internal/v2/operations/outbox/<outbox_id>/replay`.
   `202` queues that job again with reset attempts and a fresh claim; `409` means
   the row is not terminal. Deployment alone never revives terminal rows.
4. Confirm the worker delivers the repaired artifact and PostgreSQL stores the
   summary and delivery acknowledgement atomically. Check the card projection
   and operations status. Invalid artifacts must still fail validation.
5. For obsolete content, use the existing reviewed `reindex:ml --summary-backfill`
   campaign against current canonical content instead of rewriting an old job.
   Retain the dry-run and normal execution-approval gates.

These are rollout instructions; local regression tests do not execute them
against a deployed environment. Nothing here approves a merge or deployment.

The backend's optional Python-to-Node HTTP delivery regression runs with
`WEAVE_ML_ROOT` pointing to the companion ML checkout and `WEAVE_ML_PYTHON` to its
Python interpreter. It uses the real summary pipeline and Node delivery client;
the actual FastAPI authentication, contracts and summary routes with local
Qdrant applied/duplicate/current persistence and legacy-artifact repair. The
Node-side HTTP response server is a local fixture; encoder, provider and Redis
lock boundaries are doubles. ML tests also cover stored exclusions and near-copy
checks independently. No paid provider or
production service is required.

## Recovery of artifacts accepted before validation tightened

This differs from rejected-before-persistence `dead` jobs. An already-delivered
job cannot be revived by the dead-job replay endpoint, and deployment does not
repair its PostgreSQL artifact automatically. No affected production rows are
asserted here; inspect the actual database read-only first.

Migration `0027_summary_artifact_revisions` adds storage-only `artifact_revision`
and `supersedes_summary_id`; it preserves existing IDs and bodies at revision 0.
It replaces the five-column uniqueness index with uniqueness including revision.
The network V2 artifact shape, prompt/model/format provenance and content identity
stay unchanged. Pause old outbox workers and legacy-backfill commands, apply the
normal migration chain, run schema audit, and deploy/start the compatible backend
before resuming writes. Old writers using the former five-column conflict target
must not run against the revised schema. Do not reapply pre-revision SQL manually
or roll back to old writers after successors exist. No deployed migration is
performed by these instructions.

Completion validates incoming, retained and generated-preservation candidates
with the same consumer validator, using the immutable job source. A valid first
writer remains canonical even if a new response proposes different prose. If no
valid row exists for that tuple, completion adds a successor revision, recording
its predecessor, instead of rewriting/deleting historical text or summary IDs.
Repository-first locking serializes this decision with ingestion and other
completions; current-content fencing and claim-token fencing remain enforced.
Only valid same-content generated content is protected against a fallback.
Summary persistence, activation and delivery acknowledgement commit atomically.

To recover already-accepted invalid **active** artifacts:

1. Deploy compatible ML first. Under the write pause above, apply migration 0027,
   audit the schema and deploy the compatible backend.
2. Run the campaign in dry-run mode from `backend/`:
   `npm run reindex:ml -- --campaign=summary-repair-contract-v1 --repair-invalid-summaries`.
   Inspect `invalid_artifacts`, `eligible`, `invalid` and `would_queue`. Review
   repository IDs, current canonical content/hash and the active summary read-only.
   The campaign validates actual artifacts; a generated source label alone never
   exempts a malformed row. It does not select missing artifacts or valid fallbacks.
3. Repeat the dry run with one or more explicit `--repo-id=<canonical UUID>`
   arguments for the reviewed scope. With execution authorization, repeat that
   exact campaign/scope with `--execute`. Repair execution refuses an empty ID
   scope. A fresh campaign creates fresh current-content jobs even if the original
   jobs were delivered; repeating the same campaign is idempotent. Existing
   delivered jobs and active rows remain unchanged until validated completion.
4. Verify the new job's `backend_persistence.artifact_status`, `summary_id`,
   `artifact_revision` and `supersedes_summary_id`; verify the corrected artifact
   is active and the predecessor remains inactive/addressable. Historical serve
   references retain their original IDs. Another dry run should select no repaired
   rows. Inspect unsuccessful jobs explicitly instead of relabelling them success.

`--summary-backfill` also treats invalid generated artifacts as eligible, alongside
missing/current fallback artifacts. It preserves the existing broader campaign
semantics; use the narrowly scoped repair flag for already-accepted invalid rows.
Inactive historical artifacts remain preserved and are not swept by the campaign.
The tests exercise these paths on disposable loopback PostgreSQL only; they do
not establish affected deployed data, authorize rollout, or replace independent
review.
