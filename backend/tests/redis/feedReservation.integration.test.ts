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

integration('generation renewal and publish are atomically fenced by the current lock token',async()=>{
  const url=new URL(process.env.REDIS_TEST_URL??'redis://127.0.0.1:6379/15');
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname==='/15');
  const redis=new Redis(url.toString(),{maxRetriesPerRequest:1});const queue=new RedisFeedQueue(redis);
  const user='generation-fence-test';const versionIndex=`feed:v2:version-index:${user}`;const lock=`feed:v2:generation-lock:${user}:1`;
  const latest=[{repo_id:'latest-repo',score:1,source:'semantic',model_version:'test',summary_id:null}];
  try{
    await redis.del(lock,`feed:v2:${user}:1`,`feed:v2:published:${user}:1`,versionIndex);
    assert.equal(await queue.acquireGenerationLock(user,1n,'old',1000),true);
    await redis.pexpire(lock,0); // Deterministically expire the old lease.
    assert.equal(await queue.acquireGenerationLock(user,1n,'new',1000),true);
    assert.equal(await queue.renewGenerationLock(user,1n,'old',5000),false);
    assert.equal(await queue.renewGenerationLock(user,1n,'new',5000),true);
    assert.ok(await redis.pttl(lock)>1000);
    assert.equal(await queue.publishGeneration(user,1n,'new',latest,60),true);
    assert.deepEqual(await redis.zrange(versionIndex,0,-1),['1']);
    assert.ok(await redis.pttl(versionIndex)>0);
    assert.equal(await queue.publishGeneration(user,1n,'old',[],60),false);
    assert.equal(await queue.hasPublishedGeneration(user,1n),true);
    await redis.del(`feed:v2:${user}:1`); // Consumed list does not remove success.
    assert.equal(await queue.publishGeneration(user,1n,'new',latest,60,true),false);
    assert.equal(await queue.depth(user,1n),0);
    await redis.del(versionIndex);
    assert.equal(await queue.publishGeneration(user,1n,'new',[],60),true);
    assert.deepEqual(await redis.zrange(versionIndex,0,-1),['1'], 'accepted empty publication also tracks its version');
    assert.equal(await queue.hasPublishedGeneration(user,1n),true);
    assert.equal(await queue.publishGeneration(user,1n,'new',latest,60,true),false);
    await queue.releaseGenerationLock(user,1n,'old');assert.equal(await redis.get(lock),'new');
    assert.deepEqual((await redis.lrange(`feed:v2:${user}:1`,0,-1)).map(value=>JSON.parse(value)),[]);
  }finally{await redis.del(lock,`feed:v2:${user}:1`,`feed:v2:published:${user}:1`,versionIndex);await redis.quit();}
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
    const indexLifetime = await redis.pttl(versions);
    assert.ok(indexLifetime > 0 && indexLifetime <= 86_400_000, 'new tracking indexes have a bounded idle lease');
    await redis.pexpire(versions, 1_000);
    await queue.replace(user, current, [entry], 60);
    assert.ok(await redis.pttl(versions) > 1_000, 'writing an existing version refreshes its index lease');
    const orphan = 'feed:v2:version-index:00000000-0000-4000-8000-000000000023';
    await redis.zadd(orphan, 0, '1'); // pre-upgrade index without a queue or reservation
    for (let cycle = 0; cycle < 20 && await redis.pttl(orphan) === -1; cycle++) await queue.scanReservations();
    assert.ok(await redis.pttl(orphan) > 0, 'bounded legacy repair gives abandoned persistent indexes an expiry');
    await redis.pexpire(orphan, 60_000);
    for (let cycle = 0; cycle < 20; cycle++) await queue.scanReservations();
    assert.ok(await redis.pttl(orphan) <= 60_000, 'repair must not perpetually extend an existing expiry');

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

integration('discard and refill atomically retains owner and retires only delivered candidate IDs', async () => {
  const redis = new Redis(process.env.REDIS_TEST_URL ?? 'redis://127.0.0.1:6379/15', { maxRetriesPerRequest: 1 });
  const queue = new RedisFeedQueue(redis, 30_000);
  const user = '00000000-0000-4000-8000-000000000071';
  const request = '00000000-0000-4000-8000-000000000072';
  const token = '00000000-0000-4000-8000-000000000073';
  const other = '00000000-0000-4000-8000-000000000074';
  const entries = [1, 2, 3].map(index => ({ repo_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    score: 1, source: 'semantic', model_version: 'test', summary_id: null }));
  try {
    await redis.flushdb();
    await queue.replace(user, 1n, entries, 60);
    await queue.reserve(user, 1n, request, 2, token);
    await assert.rejects(queue.refill(user, 1n, request, 1, other, [entries[0].repo_id]), ReservationOwnedError);
    const next = await queue.refill(user, 1n, request, 1, token, [entries[0].repo_id]);
    assert.deepEqual(next.items.map(entry => entry.repo_id), [entries[1].repo_id, entries[2].repo_id]);
    await assert.rejects(queue.reserve(user, 1n, request, 1, other), ReservationOwnedError,
      'discard/refill cannot open a same-request claim window');
    assert.equal(await queue.release(user, 1n, request, token), true);
    const restored = await queue.reserve(user, 1n, request, 100, other);
    assert.deepEqual(restored.items.map(entry => entry.repo_id), [entries[1].repo_id, entries[2].repo_id],
      'discarded deliveries must not be restored by release or restart recovery');
    await assert.rejects(queue.refill(user, 1n, request, 1, other, Array(101).fill(entries[0].repo_id)), /bounded/);
  } finally { await redis.flushdb(); await redis.quit(); }
});
