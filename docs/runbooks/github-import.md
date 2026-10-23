# Consented public GitHub preferences

OAuth establishes verified identity. It does not collect repositories, infer
preferences or complete onboarding. New accounts explicitly finish their account
details, then choose public-activity import or the existing empty manual form.
Declining/unavailable import uses meaningful manual context with the unchanged
strict recommendation pipeline. An identity-only profile is not a prepared persona.

The onboarding and profile controls preview public owned, starred and contributed
repositories, explain partial results and show collection date/source suggestions.
Preview does not apply a preference. Acceptance keeps manual values first and adds
bounded derived values; backend profile/feed versions and onboarding outbox are
committed with consent/provenance and canonical discovery. The response says
profile delivery is pending; no vector/ranking readiness is inferred from acceptance.

Manual taxonomy uses stable IDs separately from canonical labels. One pure
contract supplies both app display and backend validation. Old skill IDs are
resolved to semantic labels in all ML onboarding jobs. Existing clients remain
compatible; forged ID/name/version combinations are rejected.

## HTTP and resource contract

All routes require the normal backend Bearer JWT. Actors and verified GitHub IDs
come from the active owner profile, never body handles/IDs.

| Route below `/api/v2/onboarding/github-import` | Behavior |
| --- | --- |
| `GET /` | Owner's linked/import status and accepted provenance; no GitHub call |
| `POST /preview` with `{"consent":true}` | Explicit permission to read public activity; returns a five-minute snapshot |
| `POST /accept` with `snapshot_id` | Owner/hash/expiry/identity checked; repeat acceptance is idempotent |
| `DELETE /` | Fences in-flight previews, expires staged material and revokes applied import |

Default collection is at most three 100-record pages per source, one eight-second
overall deadline, two MiB per provider response and four actual collections per
process. A durable per-user collection lease prevents duplicate cross-process
work. Fresh collection is limited to once per minute; fresh previews reuse their
remaining five-minute cache lifetime. Partial/truncated/unavailable sources stay
explicit, including rate-limit errors. Redirects cannot forward the service token.
Unsafe numeric identities, repeated cursors, conflicting owners and malformed
pages fail closed. A privileged credential never permits private/internal content.

Unaccepted material lives in owner-bound Redis keys with a 300-second TTL; SQL
retains only identity/hash/expiry/consent metadata until acceptance. SQL hashes
protect cached material, and revocation advances its durable revision. Accepted
provenance stores source counts, GitHub IDs and collection timestamp; full preview
material is removed from cache, with the TTL bounding any failed cleanup. Redis reads occur before product row locks and are rechecked
under those locks. Redis is not the source of committed profile truth.

Canonical discovery uses the normal sorted GitHub advisory locks and backend
UUID/outbox machinery. It creates only absent repositories. Existing rich README,
content versions and summaries survive racing discovery. Observed metadata/stats
are retained; unfetched README stays unknown. This is not a fabricated README or
a payload-only vector eligibility write. Normal later acquisition can enrich it.

Revocation restores unchanged imported fields to their pre-import values. A later
manual edit owns its entire field and is preserved. Versions advance, stale feed
namespaces stop serving, and meaningful remaining context is queued asynchronously.
If no meaningful context remains, onboarding becomes incomplete and strict feed
preparation waits for manual context. Revocation does not claim physical deletion
of an existing ML vector or completed ML delivery.

## Credential unlink and quality limits

Import revocation is distinct from disconnecting a login provider. Supabase's
supported `unlinkIdentity()` requires a live Supabase user session and at least
two linked identities. This app currently brokers backend JWT sessions and has no
owner-bound provider reauthentication/unlink flow. Clearing a product handle is
not credential unlink. That separate flow remains an explicit issue #57 acceptance
gap; no credentials/configuration were changed to hide it.
See [Supabase identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking).

The network-free comparison exporter produces onboarding-only, GitHub-only and
combined contexts using the same actual projection as acceptance. It preserves
source/consent/cutoff and a SHA256 context identity; identity-only variants remain
unprepared. Input is a private `ColdStartContextInput` (see its service type), and
the output is created with 0600 permissions without overwriting an existing file:

```sh
node --import tsx scripts/export-cold-start-contexts.ts \
  --input /private/input.json --output /private/contexts.json
```

Every export says `evaluation_ready=false`: these are inputs, not judgments or
recommendation-quality results. Reuse ML #33's benchmark at
`ae162c48face1c1d9f339ed25421460b6f031651`, with the same frozen profile IDs,
corpus/judgments/embedding identity across three actual runs and measured stage
timing. Keep variant context hashes/provenance in a companion manifest; do not add
unknown fields to its strict Run schema or invent labels/model identifiers. Genuine
judged cold-start comparison remains pending representative data and actual runs.

## Local acceptance

Only guarded disposable loopback `/weave_scroll` SQL and Redis database 15 are
allowed by these fixtures. After applying migrations through 0035 on that target:

```sh
RUN_DATABASE_INTEGRATION=1 node --import tsx --test \
  tests/database/onboardingImport.integration.test.ts \
  tests/database/repositoryDiscovery.integration.test.ts \
  tests/database/githubConsent.integration.test.ts \
  tests/database/oauthConsent.integration.test.ts
```

These exercise real SQL, Redis, registered route/auth/PKCE code and actual loopback
HTTP. GitHub/Supabase are explicit controlled provider boundaries. A SQL trigger
failure after product/outbox/discovery writes proves rollback, then safe retry;
late provider results cannot undo revoke. The OAuth regression fails against the
original callback's implicit activity request and passes after its removal.

From the app root, `RUN_GITHUB_IMPORT_BROWSER=1 node --import tsx --test
tests/github-import-browser.test.ts` exercises the actual React Native Web panel
in isolated Chromium across failure/retry, partial preview, decline, expiry,
accept/revoke and late account changes. Its HTTP API is a controlled boundary;
it does not claim physical-device or production-provider acceptance. A standalone
CI workflow enables the four real SQL/API fixtures; local results do not claim
that remote CI has executed.

Apply 0034/0035 before serving the new API. Drain old API processes that still
perform automatic OAuth extraction before exposing consent controls. Roll back
app/API together while retaining the additive schema; do not restore automatic
collection as a consent substitute. No deployed migration or release is performed
by adding these files.
