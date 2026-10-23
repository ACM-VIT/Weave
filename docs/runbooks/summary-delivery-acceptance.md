# Summary delivery acceptance

The summary-bearing operation is canonical `repo_index`, delivered to ML's
`/api/v2/repositories/embed`. `repo_refresh` updates ranking features and remains
stats-only. Historical issue wording about a summary-bearing refresh does not
change that ownership or create another persistence path.

The backend validates the index response envelope, repository/job/content identity
and bounded summary/model/prompt/format provenance. `OutboxService` then commits
the artifact, its active/content fencing and outbox acknowledgement in one SQL
transaction. Unknown SQL failures retain a recoverable claim; expired claim tokens
cannot finish a later worker's work. First-writer artifacts remain immutable.

## Disposable acceptance command

Migrate a dedicated loopback PostgreSQL database named `weave_scroll` first. Do
not share it with an application or another running fixture: these suites truncate
repository/outbox fixtures and exercise migrations. The database guard rejects
production, non-loopback and differently named targets.

From `backend/`, with `DATABASE_URL` explicitly selecting that disposable database:

```bash
NODE_ENV=test RUN_DATABASE_INTEGRATION=1 RUN_SUMMARY_DELIVERY_INTEGRATION=1 \
  npx --no-install tsx --test --test-concurrency=1 \
  tests/database/feedPersistence.integration.test.ts \
  tests/database/repositorySummary.integration.test.ts \
  tests/database/repositorySummaryGuard.test.ts \
  tests/database/summaryDelivery.integration.test.ts
```

The joined test uses the real HTTP ML client, real outbox claiming/worker/completion,
real PostgreSQL and real durable feed projection/serve/replay. Its loopback HTTP
provider is an explicit deterministic double; it does not run a model, Qdrant or
the Python ML service. Existing provider/contract tests cover those separate
boundaries. No production credentials or service is required.

Coverage follows a normal response through active durable feed readback, delivered
replay without another HTTP request/artifact rewrite, actual trigger-injected SQL
failure and lease recovery, stale content followed by a current version, and six
rejected artifact/identity/provenance cases. Existing SQL suites cover hash fencing,
concurrent ingestion lock order, fallback recovery, first-writer retention and
summary identity changes during serving.

The joined workload expects 11 HTTP responses: five valid responses, including
the required retry after SQL failure, and six rejected responses. Four artifacts
persist, three remain active, four jobs deliver and six terminate without
acknowledging malformed work. Replaying the delivered normal job adds zero HTTP
requests and does not change its artifact. These are controlled acceptance counts,
not production throughput, real provider generation cost or model quality.

The dedicated summary-delivery workflow provisions a fresh PostgreSQL service,
applies migrations with the explicit disposable auth stub and enables the three
integration suites plus the guard regression. Default backend tests skip these
integrations; an ordinary passing test count does not establish their acceptance.
Release still requires compatible ML,
the additive summary migrations and coordinated normal rollout.
