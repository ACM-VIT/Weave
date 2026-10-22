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
  const user='generation-fence-test';const lock=`feed:v2:generation-lock:${user}:1`;
  const latest=[{repo_id:'latest-repo',score:1,source:'semantic',model_version:'test',summary_id:null}];
  try{
    await redis.del(lock,`feed:v2:${user}:1`,`feed:v2:published:${user}:1`);
    assert.equal(await queue.acquireGenerationLock(user,1n,'old',1000),true);
    await redis.pexpire(lock,0); // Deterministically expire the old lease.
    assert.equal(await queue.acquireGenerationLock(user,1n,'new',1000),true);
    assert.equal(await queue.renewGenerationLock(user,1n,'old',5000),false);
    assert.equal(await queue.renewGenerationLock(user,1n,'new',5000),true);
    assert.ok(await redis.pttl(lock)>1000);
    assert.equal(await queue.publishGeneration(user,1n,'new',latest,60),true);
    assert.equal(await queue.publishGeneration(user,1n,'old',[],60),false);
    assert.equal(await queue.hasPublishedGeneration(user,1n),true);
    await redis.del(`feed:v2:${user}:1`); // Consumed list does not remove success.
    assert.equal(await queue.publishGeneration(user,1n,'new',latest,60,true),false);
    assert.equal(await queue.depth(user,1n),0);
    assert.equal(await queue.publishGeneration(user,1n,'new',[],60),true);
    assert.equal(await queue.hasPublishedGeneration(user,1n),true);
    assert.equal(await queue.publishGeneration(user,1n,'new',latest,60,true),false);
    await queue.releaseGenerationLock(user,1n,'old');assert.equal(await redis.get(lock),'new');
    assert.deepEqual((await redis.lrange(`feed:v2:${user}:1`,0,-1)).map(value=>JSON.parse(value)),[]);
  }finally{await redis.del(lock,`feed:v2:${user}:1`,`feed:v2:published:${user}:1`);await redis.quit();}
});
