import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { Redis } from 'ioredis';
import { RedisFeedQueue } from '../../redis/feedQueue.js';

const integration = process.env.RUN_REDIS_INTEGRATION === '1' ? test : test.skip;

integration('indexed refill keeps reservations disjoint, returns atomic depth and fences late publishers', async t => {
  const url = new URL(process.env.REDIS_TEST_URL ?? 'redis://127.0.0.1:6379/15');
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname === '/15');
  const redis = new Redis(url.toString(), { maxRetriesPerRequest: 1 });
  const queue = new RedisFeedQueue(redis, 30_000);
  const user = crypto.randomUUID();
  const requests = [crypto.randomUUID(), crypto.randomUUID()];
  const tokens = [crypto.randomUUID(), crypto.randomUUID()];
  const generation = crypto.randomUUID();
  const keys = [`feed:v2:version-index:${user}`];
  for (const version of [1, 2]) keys.push(`feed:v2:${user}:${version}`, `feed:v2:reservation-index:${user}:${version}`,
    `feed:v2:generation-lock:${user}:${version}`, `feed:v2:published:${user}:${version}`);
  for (const request of requests) keys.push(`feed:v2:reservation:${user}:1:${request}:meta`, `feed:v2:reservation:${user}:1:${request}:items`);
  t.after(async () => { try { await redis.del(...keys); } finally { redis.disconnect(); } });
  const entry = () => ({ repo_id: crypto.randomUUID(), score: 1, source: 'semantic', model_version: 'fixture', summary_id: null });
  const initial = Array.from({ length: 20 }, entry);
  await queue.replace(user, 1n, initial, 60);
  let explicitDepthReads = 0;
  const send = redis.sendCommand;
  redis.sendCommand = function (...args: Parameters<typeof send>) {
    if (args[0].name === 'llen') explicitDepthReads++;
    return send.apply(this, args);
  };
  const reservations = await Promise.all(requests.map((request, i) => queue.reserve(user, 1n, request, 3, tokens[i])));
  assert.deepEqual(reservations.map(value => value.remainingDepth).sort((a, b) => a! - b!), [14, 17]);
  const reserved = reservations.flatMap(value => value.items);
  assert.equal(new Set(reserved.map(item => item.repo_id)).size, 6);
  assert.equal(await queue.acquireGenerationLock(user, 1n, generation, 10_000), true);
  const state = await queue.generationState(user, 1n, generation);
  assert.ok(state);
  assert.equal(state.remainingDepth, 14);
  assert.equal(state.occupiedCount, 20);
  assert.deepEqual(new Set(state.excludedRepoIds), new Set(initial.map(item => item.repo_id)));
  const fresh = Array.from({ length: 20 }, entry);
  const appended = await queue.append(user, 1n, generation, [...reserved, ...initial.slice(8, 10), ...fresh], 60, 25);
  assert.deepEqual(appended, { status: 'published', count: 11 });
  assert.deepEqual(await queue.append(user, 1n, generation, fresh, 60, 25), { status: 'capacity', count: 0 });
  const queued = (await redis.lrange(`feed:v2:${user}:1`, 0, -1)).map(value => JSON.parse(value).repo_id as string);
  assert.equal(queued.length, 25);
  assert.equal(new Set([...queued, ...reserved.map(item => item.repo_id)]).size, 31,
    'appending must deduplicate both queued and outstanding reserved cards');
  for (const [i, request] of requests.entries()) {
    const replay = await queue.reserve(user, 1n, request, 3, tokens[i]);
    assert.deepEqual(replay.items, reservations[i].items, 'refill must not replace active reservations');
  }
  assert.equal(explicitDepthReads, 0, 'reservation/refill and replay must not add a standalone LLEN request');
  assert.equal(await queue.commit(user, 1n, requests[0], tokens[0]), true);
  assert.equal(await queue.release(user, 1n, requests[1], tokens[1]), true);
  assert.equal(await queue.depth(user, 1n), 28);
  await queue.releaseGenerationLock(user, 1n, generation);
  const newerToken = crypto.randomUUID();
  assert.equal(await queue.acquireGenerationLock(user, 1n, newerToken, 10_000), true);
  assert.equal(await queue.generationState(user, 1n, generation), null);
  assert.equal(await queue.append(user, 1n, generation, [entry()], 60, 45), null);
  assert.equal(await queue.depth(user, 1n), 28, 'a late publisher cannot alter the replacement owner queue');
  assert.ok(await queue.generationState(user, 1n, newerToken));
  assert.deepEqual(await queue.append(user, 1n, newerToken, [entry()], 60, 45), { status: 'published', count: 1 });
  await queue.replace(user, 2n, [entry(), entry()], 60);
  await queue.deleteStaleVersions(user, 2n);
  assert.equal(await queue.depth(user, 1n), 0);
  assert.equal(await queue.depth(user, 2n), 2);
  t.diagnostic(JSON.stringify({ concurrentConsumers: 2, atomicDepths: [14, 17], appended: 11,
    reservedCardsPreserved: 6, standaloneDepthReadsDuringRefill: 0, latePublisherFenced: true }));
});
