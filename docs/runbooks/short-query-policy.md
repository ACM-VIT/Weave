# Two-character search decision evidence

## Recorded product decision

On 23 October 2026 the user chose **“Keep matching names, descriptions and bios
(recommended).”** This resolves #118's short-query semantics decision. Preserve
the current two-character broad matching, exact-name/prefix ranking, semantic
eligibility, visibility rules and 300 ms typing delay. The earlier prefix-only,
minimum-three and extra-delay alternatives below were diagnostic prototypes;
none was selected or activated.

Current frontend/API trim input, and lexical SQL lowercases and escapes wildcard
characters. API/client minimum checks count UTF-16 units; the repository SQL
branch counts code points to choose its access path. Those existing behaviors
remain unchanged. No NFC/NFKC normalization, grapheme segmentation, new Unicode
length check or semantic threshold was approved or inferred from this decision.
A single `😀` and decomposed `e` + acute therefore keep their existing validation
behavior. The tool's NFC/codepoint/grapheme values are diagnostic observations.

The implementation may reduce proven unnecessary query work while preserving the
same ordered references and hydrated product counts. In particular, List ranking
needs only ID, name and searchable description; membership/nested-board counts
belong to bounded page hydration. This does not weaken broad substring recall or
remove visible product counters.

## Historical alternative comparison (not selected)

23 October 2026, Node 22.22, PostgreSQL 17.11 Alpine, shared_buffers=128MB. Synthetic
fixture: 100,008 repositories,100,008 content rows, 20,002 users, 20,000 external
profiles, 20,000 boards, 2,000 collections and 20,000 repository-topic memberships.
The measured fixture had migrations through 0037, including unrelated social
lookup indexes from 0036; the independent dev base has the identical search SQL
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
on a shared/production target. Output labels the corpus synthetic, records the selected broad policy and marks
the prefix prototype unapproved. Row digests include the returned record shape and are not directly
comparable across prototype/baseline shapes. Sentinel IDs expose specific recall
differences; they are not genuine relevance judgments.

## Same-result implementation and measurement

List candidate ranking now projects only ID, name and searchable text. The same
visibility predicates, escaped substring pattern, exact-name/similarity ordering
and100-reference cap remain. Full page hydration still reads current repository
and nested-board counts and rechecks visibility. No new index or schema change is
needed. The shared query builder changes its projection, not its predicates.

Matched before/after runs on a fresh independent-dev schema and the same synthetic
fixture above produced identical ordered reference hashes for every current-path
query/group/filter/repeat. This isolates the selected broad path from the rejected
prefix prototype. Warm medians of three samples: `go` List candidates245.12→37.86ms;
current concurrent `all`243.24→217.44ms. Selective List `zx`14.30→15.81ms did not
improve, so no universal speedup is claimed. These remain local SQL/lane timings,
not HTTP/ML/UI or production latency.

Actual server plans for the `go` List query:232.787→31.648ms,70,105→305 shared-buffer
hits, zero physical reads in both. The old plan executed collection membership
counts200 times, nested-board count scans200 times and board membership counts
8,000 times. The new ranking plan contains none of those count subplans; its broad
board candidate scan still returns8,000 rows. This is projection-work reduction,
not an invented two-character substring-index improvement.

The enabled SQL regression compares exact ordered references against a frozen
pre-change query for two/three/long/Unicode/literal-wildcard queries and both
viewers. It verifies description/bio-only recall, all groups, repository filters,
private/unlisted/inactive entities, live hydrated counts after repository state
changes, visibility changes after ranking, and unchanged two-character semantic
eligibility through the real search service with an explicit semantic double.

```sh
RUN_SHORT_QUERY_INTEGRATION=1 node --import tsx --test \
  tests/search/shortQueryLists.integration.test.ts
```

The standalone Broad short-query parity workflow enables that actual SQL fixture.
It does not run a timing threshold on noisy shared CI machines.

## Acceptance for the selected policy

Keep existing minimum, trim/lowercase/escape behavior, matching fields, exact and
similarity ranking, all groups, filters and semantic eligibility. Preserve normal
authentication, throttling, canonical identities, claimed aliases and private/
unlisted/inactive visibility. The wire contract, search snapshot binding and
120-second ranking lifetime do not change because result semantics do not change.

Verify one/two/three/long queries, Unicode and escaped wildcards, description/bio
matches, filters and all four groups. Compare exact ordered List references with
the pre-change query, then hydrate actual current counts and recheck visibility
at subsequent pages. Compare actual server plans and local timings on equivalent
fixtures without attributing unrelated prefix-prototype gains to this change.
Browser checks must retain current typing delay, cancellation, offline results,
pagination and account isolation. No production speedup or rollout is inferred.


The enabled browser regression uses actual Explore, SearchBar, React Query and
API mapping with explicit HTTP/auth/network/card presentation doubles. It checks
one-character validation, two-character broad results, the existing typing delay,
paging, offline retained results, account changes, Unicode and obsolete-response
cancellation. It does not claim physical-device or deployed-backend acceptance.

```sh
RUN_SEARCH_BROAD_BROWSER=1 node --import tsx --test tests/search-broad-browser.test.ts
```
