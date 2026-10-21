# Repository summary compatibility

The Weave backend and Weave-ml producer retain a two-or-three-complete-sentence
contract. Their identical `summary_compatibility.json` fixtures cover examples,
titles, comparisons, inline lists, initialisms, license subject matter and bounds.
Keep both fixture copies synchronized when changing this policy.

- Inline `e.g.`, `i.e.`, titles and `vs.` do not terminate sentences. `etc.` and
  dotted uppercase initialisms keep their ending before a capitalized next
  sentence; their periods are ignored before a lowercase continuation.
- ML uses the same boundaries for generated-output validation and description
  fallback extraction. Clipping must still leave two or three complete sentences.
  Previously stored malformed summaries are regenerated on duplicate/current replay.
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

Deploy the companion ML fix before retrying previously rejected summary jobs.
These changes do not automatically reset terminal outbox jobs.

The backend's optional Python-to-Node HTTP delivery regression runs with
`WEAVE_ML_ROOT` pointing to the companion ML checkout and `WEAVE_ML_PYTHON` to its
Python interpreter. It uses the real summary pipeline and Node delivery client;
the HTTP response server is a local fixture. ML tests separately exercise local
Qdrant persistence/replay with provider and encoder doubles. No paid provider or
production service is required.
