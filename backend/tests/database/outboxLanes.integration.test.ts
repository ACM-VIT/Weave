import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sqlClient } from '../../db/index.js';
import { OutboxService } from '../../services/outboxService.js';
import { OutboxDeliveryLanes } from '../../workers/outboxDeliveryLanes.js';
import type { OutboxTransportPort } from '../../ports/outboxTransportPort.js';
import { assertDisposableDatabase } from './disposableDatabase.js';

const enabled = process.env.RUN_OUTBOX_LANES_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();
const integration = enabled ? test : test.skip;
const ids: string[] = [];
test.afterEach(async () => { if (enabled && ids.length) await sqlClient`DELETE FROM telemetry.ml_outbox WHERE outbox_id=ANY(${ids.splice(0)}::uuid[])`; });
test.after(async () => { if (enabled) await sqlClient.end({ timeout: 1 }); });

async function insert(user = randomUUID(), version = '1', type = 'feedback') {
  const id = randomUUID(); ids.push(id);
  await sqlClient`INSERT INTO telemetry.ml_outbox(outbox_id,job_type,aggregate_id,idempotency_key,payload)
    VALUES(${id}::uuid,${type},${user}::uuid,${id},${JSON.stringify({ event_id: id, user_id: user,
      repo_id: randomUUID(), feedback_version: version, event_type: 'like', occurred_at: '2026-10-23T00:00:00Z', dwell_ms: null })}::jsonb)`;
  return id;
}

integration('concurrent lane claims select only independent earliest versions and preserve retry isolation', async () => {
  const outbox = new OutboxService(); const user = randomUUID();
  const first = await insert(user); const later = await insert(user, '2'); const other = await insert();
  const onboarding = await insert(randomUUID(), '1', 'onboard');
  const groups = await Promise.all([outbox.claim(2, undefined, { jobTypes: ['feedback'], attempts: 'first' }),
    outbox.claim(2, undefined, { jobTypes: ['feedback'], attempts: 'first' })]);
  const claimed = groups.flat();
  assert.deepEqual(claimed.map(row => row.outbox_id).sort(), [first, other].sort());
  assert.equal(new Set(claimed.map(row => row.outbox_id)).size, 2);
  assert.deepEqual(await outbox.claim(2, undefined, { jobTypes: ['feedback'], attempts: 'first' }), []);
  const mine = claimed.find(row => row.outbox_id === first)!;
  await outbox.markFailed(mine, 'retry', true, 0);
  assert.deepEqual(await outbox.claim(2, undefined, { jobTypes: ['feedback'], attempts: 'first' }), []);
  const [retry] = await outbox.claim(1, undefined, { jobTypes: ['feedback'], attempts: 'retry' });
  assert.equal(retry!.outbox_id, first); assert.equal(retry!.attempts, 2);
  await outbox.markDelivered(retry!);
  assert.equal((await outbox.claim(2, undefined, { jobTypes: ['feedback'], attempts: 'first' }))[0]!.outbox_id, later);
  assert.equal((await outbox.claim(1, undefined, { jobTypes: ['onboard'] }))[0]!.outbox_id, onboarding);
});

integration('expired feedback leases move to singleton retry, and stale claim tokens cannot finalize or fail reclaimed work', async () => {
  const outbox = new OutboxService(); const id = await insert();
  const [old] = await outbox.claim(1, undefined, { jobTypes: ['feedback'], attempts: 'first' });
  await sqlClient`UPDATE telemetry.ml_outbox SET claimed_at=now()-interval '1 hour' WHERE outbox_id=${id}::uuid`;
  assert.deepEqual(await outbox.claim(20, undefined, { jobTypes: ['feedback'], attempts: 'first' }), []);
  const [recovered] = await outbox.claim(1, undefined, { jobTypes: ['feedback'], attempts: 'retry' });
  assert.notEqual(recovered!.claim_token, old!.claim_token);
  await outbox.markDelivered(old!); await outbox.markFailed(old!, 'stale failure', false);
  const [state] = await sqlClient`SELECT status,claim_token FROM telemetry.ml_outbox WHERE outbox_id=${id}::uuid`;
  assert.equal(state!.status, 'claimed'); assert.equal(state!.claim_token, recovered!.claim_token);
  await outbox.markDelivered(recovered!);
  assert.equal((await sqlClient`SELECT status FROM telemetry.ml_outbox WHERE outbox_id=${id}::uuid`)[0]!.status, 'delivered');
});

integration('SQL-backed feedback batching acknowledges partial success and replays unknown members independently', async () => {
  const outbox = new OutboxService(); const first = await insert(); const second = await insert();
  const durable = new Set<string>(); const sizes: number[] = [];
  const transport = { deliverFeedback: async (batch: { events: Array<{ event_id: string }> }) => {
    sizes.push(batch.events.length);
    for (const event of batch.events) durable.add(event.event_id);
    return { accepted: true, retryable: false, status_code: 202, response_body: {
      durable: true, accepted: 0, duplicates: 1, acknowledged_event_ids: [batch.events[0]!.event_id],
    } };
  } } as unknown as OutboxTransportPort;
  const lanes = new OutboxDeliveryLanes(outbox, transport);
  assert.equal((await lanes.runOnce('feedback')).processed, 2);
  let states = await sqlClient`SELECT outbox_id,status FROM telemetry.ml_outbox WHERE outbox_id=ANY(${[first, second]}::uuid[])`;
  assert.equal(states.filter(row => row.status === 'delivered').length, 1);
  assert.equal(states.filter(row => row.status === 'pending').length, 1);
  await sqlClient`UPDATE telemetry.ml_outbox SET available_at=now() WHERE outbox_id=ANY(${[first, second]}::uuid[])`;
  assert.equal((await lanes.runOnce('feedback-retry')).processed, 1);
  states = await sqlClient`SELECT outbox_id,status FROM telemetry.ml_outbox WHERE outbox_id=ANY(${[first, second]}::uuid[])`;
  assert.ok(states.every(row => row.status === 'delivered'));
  assert.deepEqual(sizes, [2, 1]); assert.deepEqual([...durable].sort(), [first, second].sort());
});

integration('future retry deadlines are filtered by lane, and invalid claims fail before database work', async () => {
  const outbox = new OutboxService(); const id = await insert();
  await sqlClient`UPDATE telemetry.ml_outbox SET attempts=1,available_at=now()+interval '10 seconds' WHERE outbox_id=${id}::uuid`;
  assert.equal(await outbox.nextRunInMs({ jobTypes: ['feedback'], attempts: 'first' }), undefined);
  const wait = await outbox.nextRunInMs({ jobTypes: ['feedback'], attempts: 'retry' });
  assert.ok(wait! > 0 && wait! <= 10_000);
  for (const limit of [0, 1001, 1.5]) await assert.rejects(outbox.claim(limit), /claim limit/);
  await assert.rejects(outbox.claim(1, undefined, { jobTypes: [] }), /valid job types/);
});

integration('a slow index cannot hold up a twenty-user feedback batch in real PostgreSQL', async () => {
  const outbox = new OutboxService(); await insert(randomUUID(), '1', 'repo_index');
  let release!: () => void; let entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const sizes: number[] = [];
  const transport = {
    deliverRepositoryIndex: async () => { entered(); await hold; return { accepted: false, retryable: false, status_code: 400 }; },
    deliverFeedback: async (batch: { events: Array<{ event_id: string }> }) => {
      sizes.push(batch.events.length);
      return { accepted: true, retryable: false, status_code: 202, response_body: { durable: true,
        accepted: batch.events.length, duplicates: 0, acknowledged_event_ids: batch.events.map(event => event.event_id) } };
    },
  } as unknown as OutboxTransportPort;
  const lanes = new OutboxDeliveryLanes(outbox, transport);
  const index = lanes.runOnce('repository'); await started;
  try {
    const feedbackIds: string[] = [];
    for (let i = 0; i < 20; i++) feedbackIds.push(await insert());
    assert.equal((await lanes.runOnce('feedback')).processed, 20);
    assert.equal(Number((await sqlClient`SELECT count(*) FROM telemetry.ml_outbox
      WHERE outbox_id=ANY(${feedbackIds}::uuid[]) AND status='delivered'`)[0]!.count), 20);
    assert.deepEqual(sizes, [20]);
  } finally { release(); await index; }
});
