# Candidate repository lifecycle forwarding

Companion to ACM-VIT/Weave-ml#153; the ML PR contains the complete candidate
`verified-status-v1` policy and rollout/rollback decision packet. Both gates are
disabled by default. This prepares code and fixtures; it authorizes no production
policy activation, scheduler changes, corpus purge or backfill.

`RepositoryUpsert.lifecycle` accepts complete verified GitHub archive/disable
observations or unavailable attempts with explicit source and aware timestamp.
The internal ingestion route validates the object, and the existing ingestion
transaction writes the observation into the durable `repo_refresh` JSON outbox.
No new SQL migration is needed. Status-only changes are excluded from content
hashing, preserve the content version and do not enqueue another embedding job.
The existing `required_content_version` prerequisite still orders index/refresh.

Set `ML_REPOSITORY_LIFECYCLE_OBSERVATIONS=verified-status-v1` only after owner
approval and after the matching additive ML contract/CAS implementation is
running. Until then the source and feature projections omit the new field.
The ML serving gate `V2_REPOSITORY_LIFECYCLE_POLICY` remains a separate decision.
The generated schema/client pins the linked ML commit; inherited drift from the
prior snapshot was score descriptions only and is included in this regeneration.

Candidate policy: verified archived/disabled excludes new selection after the
completed ML status CAS; newer verified restoration revives; failed/partial/
unavailable observations retain last verified status indefinitely; legacy unknown
and stable low-activity repositories remain eligible. Lifecycle time is independent
of content/feature versions; a delayed archive refresh cannot be discarded merely
because unrelated counts were refreshed later. Same-content index replay also applies
a lifecycle-only CAS; backend always emits refresh for each staged observation.
Existing materialized feeds and in-flight selections are outside this boundary.

Rollback: disable ML serving policy first, then backend forwarding. Preserve
status evidence and queued jobs. Do not roll ML back to a pre-lifecycle strict
schema while lifecycle-bearing outbox jobs may still be delivered. Coordinate
queue draining/compatibility with the owner first. Reenable only after auditing
refresh coverage and stale-status expectations.

The owner must approve legacy-unknown eligibility, indefinite status retention,
GitHub refresh coverage/cadence (#85), release order and production activation.
This PR does not add a continuous status scheduler or claim those operational
requirements are met. Acquisition transports complete GitHub repository flags;
search constraints and push age never establish lifecycle state.

Focused tests cover validator rejection, gate defaults, source/refresh projection,
content-hash stability, outbox identity, real disposable PostgreSQL status-only
persistence, and Node/Python HTTP routes with actual local Qdrant lifecycle CAS
and selection. Encoder and distributed lease boundaries in the HTTP fixture are
local deterministic stand-ins; production/distributed behavior is not claimed.
