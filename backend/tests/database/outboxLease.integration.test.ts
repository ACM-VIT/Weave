import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

test('claim recovery and maintenance preserve live leases with long index timeouts', {
  skip: process.env.RUN_DATABASE_INTEGRATION !== '1',
}, async (t) => {
  const { sqlClient } = await import('../../db/index.js');
  const { OutboxService } = await import('../../services/outboxService.js');
  const { DataReconciliationService } = await import('../../services/dataReconciliationService.js');
  const previousTimeout = process.env.ML_REPOSITORY_INDEX_TIMEOUT_MS;
  const previousLease = process.env.OUTBOX_LEASE_MS;

  try {
    process.env.ML_REPOSITORY_INDEX_TIMEOUT_MS = '600000';
    for (const configuredLease of [undefined, '900000']) {
      await t.test(configuredLease ? 'explicit extended lease' : 'timeout-derived lease', async () => {
        if (configuredLease === undefined) delete process.env.OUTBOX_LEASE_MS;
        else process.env.OUTBOX_LEASE_MS = configuredLease;
        const expiredAgeMs = Number(configuredLease ?? 660_000) + 60_000;
        const liveId = crypto.randomUUID();
        const expiredId = crypto.randomUUID();
        const token = crypto.randomUUID();
        const outbox = new OutboxService();

        // Database integration files run serially against a disposable database.
        await sqlClient`TRUNCATE telemetry.ml_outbox`;
        for (const [id, ageMs] of [[liveId, 360_000], [expiredId, expiredAgeMs]] as const) {
          await sqlClient`
            INSERT INTO telemetry.ml_outbox (
              outbox_id,job_type,aggregate_id,idempotency_key,payload,status,claimed_at,claim_token
            ) VALUES (
              ${id}::uuid,'repo_index',${crypto.randomUUID()}::uuid,${`lease-test:${id}`},'{}'::jsonb,
              'claimed',now()-(${ageMs}::text || ' milliseconds')::interval,${token}::uuid
            )
          `;
        }

        const claimed = await outbox.claim(10);
        assert.deepEqual(claimed.map(row => row.outbox_id), [expiredId]);
        assert.notEqual(claimed[0].claim_token, token);
        await sqlClient`
          UPDATE telemetry.ml_outbox
          SET claimed_at=now()-(${expiredAgeMs}::text || ' milliseconds')::interval
          WHERE outbox_id=${expiredId}::uuid
        `;

        assert.equal(await new DataReconciliationService().resetAbandonedClaims(), 1);
        const rows = await sqlClient`
          SELECT outbox_id,status,claim_token,claimed_at FROM telemetry.ml_outbox
        `;
        const live = rows.find(row => row.outbox_id === liveId)!;
        const expired = rows.find(row => row.outbox_id === expiredId)!;
        assert.equal(live.status, 'claimed');
        assert.equal(live.claim_token, token, 'Maintenance must preserve the in-flight delivery token.');
        assert.ok(live.claimed_at);
        assert.equal(expired.status, 'pending');
        assert.equal(expired.claim_token, null);
        assert.equal(expired.claimed_at, null);
        assert.deepEqual((await outbox.claim(10)).map(row => row.outbox_id), [expiredId]);
      });
    }
  } finally {
    if (previousTimeout === undefined) delete process.env.ML_REPOSITORY_INDEX_TIMEOUT_MS;
    else process.env.ML_REPOSITORY_INDEX_TIMEOUT_MS = previousTimeout;
    if (previousLease === undefined) delete process.env.OUTBOX_LEASE_MS;
    else process.env.OUTBOX_LEASE_MS = previousLease;
    try {
      await sqlClient`DELETE FROM telemetry.ml_outbox WHERE idempotency_key LIKE 'lease-test:%'`;
    } finally {
      await sqlClient.end({ timeout: 1 });
    }
  }
});
