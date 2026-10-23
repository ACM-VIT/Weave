# Durable activity recovery

The client persists each immutable event before delivery. UUID, timestamp and
original serve/position attribution survive retries; only acknowledged IDs are
removed. Storage is scoped to the viewer. Account/session generation checks
remain authoritative even for lifecycle cleanup, so an old account's pending
records cannot be sent with a new account's token.

Home wakes the existing single-flight outbox on mount, foreground/background,
network restoration and orderly unmount, while retaining the eight-second retry
poll. NetInfo uses the installed Expo SDK 56-compatible package; no SSID/location
permission or background-execution entitlement is added. Wake signals respect
backoff. Background/unmount delivery is best effort; durability comes from the
record already written, not a promise that the OS will keep the process running.

The active V3 store commits one event file at a time through a validated temporary
record and rename. Recovery reads the committed or complete temporary record.
Acknowledgement removes the temporary copy before the main record. Corrupt data
is preserved or blocks recovery; it is not silently replaced by an empty queue.
Existing V2 migration and storage/account boundaries remain.

Backend HTTP acceptance commits immutable telemetry, product transitions/counters,
feedback versions and outbox rows in one PostgreSQL transaction. Replaying event
IDs cannot repeat counters; an invalid mixed batch rolls back all of its writes.
ML outages/timeouts affect delivery only. Dead rows remain visible and can be
replayed through the existing authenticated operations endpoint after the fault
is corrected. ML owns learning, never product counters or product SQL writes.

`GET /api/internal/v2/operations/status` exposes existing pending/claimed/dead
counts and oldest pending age, plus:

- `retrying`: pending rows with a prior attempt, plus claimed retry attempts.
- `retry_attempts`: sum of attempts beyond each retained row's first attempt.

The latter is a current-row gauge, not a lifetime monotonic counter; replay resets
that row's attempts and retention removes historical rows. The separate ML health
surface reports its accepted Redis stream/pending/dead-letter work. Backend outbox
acceptance and completed preference-vector learning are distinct stages.

## Verification

From Weave, run the normal frontend lint/typecheck/tests, plus:

```bash
npx tsx --test tests/activity-process-restart.test.ts tests/activity-lifecycle.test.ts
RUN_ACTIVITY_BROWSER=1 npx tsx --test tests/activity-web-recovery.test.ts
```

The record tests use the real queue/store with a Node filesystem adapter, SIGKILL
and fresh processes after completed writes, offline failure and interrupted
verified-temporary commits. They preserve event identity/timestamps and prove
acknowledged records do not resurrect. This tests process termination, not power
loss or the physical Expo/native filesystem API.

The Chromium fixture uses the actual web storage adapter, queue and lifecycle
helper across reload, foreground/connectivity wakes and unmount. Its native
signals and HTTP acknowledgement boundary are controlled fixtures. It observes
three unique HTTP deliveries and empty durable pending storage. It does not
claim full live-app or native-device acceptance; no product typography/layout
was changed.

From backend, explicitly select a migrated disposable loopback `weave_scroll`
database and run:

```bash
RUN_ACTIVITY_RELIABILITY_INTEGRATION=1 npx tsx --test tests/database/activityReliability.integration.test.ts
```

This guarded test posts through the registered interaction router in a separate
process, proves exact like/save counters, invalid-batch rollback and an injected
SQL failure after the counter write,
SIGKILLs that API after its 202 response, then uses fresh workers through 503,
acceptance-before-timeout, terminal failure and operator replay. SQL rows/counters
stay unchanged by delivery retries. The ML endpoint is an explicit loopback HTTP
double; actual provider/Redis acceptance is separately covered by the paired
outbox contract tests from Weave193/ML131. All fixture processes/files/rows are
owned and cleaned; no live credentials or shared data are exercised.
