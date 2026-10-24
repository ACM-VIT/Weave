import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { InteractionEventV2 } from '../../contracts/interactions.v2.js';
import type { MlFeedbackEvent } from '../../contracts/ml.v2.js';
import { assertDisposableDatabase } from '../database/disposableDatabase.js';
import { stopFixtureProcess } from './fixtureProcess.js';

const enabled = process.env.RUN_OUTBOX_FEEDBACK_CONTRACT === '1';
if (enabled) {
  assertDisposableDatabase();
  const redis = new URL(process.env.REDIS_URL ?? '');
  assert.equal(redis.protocol, 'redis:'); assert.equal(redis.pathname, '/15');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(redis.hostname));
  assert.equal(redis.search + redis.hash, '');
}

test('real PostgreSQL outbox and pinned Python HTTP/Redis retain partial, conflicting and ambiguous feedback', {
  skip: !enabled, timeout: 45_000,
}, async t => {
  const root = process.env.WEAVE_ML_CONTRACT_ROOT;
  assert.ok(root && path.isAbsolute(root));
  const release = JSON.parse(await readFile(new URL('../../contracts/ml-contract-release.json', import.meta.url), 'utf8'));
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), release.revision);
  assert.equal(await readFile(path.join(root, 'contracts/ml-v2.openapi.json'), 'utf8'),
    await readFile(new URL('../../contracts/ml-v2.openapi.json', import.meta.url), 'utf8'));
  const [{ sqlClient }, { OutboxService }, { OutboxDeliveryLanes }, { MlV2Client }, { Redis }] = await Promise.all([
    import('../../db/index.js'), import('../../services/outboxService.js'), import('../../workers/outboxDeliveryLanes.js'),
    import('../../services/mlService.js'), import('ioredis'),
  ]);
  const stream = `test:outbox-contract:${randomUUID()}`;
  const redis = new Redis(process.env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: null });
  redis.on('error', () => {});
  const ids: string[] = [];
  const productUser = randomUUID(), productRepo = randomUUID();
  let stopChild: (() => Promise<void>) | undefined;
  t.after(async () => {
    try {
      await stopChild?.();
      await sqlClient`DELETE FROM telemetry.ml_outbox WHERE outbox_id=ANY(${ids}::uuid[])`;
      await sqlClient`DELETE FROM telemetry.ml_outbox WHERE job_type='feedback' AND aggregate_id=${productUser}::uuid`;
      await sqlClient`DELETE FROM telemetry.interaction_events WHERE user_id=${productUser}::uuid`;
      await sqlClient`DELETE FROM telemetry.user_repo_engagement WHERE user_id=${productUser}::uuid`;
      await sqlClient`DELETE FROM app.users WHERE user_id=${productUser}::uuid`;
      await sqlClient`DELETE FROM auth.users WHERE id=${productUser}::uuid`;
      await sqlClient`DELETE FROM app.repos WHERE repo_id=${productRepo}::uuid`;
      if (redis.status === 'ready') {
        const keys = await redis.keys(`${stream}*`); if (keys.length) await redis.del(...keys);
      }
    } finally { redis.disconnect(); await sqlClient.end({ timeout: 1 }); }
  });
  await redis.connect();
  const child = spawn(path.join(root, '.venv/bin/python'), [fileURLToPath(new URL('./feedbackContractServer.py', import.meta.url))], {
    cwd: root, env: { ...process.env, WEAVE_ML_CONTRACT_ROOT: root, APP_ENV: 'development',
      INTERNAL_API_SECRET: 'local-feedback-contract-secret', QDRANT_URL: 'http://127.0.0.1:9',
      FEEDBACK_STREAM_NAME: stream, FEEDBACK_STREAM_MAXLEN: '1000' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  stopChild = () => stopFixtureProcess(child);
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Feedback fixture did not bind.')), 15_000);
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); const match = /CONTRACT_PORT=(\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]!); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Feedback fixture exited before readiness.')); });
  });
  const origin = `http://127.0.0.1:${port}`;
  const client = new MlV2Client({ baseUrl: origin, internalSecret: 'local-feedback-contract-secret',
    timeoutMs: 1000, deliveryTimeoutMs: 1000, maxResponseBytes: 100_000 });
  let now = Date.now();
  const outbox = new OutboxService(); const lanes = new OutboxDeliveryLanes(outbox, client, 20, () => now);
  const event = (): MlFeedbackEvent => ({ event_id: randomUUID(), user_id: randomUUID(), repo_id: randomUUID(),
    feedback_version: '1', event_type: 'like', dwell_ms: null, occurred_at: '2026-10-23T00:00:00Z' });
  const insert = async (value: MlFeedbackEvent) => {
    const id = randomUUID(); ids.push(id);
    await sqlClient`INSERT INTO telemetry.ml_outbox(outbox_id,job_type,aggregate_id,idempotency_key,payload)
      VALUES(${id}::uuid,'feedback',${value.user_id}::uuid,${id},${JSON.stringify(value)}::jsonb)`;
    return id;
  };
  const control = async (mode: string) => {
    const response = await fetch(origin + '/_fixture/control', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-internal-secret': 'local-feedback-contract-secret',
    }, body: JSON.stringify({ mode }) }); assert.equal(response.status, 200);
  };
  const statuses = async (selected: string[]) => (await sqlClient`SELECT status FROM telemetry.ml_outbox
    WHERE outbox_id=ANY(${selected}::uuid[])`).map(row => String(row.status)).sort();
  const retry = async (selected: string[]) => {
    now += 3000;
    await sqlClient`UPDATE telemetry.ml_outbox SET available_at=now() WHERE outbox_id=ANY(${selected}::uuid[]) AND status='pending'`;
    for (let i = 0; i < selected.length; i++) await lanes.runOnce('feedback-retry');
  };
  const streamIds = async () => (await redis.xrange(stream, '-', '+')).map(([, fields]) => fields[fields.indexOf('event_id') + 1]!);

  const normal = [event(), event()]; const normalIds = await Promise.all(normal.map(insert));
  assert.equal((await lanes.runOnce('feedback')).processed, 2);
  assert.deepEqual(await statuses(normalIds), ['delivered', 'delivered'], JSON.stringify(await sqlClient`
    SELECT status,last_error FROM telemetry.ml_outbox WHERE outbox_id=ANY(${normalIds}::uuid[])`));
  assert.equal((await streamIds()).length, 2);

  const partial = [event(), event(), event()]; const partialIds = await Promise.all(partial.map(insert));
  await control('partial'); await lanes.runOnce('feedback');
  assert.deepEqual(await statuses(partialIds), ['pending', 'pending', 'pending']);
  assert.equal((await streamIds()).length, 4, 'two actual scripts accept despite the middle Redis script failure');
  const claimsBeforeCooldown = await outbox.status();
  assert.equal((await lanes.runOnce('feedback-retry')).processed, 0);
  assert.equal((await outbox.status()).claimed, claimsBeforeCooldown.claimed);
  await retry(partialIds);
  assert.deepEqual(await statuses(partialIds), ['delivered', 'delivered', 'delivered']);

  const ambiguous = [event(), event()]; const ambiguousIds = await Promise.all(ambiguous.map(insert));
  const timeoutLanes = new OutboxDeliveryLanes(outbox, new MlV2Client({ baseUrl: origin,
    internalSecret: 'local-feedback-contract-secret', timeoutMs: 1000, deliveryTimeoutMs: 100,
    maxResponseBytes: 100_000 }), 20, () => now);
  await control('delay'); await timeoutLanes.runOnce('feedback');
  assert.deepEqual(await statuses(ambiguousIds), ['pending', 'pending']);
  const timeoutErrors = await sqlClient`SELECT last_error FROM telemetry.ml_outbox WHERE outbox_id=ANY(${ambiguousIds}::uuid[])`;
  assert.ok(timeoutErrors.every(row => String(row.last_error).includes('deadline exceeded')));
  for (const value of ambiguous) assert.ok((await streamIds()).includes(value.event_id), 'Redis accepted before the HTTP deadline expired');
  await retry(ambiguousIds); assert.deepEqual(await statuses(ambiguousIds), ['delivered', 'delivered']);

  const original = event(); assert.equal((await client.deliverFeedback({ schema_version: 2, events: [original] })).accepted, true);
  const conflicting = { ...original, event_type: 'dislike' as const }; const good = [event(), event()];
  const conflictIds = await Promise.all([conflicting, ...good].map(insert));
  await lanes.runOnce('feedback'); assert.deepEqual(await statuses(conflictIds), ['pending', 'pending', 'pending']);
  await retry(conflictIds); assert.deepEqual(await statuses(conflictIds), ['dead', 'delivered', 'delivered']);

  const pressure = [event(), event()]; const pressureIds = await Promise.all(pressure.map(insert));
  await control('429'); await lanes.runOnce('feedback');
  assert.deepEqual(await statuses(pressureIds), ['pending', 'pending']);
  assert.equal((await lanes.runOnce('feedback-retry')).processed, 0);
  assert.equal((await lanes.runOnce('feedback')).processed, 0);
  for (const value of pressure) assert.ok(!(await streamIds()).includes(value.event_id));
  await retry(pressureIds); assert.deepEqual(await statuses(pressureIds), ['delivered', 'delivered']);
  const durable = await streamIds();
  assert.equal(durable.length, new Set(durable).size, 'ambiguous/partial retries do not duplicate Redis events');
  assert.equal(durable.length, normal.length + partial.length + ambiguous.length + good.length + 1 + pressure.length);

  // Exercise the actual product writers before HTTP delivery. ML acknowledgements
  // and ambiguous retries must never apply product deltas a second time.
  const { processInteractionBatchV2InTransaction } = await import('../../services/activityV2Service.js');
  const { setRepositorySaved } = await import('../../services/savedRepositoryService.js');
  await sqlClient`INSERT INTO auth.users(id) VALUES(${productUser}::uuid)`;
  await sqlClient`INSERT INTO app.users(user_id,username,status)
    VALUES(${productUser}::uuid,${'counter_'+productUser.replaceAll('-', '')},'active')`;
  await sqlClient`INSERT INTO app.repos(repo_id,github_id,full_name,owner,name,url,status)
    VALUES(${productRepo}::uuid,${Date.now()},${'counter/'+productRepo},'counter',${productRepo},
      ${'https://github.com/counter/'+productRepo},'active')`;
  const session = randomUUID();
  const interaction = (event_type: InteractionEventV2['event_type']): InteractionEventV2 => ({
    schema_version: 2, event_id: randomUUID(), session_id: session, serve_id: null,
    repo_id: productRepo, position: null, event_type, dwell_ms: null,
    client_occurred_at: new Date().toISOString(),
    context: event_type === 'save' ? { save_state_source: 'list_membership' } : {},
  });
  const events = [interaction('like'), interaction('save'), interaction('impression')];
  const write = async (values: InteractionEventV2[], saved: boolean, rollback = false) => sqlClient.begin(async tx => {
    await tx`SELECT user_id FROM app.users WHERE user_id=${productUser}::uuid FOR KEY SHARE`;
    await tx`INSERT INTO app.user_feed_state(user_id) VALUES(${productUser}::uuid) ON CONFLICT DO NOTHING`;
    await tx`SELECT user_id FROM app.user_feed_state WHERE user_id=${productUser}::uuid FOR UPDATE`;
    const changed = await setRepositorySaved(tx, productUser, productRepo, saved);
    const result = await processInteractionBatchV2InTransaction(tx, productUser, values);
    if (rollback) throw new Error('fixture rollback');
    return { changed, result };
  });
  const counts = async () => {
    const [row] = await sqlClient`SELECT likes_count,saves_count,views_count
      FROM app.repo_engagement WHERE repo_id=${productRepo}::uuid`;
    return [Number(row!.likes_count), Number(row!.saves_count), Number(row!.views_count)];
  };
  const first = await write(events, true);
  assert.equal(first.changed, true);
  assert.ok(first.result.results.every(value => value.status === 'accepted'));
  assert.deepEqual(await counts(), [1, 1, 1]);
  const repeated = await write(events, true);
  assert.equal(repeated.changed, false);
  assert.ok(repeated.result.results.every(value => value.status === 'duplicate'));
  assert.deepEqual(await counts(), [1, 1, 1]);
  const productJobs = await sqlClient`SELECT outbox_id,payload FROM telemetry.ml_outbox
    WHERE aggregate_id=${productUser}::uuid AND job_type='feedback'
    ORDER BY (payload->>'feedback_version')::bigint`;
  const productIds = productJobs.map(row => String(row.outbox_id)); ids.push(...productIds);
  assert.equal(productIds.length, 2, 'like and save emit feedback; impression stays backend-owned');
  await control('delay');
  assert.equal((await timeoutLanes.runOnce('feedback')).processed, 1, 'same-user feedback remains causally ordered');
  assert.deepEqual(await statuses(productIds), ['pending', 'pending']);
  assert.ok((await streamIds()).includes(String(productJobs[0]!.payload.event_id)));
  assert.ok(!(await streamIds()).includes(String(productJobs[1]!.payload.event_id)), 'successor waits for predecessor acknowledgement');
  assert.deepEqual(await counts(), [1, 1, 1], 'Redis accepts before ambiguous HTTP timeout without changing product counts');
  await retry([productIds[0]!]);
  assert.equal((await lanes.runOnce('feedback')).processed, 1);
  assert.deepEqual(await statuses(productIds), ['delivered', 'delivered']);
  const afterRetry = await streamIds();
  assert.equal(afterRetry.length, new Set(afterRetry).size);
  for (const job of productJobs) {
    assert.equal(afterRetry.filter(id => id === String(job.payload.event_id)).length, 1,
      'each committed product feedback event must reach Redis exactly once');
  }
  assert.deepEqual(await counts(), [1, 1, 1], 'delivered duplicate acknowledgements leave all product counts unchanged');
  const rolledBack = [interaction('unlike'), interaction('impression')];
  await assert.rejects(write(rolledBack, false, true), /fixture rollback/);
  assert.deepEqual(await counts(), [1, 1, 1]);
  assert.equal(Number((await sqlClient`SELECT count(*) FROM telemetry.interaction_events
    WHERE event_id=ANY(${rolledBack.map(value => value.event_id)}::uuid[])`)[0]!.count), 0);
  assert.equal(Number((await sqlClient`SELECT count(*) FROM telemetry.ml_outbox
    WHERE aggregate_id=${productUser}::uuid AND job_type='feedback'`)[0]!.count), 2,
    'rollback does not leave feedback jobs for uncommitted counter changes');

});
