import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {Redis} from 'ioredis';
import {RedisFeedQueue} from '../../redis/feedQueue.js';
const integration=process.env.RUN_REDIS_INTEGRATION==='1'?test:test.skip;
integration('release restores a fully drained scoped queue with its bounded expiry and exact order',async()=>{
 const url=new URL(process.env.REDIS_TEST_URL!);assert.ok(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname==='/15');
 const redis=new Redis(url.toString()),owner=crypto.randomUUID(),scope=crypto.randomBytes(32).toString('hex'),request=crypto.randomUUID(),token=crypto.randomUUID();
 const queue=new RedisFeedQueue(redis,30000).withScope(scope),key=`feed:v3:${scope}:${owner}:1`;
 const entries=[1,2].map(score=>({repo_id:crypto.randomUUID(),score,source:'semantic',model_version:'fixture',summary_id:null}));
 try{
  await queue.replace(owner,1n,entries,60);await redis.pexpire(key,5000);
  const reserved=await queue.reserve(owner,1n,request,2,token);assert.deepEqual(reserved.items,entries);assert.equal(await redis.exists(key),0);
  assert.equal(await queue.release(owner,1n,request,'foreign'),false);assert.equal(await redis.exists(key),0);
  assert.equal(await queue.release(owner,1n,request,token),true);const ttl=await redis.pttl(key);assert.ok(ttl>0&&ttl<=5000,`bounded restored ttl ${ttl}`);
  assert.deepEqual((await redis.lrange(key,0,-1)).map(item=>JSON.parse(item)),entries);
  assert.equal(await queue.release(owner,1n,request,token),false);
 }finally{const keys=await redis.keys(`feed:v3:${scope}:*`);if(keys.length)await redis.del(...keys);await redis.quit();}
});
for(const [initialMs,refillMs] of [[60000,5000],[2000,20000]])integration(`refill records changed absolute queue deadline ${initialMs} to ${refillMs} before draining its last item`,async()=>{
 const url=new URL(process.env.REDIS_TEST_URL!);assert.ok(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname==='/15');
 const redis=new Redis(url.toString()),owner=crypto.randomUUID(),scope=crypto.randomBytes(32).toString('hex'),request=crypto.randomUUID(),token=crypto.randomUUID();
 const queue=new RedisFeedQueue(redis,30000).withScope(scope),key=`feed:v3:${scope}:${owner}:1`;
 const entries=[1,2].map(score=>({repo_id:crypto.randomUUID(),score,source:'semantic',model_version:'fixture',summary_id:null}));
 try{
  await queue.replace(owner,1n,entries,60);await redis.pexpire(key,initialMs);await queue.reserve(owner,1n,request,1,token);
  await redis.pexpire(key,refillMs);const deadline=Number(await redis.call('PEXPIRETIME',key));
  assert.deepEqual((await queue.refill(owner,1n,request,1,token)).items,entries);assert.equal(await redis.exists(key),0);
  assert.equal(await queue.release(owner,1n,request,token),true);
  const restored=Number(await redis.call('PEXPIRETIME',key));assert.ok(Math.abs(restored-deadline)<=5,`original refill deadline ${deadline} restored ${restored}`);
  assert.deepEqual((await redis.lrange(key,0,-1)).map(item=>JSON.parse(item)),entries);
 }finally{const keys=await redis.keys(`feed:v3:${scope}:*`);if(keys.length)await redis.del(...keys);await redis.quit();}
});
