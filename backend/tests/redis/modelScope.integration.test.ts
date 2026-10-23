import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { Redis } from 'ioredis';
import { RedisFeedQueue } from '../../redis/feedQueue.js';
import { FeedReconciliationWorker } from '../../workers/feedReconciliationWorker.js';
const integration=process.env.RUN_REDIS_INTEGRATION==='1'?test:test.skip;
integration('scoped Lua reserve/refill/locks/restart recovery cannot cross two sessions or legacy',async()=>{
 const url=new URL(process.env.REDIS_TEST_URL!);assert.ok(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname==='/15');
 const redis=new Redis(url.toString());const queue=new RedisFeedQueue(redis,30000);
 const a=queue.withScope('a'.repeat(64)),b=queue.withScope('b'.repeat(64));
 const owner=crypto.randomUUID(),request=crypto.randomUUID(),token=crypto.randomUUID();
 const entries=[{repo_id:crypto.randomUUID(),score:1,source:'semantic',model_version:'fixture',summary_id:null}];
 try{
  await redis.flushdb();
  await a.replace(owner,1n,entries,60);await b.replace(owner,1n,[],60);
  assert.equal(await a.acquireGenerationLock(owner,1n,token,30000),true);assert.equal(await b.acquireGenerationLock(owner,1n,token,30000),true);
  assert.equal((await a.reserve(owner,1n,request,1,token)).items.length,1);
  assert.equal((await b.reserve(owner,1n,request,1,token)).items.length,0);
  assert.equal((await queue.reserve(owner,1n,request,1,token)).items.length,0);
  await queue.commit(owner,1n,request,token);await b.commit(owner,1n,request,token);
  // A restarted unscoped scanner must recover the exact scoped namespace.
  const restarted=new RedisFeedQueue(redis,30000);
  let reservations:Awaited<ReturnType<RedisFeedQueue['scanReservations']>>=[];
  for(let i=0;i<20&&!reservations.length;i++)reservations=await restarted.scanReservations();
  assert.equal(reservations.length,1);assert.equal(reservations[0].queueScope,'a'.repeat(64));
  const worker=new FeedReconciliationWorker({getFeedVersion:async()=>1n,hasServe:async()=>true,
   listServedRequests:async requests=>requests},restarted,30000);
  let result={committed:0,released:0};
  for(let i=0;i<20&&!result.committed;i++)result=await worker.runOnce();
  assert.equal(result.committed,1);assert.equal(await a.release(owner,1n,request,token),false);
  assert.equal(await b.depth(owner,1n),0);assert.equal(await queue.depth(owner,1n),0);
 }finally{await redis.flushdb();await redis.quit();}
});
