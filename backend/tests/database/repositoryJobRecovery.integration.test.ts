import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sqlClient } from '../../db/index.js';
import { OutboxService } from '../../services/outboxService.js';

const integration = process.env.RUN_DATABASE_INTEGRATION === '1' ? test : test.skip;
test.after(async () => {
  if (process.env.RUN_DATABASE_INTEGRATION === '1') await sqlClient.end({ timeout: 1 });
});

integration('only delivered indexes retire failed indexes, while delivered refreshes retire refreshes', async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  const repo = randomUUID(), index = randomUUID(), refresh = randomUUID(), successor = randomUUID();
  const worker = new OutboxService();
  const status = async (id: string) => String((await sqlClient`
    SELECT status FROM telemetry.ml_outbox WHERE outbox_id=${id}::uuid`)[0].status);
  try {
    await sqlClient`INSERT INTO telemetry.ml_outbox
      (outbox_id,job_type,aggregate_id,idempotency_key,payload,status,created_at,delivered_at)
      VALUES
      (${index}::uuid,'repo_index',${repo}::uuid,${index},'{}','dead',now()-interval '2 minutes',NULL),
      (${refresh}::uuid,'repo_refresh',${repo}::uuid,${refresh},'{}','dead',now()-interval '2 minutes',NULL),
      (${successor}::uuid,'repo_refresh',${repo}::uuid,${successor},'{}','delivered',now()-interval '1 minute',now())`;
    assert.equal(await worker.supersedeRepositoryJobDeliveredBySuccessor(index), false);
    assert.equal(await worker.supersedeRepositoryJobDeliveredBySuccessor(refresh), true);
    await worker.reconcileSupersededRepositoryJobs(1_000);
    assert.equal(await status(index), 'dead', 'Bulk cleanup must preserve failed content indexing');
    assert.equal(await status(refresh), 'superseded');
    assert.equal(await worker.replay(index), true, 'The failed index remains recoverable');
    await sqlClient`UPDATE telemetry.ml_outbox SET status='dead' WHERE outbox_id=${index}::uuid`;
    await sqlClient`UPDATE telemetry.ml_outbox SET status='dead' WHERE outbox_id=${refresh}::uuid`;
    await worker.reconcileSupersededRepositoryJobs(1_000);
    assert.equal(await status(refresh), 'superseded', 'Bulk cleanup still handles refresh successors');
    assert.equal(await status(index), 'dead');
    // An older index or another repository cannot stand in for a repaired index.
    const older = randomUUID(), unrelated = randomUUID();
    await sqlClient`INSERT INTO telemetry.ml_outbox
      (outbox_id,job_type,aggregate_id,idempotency_key,payload,status,created_at,delivered_at)
      VALUES
      (${older}::uuid,'repo_index',${repo}::uuid,${older},'{}','delivered',now()-interval '3 minutes',now()),
      (${unrelated}::uuid,'repo_index',${randomUUID()}::uuid,${repo},'{}','delivered',now(),now())`;
    assert.equal(await worker.supersedeRepositoryJobDeliveredBySuccessor(index), false);
    await worker.reconcileSupersededRepositoryJobs(1_000);
    assert.equal(await status(index), 'dead');
    await sqlClient`UPDATE telemetry.ml_outbox SET job_type='repo_index' WHERE outbox_id=${successor}::uuid`;
    assert.equal(await worker.supersedeRepositoryJobDeliveredBySuccessor(index), true);
    await sqlClient`UPDATE telemetry.ml_outbox SET status='dead' WHERE outbox_id=${index}::uuid`;
    await worker.reconcileSupersededRepositoryJobs(1_000);
    assert.equal(await status(index), 'superseded', 'Both cleanup paths recognize a real repaired index');
    assert.equal(await worker.replay(index), false);
  } finally {
    await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${repo}::uuid OR idempotency_key=${repo}`;
  }
});
