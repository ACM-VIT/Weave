import assert from 'node:assert/strict';
import test from 'node:test';
import { Redis } from 'ioredis';

import { RedisFeedQueue, ReservationOwnedError } from '../../redis/feedQueue.js';

const integration = process.env.RUN_REDIS_INTEGRATION === '1' ? test : test.skip;

integration('reservation recovery survives client restart before commit', async () => {
  const url = process.env.REDIS_TEST_URL ?? 'redis://127.0.0.1:6379/15';
  const userId = '00000000-0000-4000-8000-000000000011';
  const requestId = '00000000-0000-4000-8000-000000000012';
  const token = '00000000-0000-4000-8000-000000000013';
  const entries = [1, 2, 3].map((index) => ({
    repo_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    score: index, source: 'semantic', model_version: 'test', summary_id: null,
  }));
  const first = new Redis(url, { maxRetriesPerRequest: 1 });
  await first.flushdb();
  const queue = new RedisFeedQueue(first, 30_000);
  await queue.replace(userId, 1n, entries, 60);
  const reservation = await queue.reserve(userId, 1n, requestId, 2, token);
  assert.deepEqual(reservation.items.map((item) => item.repo_id), entries.slice(0, 2).map((item) => item.repo_id));
  await assert.rejects(
    queue.reserve(userId, 1n, requestId, 2, '00000000-0000-4000-8000-000000000014'),
    ReservationOwnedError,
  );
  first.disconnect();

  const restarted = new Redis(url, { maxRetriesPerRequest: 1 });
  const recovered = new RedisFeedQueue(restarted, 30_000);
  assert.equal(await recovered.release(userId, 1n, requestId, token), true);
  const replay = await recovered.reserve(userId, 1n, requestId, 3, token);
  assert.deepEqual(replay.items.map((item) => item.repo_id), entries.map((item) => item.repo_id));
  assert.equal(await recovered.commit(userId, 1n, requestId, token), true);

  const generatedRequestId = '00000000-0000-4000-8000-000000000015';
  const generatedToken = '00000000-0000-4000-8000-000000000016';
  const empty = await recovered.reserve(userId, 1n, generatedRequestId, 2, generatedToken);
  assert.deepEqual(empty.items, []);
  await recovered.replace(userId, 1n, entries, 60);
  const refilled = await recovered.refill(userId, 1n, generatedRequestId, 2, generatedToken);
  assert.deepEqual(refilled.items.map((item) => item.repo_id), entries.slice(0, 2).map((item) => item.repo_id));
  await assert.rejects(
    recovered.refill(userId, 1n, generatedRequestId, 2, '00000000-0000-4000-8000-000000000017'),
    ReservationOwnedError,
  );
  assert.equal(await recovered.commit(userId, 1n, generatedRequestId, generatedToken), true);
  await restarted.flushdb();
  await restarted.quit();
});

integration('indexed reconciliation repairs missing tracking and only deletes older queue versions', async () => {
  const redis = new Redis(process.env.REDIS_TEST_URL ?? 'redis://127.0.0.1:6379/15', { maxRetriesPerRequest: 1 });
  const user = '00000000-0000-4000-8000-000000000021';
  const request = '00000000-0000-4000-8000-000000000022';
  const queue = new RedisFeedQueue(redis, 30_000);
  const old = 9007199254740992n, current = old + 1n, future = current + 1n;
  const meta = `feed:v2:reservation:${user}:${old}:${request}:meta`;
  const index = `feed:v2:reservation-index:${user}:${old}`;
  const versions = `feed:v2:version-index:${user}`;
  const entry = { repo_id: request, score: 1, source: 'semantic', model_version: 'test', summary_id: null };
  try {
    await redis.flushdb();
    for (const version of [old, current, future]) await queue.replace(user, version, [entry], 60);
    await queue.reserve(user, old, request, 1, 'first-owner');
    await redis.del(index); // old writer or crash-era data without an index
    let found: Awaited<ReturnType<typeof queue.scanReservations>> = [];
    for (let cycle = 0; cycle < 20 && found.length === 0; cycle++) found = await queue.scanReservations();
    assert.equal(found.length, 1);
    assert.equal(found[0].token, 'first-owner');
    assert.notEqual(await redis.zscore(index, meta), null, 'bounded legacy discovery repairs the existing contract');
    assert.equal(await queue.release(user, old, request, 'wrong-owner'), false);
    assert.equal(await redis.hget(meta, 'token'), 'first-owner');
    // Restore an old queue while retaining the reservation, then clean using a
    // captured DB version. Exact bigint comparison must preserve the future.
    await queue.replace(user, old, [entry], 60);
    assert.equal(await queue.deleteStaleVersions(user, current), 1);
    assert.equal(await queue.depth(user, old), 0);
    assert.equal(await queue.depth(user, current), 1);
    assert.equal(await queue.depth(user, future), 1);
    assert.equal(await redis.hget(meta, 'token'), 'first-owner', 'cleanup never deletes reservation ownership');
    assert.equal(await queue.commit(user, old, request, 'first-owner'), true);
    assert.equal(await redis.zscore(index, meta), null);
    // Stale membership is pruned without manufacturing a reservation.
    await redis.zadd(index, Date.now() + 30_000, meta);
    for (let cycle = 0; cycle < 20 && await redis.zscore(index, meta) !== null; cycle++) {
      assert.deepEqual(await queue.scanReservations(), []);
    }
    assert.equal(await redis.zscore(index, meta), null);
    for (let version = 1n; version <= 140n; version++) await queue.replace(user, version, [], 60);
    assert.ok(await redis.zcard(versions) <= 128, 'version tracking retains a bounded candidate set');
  } finally {
    await redis.flushdb();
    await redis.quit();
  }
});
