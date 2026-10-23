# Two-character search decision evidence

Issue #118 explicitly requires a human decision. This document proposes a policy;
it does not approve or activate one. Production validation, search SQL, semantic
eligibility, authorization and throttling remain unchanged by this evidence tool.

## Concrete choice

Recommended candidate: retain two-character input, but use exact/name-prefix
matches at length two. Repositories match `name` or `owner/name`; people match
username, full name, verified handle and social-profile aliases; Lists match names
within the existing owner/public visibility rules. Description/bio substring and
semantic repository retrieval begin at three characters. Show “Name matches.
Type 3 characters for broader search.” for the short-query response.

This deliberately removes internal-substring, description-only and bio-only
matches at length two. It must not be described as equivalent recall. A delayed
substring query preserves that recall but still performs the same broad work
when it runs; debounce only reduces how often intermediate input triggers it.
Raising the minimum to three avoids all two-character retrieval, including useful
two-character names and CJK input. That is the simplest alternative if those
queries need not work.

| Decision option | Two-character results | Expensive retrieval | Main tradeoff |
| --- | --- | --- | --- |
| Proposed exact/name-prefix | Names/handles only, existing visibility | At three or more | Loses internal substring and description/bio recall |
| Keep substring after a longer delay | Current substring fields | Still executes at two | Preserves recall, does not bound each query's scan |
| Minimum three | Validation message, no results | At three or more | Loses all two-character search |

Length also needs an explicit definition. Verified current paths:
`src/app/(tabs)/explore.tsx` and `src/api/search-query.ts` trim input for search
and cache/session identity; `parseSearchRequest` trims again. Lexical matching
lowercases and escapes SQL wildcard characters. These paths do not currently
perform NFC/NFKC Unicode normalization. API/client length checks use UTF-16 units;
repository SQL branch selection uses Unicode code points.

`😀` currently passes the two-unit minimum despite being one code point/grapheme.
Decomposed `e` + combining acute passes as two units/two code points/one grapheme.
The proposed counting change is **Unicode code points after the same existing
trim**, consistently on API and client. It preserves two-codepoint `数据`, `éé`
and decomposed `e` + acute, but rejects a single emoji. Code points are not
user-perceived graphemes: joined emoji sequences can contain several code points.
No new normalization or accent stripping is bundled with the prefix proposal.

**Separate optional decision:** NFC would reduce decomposed `e` + acute to one
code point and make canonically equivalent spellings share a representation.
That changes existing matching/cache behavior and would require its own explicit
approval and compatibility tests. The tool reports NFC/grapheme diagnostics only;
it does not apply them to measured queries or select a production policy. If the
product instead means graphemes, verify matching segmenter behavior on supported
native runtimes before adopting it. SQL case/collation behavior remains separate;
this fixture uses en_US.utf8.

## Executed local comparison

23 October2026, Node22.22, PostgreSQL17.11 Alpine, shared_buffers128MB. Synthetic
fixture:100,008 repositories,100,008 content rows,20,002 users,20,000 external
profiles,20,000 boards,2,000 collections and20,000 repository-topic memberships.
The measured fixture had migrations through0037, including unrelated social
lookup indexes from0036; the independent dev base has the identical search SQL
source and lane, but reproducing on another schema/index set can change plans.
The data intentionally contains common internal `go` substrings, selective `zx`
names/bios, private/unlisted/owner/public Lists and isolated Unicode recall cases.
It is not a production corpus or a relevance-judgment dataset.

The baseline invokes the actual `PostgresSearchPersistence` and bounded search
SQL lane. Repository source SHA256:
`17bb023afd40ac689d95f89adcd2218f5fe15ac619bad4739db1689302540f92`.
The prefix prototype also uses that lane, but lives only in this CLI. It creates
fixture-only prefix indexes and deliberately changes matching/ranking projections.
Baseline runs before those indexes. Automatic server EXPLAIN ANALYZE/BUFFERS is
enabled for both, with per-node timing disabled. Each measurement is the first
call plus three warm calls; the table reports the median of those three warm
calls, not a p95 or statistical guarantee. The fixture is already cached from
seeding/earlier work, so “first call” does not mean cold storage.

| Query/group | Current warm median ms | Prefix warm median ms | Result consequence |
| --- | ---: | ---: | --- |
| `go`, repositories |215.38|19.08|Both hit100-result cap; equal counts do not prove equal recall |
| `go`, repositories with language/topic |218.52|67.16|Both hit100; filter SQL remains real work |
| `zx`, repositories |130.44|11.78|Both return100 in this fixture |
| `数据`, repositories |124.70|5.35|Two matches become one; description-only repository disappears |
| `éé`, repositories |126.70|8.35|One name-prefix match remains |
| `go`, people |199.27|59.28|Both hit100; candidate eligibility/ranking changes |
| `zx`, people |47.59|24.45|Twenty bio-only matches become zero |
| `go`, Lists |216.90|16.88|Both hit100; prototype also omits unnecessary ranking-stage count projections |
| `zx`, Lists |14.32|6.92|Zero results in both |

Current `all` executes repository/people/List branches concurrently: `go` warm
median244.59ms, returning100 references per group before public-page assembly.
The tool measures prototype groups separately; it does not claim a measured
prototype `all`/HTTP/ML end-to-end latency. Semantic retrieval, hydration, network,
UI, production contention and quality are outside these numbers. Faster prototype
results combine narrower recall, different ranking projection and extra indexes;
the comparison does not isolate an index-only causal speedup.

Server plans confirm actual broad work. An observed current `go` repository plan
scans both100,008-row content and active repository inputs (parallel node rows
must be multiplied by loops); the representative root records3,511 shared hits
and zero physical reads. Current people `go` scans both user/profile sources.
The current List plan additionally executes a board-count subplan200 times,
scanning20,000 boards each time, and records70,105 shared hits. The prototype List
query avoids those count projections and records912 hits. That is a separate
projection-cost observation, not proof that a short-query policy alone fixes it.
No production adapter or another owner's search work is changed here.

## Reproduce safely

Use a new owned PostgreSQL database named exactly
`weave_short_query_policy_test` on loopback. Apply existing migrations using an
explicit DATABASE_URL and disposable auth stub. The CLI refuses other database
names/hosts and production NODE_ENV. `--seed` refuses nonempty product schemas;
it never truncates existing data. Its fixed fixture/index changes are allowed
only on that dedicated target. No Redis, ML, GitHub or production access occurs.

```sh
# DATABASE_URL must explicitly select the owned loopback fixture above.
BOOTSTRAP_SUPABASE_AUTH_STUB=1 npm run migrate
node --import tsx scripts/short-query-policy-evidence.ts --seed --measure
node --import tsx --test tests/search/shortQueryPolicyEvidence.test.ts
```

For actual plans start the disposable PostgreSQL process with
`session_preload_libraries=auto_explain`, `auto_explain.log_min_duration=0`,
`auto_explain.log_analyze=on`, `auto_explain.log_buffers=on`,
`auto_explain.log_format=json`, `auto_explain.log_nested_statements=on` and
`auto_explain.log_timing=off`. Capture only this
owned container's logs. SQL plans can contain fixture values; do not enable this
on a shared/production target. Output labels the corpus synthetic and the policy
unapproved. Row digests include the returned record shape and are not directly
comparable across prototype/baseline shapes. Sentinel IDs expose specific recall
differences; they are not genuine relevance judgments.

## Implementation acceptance after the decision

Record the chosen minimum, counting after existing trim (and any separately approved normalization), two-character fields,
semantic eligibility and UI wording. Apply the same policy to all groups and
filters. Preserve current authentication, request throttling, canonical identities,
claimed-alias mapping, private/unlisted visibility and parameter escaping.

Preserve the wire contract or explicitly version any changed response metadata.
An additive server policy identifier would let upgraded clients label results
honestly during mixed-version rollout. Old clients must receive an actionable
validation response if the minimum changes. Include the approved policy version
in search snapshot binding/namespace so an old120-second ranking is not silently
reused under new semantics; expired cursors should follow the existing restart
flow. An extra delay must remain cancellable and must not occupy admission while
waiting. Changing semantic eligibility changes when the existing ML API is called,
not the canonical-ID ML request/response ownership boundary.

Then test one/two/three/long queries, all four groups, filters, Unicode and escaped
wildcards, alias-only matches, private/inactive entities, cancellation, expired
cursors, offline retained results and account changes. Repeat actual plans/timings
on the approved path and verify its agreed recall examples. No issue completion,
production latency target, deployment or approval is inferred from this toolkit.
