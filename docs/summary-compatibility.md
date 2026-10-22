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
