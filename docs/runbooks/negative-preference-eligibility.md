# Current negative preferences in new feed serves

The backend's current `app.reactions` row is authoritative for explicit dislikes.
A dislike is excluded even when it falls outside the 500-ID exposure/history
window, comes from a social/discovery source, or scores highly in ML. This check
uses canonical candidate UUIDs in batches of at most150; it does not load or cap
the user's full negative set. The existing reaction primary key supports the
viewer/repository lookup. No migration, new flag or ML SQL connection is needed.

Generation filters returned IDs before queue publication. New feed requests
check queued, durable-recovery and fallback candidates before hydration/serving.
A nonempty batch filtered entirely is retryable; it cannot establish feed
exhaustion or create an empty terminal serve. Partial batches keep original
ranking and source attribution for eligible cards. A transient eligibility read
failure fails closed and releases the requesting reservation.

`createServe` rechecks all candidates inside its transaction. It follows the
existing activity/profile order: user KEY SHARE, feed-state initialization and
feed-state FOR UPDATE, then current preferences and feed-item insertion. Activity
already takes the feed-state lock before engagement/reaction locks. A committed
dislike winning this serialization rejects a new serve and rolls its header back;
the service maps that race to its existing retryable in-progress response. A serve
committed first remains historical truth. This is separate from same-session
duplicate-delivery fencing owned by PR195.

Existing same-request serve replay runs before current-negative filtering. A
concurrent same-request insert conflict also reads its original durable serve
before rejecting current preferences. Disliking a previously served card must
never rewrite that serve or strand an immutable event retry. Existing inverse
transitions remain authoritative: `undislike` clears only a current dislike;
`unlike` does not clear it. This patch does not change feedback fingerprints,
contribution ledgers, vector normalization or impression semantics.

## Verification and cost

Focused tests exercise generation, all three serving sources, all-filtered
retry, same-request replay, and a final preference race. An opt-in disposable
PostgreSQL fixture (`RUN_NEGATIVE_PREFERENCE_INTEGRATION=1`) proves the501-dislike
case, account isolation, inverse state, active-account/repository checks, actual
activity-versus-serve blocking/settlement, duplicate events and historical replay.
It requires a loopback `weave_negative_preferences_test` database outside
production; it never selects the developer's shared database.

Existing real serve-persistence tests retain one batched item insertion and no
post-creation hydration. They now verify the additional fixed preference-lock
work: four bounded statements, with an upper bound of nine total statements.
A local PostgreSQL16 fixture observed eight statements for1,24 and50 cards
(39/36/23ms respectively). These are single diagnostic observations, not a
before/after performance comparison or production latency claim. The added
per-viewer feed lock can wait behind activity; it deliberately provides the
current-negative ordering guarantee. Database operation/lock budgets remain an
operational concern, and no timeout configuration changes here.

## Remaining ML35 acceptance

This implements the explicit-negative exclusion criterion only. Full issue35
remains open for a versioned long-term/session representation, decay/reset,
deterministic event rebuild, bounded influence and genuine offline comparison.
Do not activate session intent while feed queues/generation identities are shared
only by user/feed version. Preserve raw inverse events and old replay identities.
Impressions remain offline telemetry, not online preference-vector updates. No
new model, session blend, corpus rewrite or rollout has been performed.
