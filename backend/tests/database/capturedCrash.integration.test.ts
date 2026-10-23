import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { Redis } from 'ioredis';
import { sqlClient as sql } from '../../db/index.js';
import { PostgresFeedPersistence } from '../../adapters/postgresFeedPersistence.js';
import { assertDisposableDatabase } from './disposableDatabase.js';
const enabled=process.env.RUN_DATABASE_INTEGRATION==='1' && process.env.RUN_REDIS_INTEGRATION==='1';
if(enabled)assertDisposableDatabase();
const integration=enabled?test:test.skip;
async function bounded<T>(work:Promise<T>,ms:number,label:string):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}
  finally{clearTimeout(timer);}
}
function message(child:ChildProcess,stage:string):Promise<Record<string,unknown>>{
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(new Error('Fixture stage deadline: '+stage));},10000);
    const receive=(value:unknown)=>{if(value && typeof value==='object' && 'stage' in value && value.stage===stage){cleanup();resolve(value as Record<string,unknown>);}};
    const exit=()=>{cleanup();reject(new Error('Fixture exited before '+stage));};
    const cleanup=()=>{clearTimeout(timer);child.removeListener('message',receive);child.removeListener('exit',exit);};
    child.on('message',receive);child.once('exit',exit);
  });
}
async function stop(child:ChildProcess,signal:'SIGTERM'|'SIGKILL'){
  if(child.exitCode!==null || child.signalCode!==null)return;
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill(signal);
  try{await bounded(exited,5000,'Fixture did not exit');}catch(error){child.kill('SIGKILL');await bounded(exited,5000,'Fixture SIGKILL did not exit');throw error;}
}

integration('SIGKILL at SQL, Redis and serve commits preserves deterministic HTTP retry and one exposure', {timeout:150000},async()=>{
  const redisUrl=new URL(process.env.REDIS_TEST_URL ?? '');
  assert.ok(['127.0.0.1','localhost'].includes(redisUrl.hostname) && redisUrl.pathname==='/15');
  const redis=new Redis(redisUrl.toString(),{maxRetriesPerRequest:1});
  try{for(const stage of ['sql','redis','serve'] as const){
    const user=crypto.randomUUID(),repo=crypto.randomUUID(),suffix=user.replaceAll('-',''),role='crash_writer_'+suffix;
    let seeded=false,roleCreated=false;const children:ChildProcess[]=[];
    try{
      await sql`INSERT INTO auth.users(id) VALUES(${user}::uuid)`;
      await sql`INSERT INTO app.users(user_id,username,status) VALUES(${user}::uuid,${'crash_'+suffix},'active')`;seeded=true;
      await sql`INSERT INTO app.repos(repo_id,github_id,owner,name,full_name,url) VALUES(${repo}::uuid,
        ${String(crypto.randomInt(1_000_000_000,2_000_000_000))}::bigint,'fixture',${repo},${'fixture/'+repo},${'https://github.com/fixture/'+repo})`;
      await sql`INSERT INTO app.repo_content(repo_id,content_version,content_hash) VALUES(${repo}::uuid,1,'fixture-content')`;
      await new PostgresFeedPersistence().recordMlProfileDelivered(user,1n);
      await sql.unsafe(`CREATE ROLE ${role} LOGIN IN ROLE ghsocial_scoring_writer`);roleCreated=true;
      const writer=new URL(process.env.DATABASE_URL!);writer.username=role;writer.password='';
      const environment={...process.env,NODE_ENV:'test',JWT_SECRET:'crash-fixture-jwt',SUPABASE_URL:'http://127.0.0.1:9',SUPABASE_KEY:'crash-fixture-key',
        REDIS_URL:redisUrl.toString(),INTERNAL_API_SECRET:'crash-fixture-internal',ML_FEEDBACK_OUTBOX:'false',TRENDING_FALLBACK:'false',
        ML_V2_RECOMMENDATIONS:'true',FEED_V2:'true',FEED_RESERVATIONS:'true',ML_QDRANT_ONLY:'true',DB_SCHEMA_V2_READS:'true',DB_SCHEMA_V2_WRITES:'true',
        FEED_REFILL_INDEX_READY:'false',FEED_SOCIAL_CANDIDATES_ENABLED:'false',FEED_V2_SHADOW_PERCENT:'0',FEED_RESERVATION_TTL_MS:'30000',
        SCORING_CAPTURE_ENABLED:'true',SCORING_CAPTURE_POLICY_ID:'crash-fixture',SCORING_CAPTURE_POLICY_VERSION:'1',SCORING_CAPTURE_RETENTION_DAYS:'30',
        SCORING_CAPTURE_USER_IDS:user,SCORING_CAPTURE_DATABASE_URL:writer.toString(),SCORING_CAPTURE_CAPABILITY:'crash-fixture-capability-32-chars',
        ML_ONBOARDING_TIMEOUT_MS:'1000',ML_GENERATION_TIMEOUT_MS:'5000',FEED_GENERATION_TIMEOUT_MS:'10000',FEED_FOREGROUND_WAIT_MS:'8000',
        CAPTURE_FIXTURE_USER:user,CAPTURE_FIXTURE_REPO:repo};
      const launch=async(crash:string)=>{
        const child=fork(new URL('../fixtures/capturedCrashChild.ts',import.meta.url),[],{env:{...environment,CAPTURE_CRASH_STAGE:crash},
          execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});children.push(child);
        // Drain bounded diagnostics without retaining private transport bodies.
        child.stdout?.resume();child.stderr?.resume();
        const ready=await message(child,'ready');return {child,origin:`http://127.0.0.1:${ready.port}`};
      };
      const request={feed_request_id:crypto.randomUUID(),session_id:crypto.randomUUID(),limit:1,cursor:null};
      const headers={'content-type':'application/json',authorization:'Bearer '+jwt.sign({userId:user,email:'fixture@example.com'},environment.JWT_SECRET)};
      const post=(origin:string)=>fetch(origin+'/api/v2/feed',{method:'POST',headers,body:JSON.stringify(request),signal:AbortSignal.timeout(12000)});
      const first=await launch(stage),committed=message(first.child,stage);
      const interrupted=post(first.origin).catch(()=>null);
      const boundary=await committed;
      assert.equal(Number((await sql`SELECT count(*) FROM private_scoring.scoring_inputs WHERE user_id=${user}::uuid`)[0].count),1);
      await stop(first.child,'SIGKILL');await interrupted;
      const before=await sql`SELECT exposure_id FROM telemetry.feed_item_provenance WHERE user_id=${user}::uuid`;
      assert.equal(before.length,stage==='serve'?1:0);
      // Production's real minimum lease expires naturally after process death.
      // No DEL/expiry override hides abandoned ownership from the retry.
      if(stage!=='serve'){
        const until=Date.now()+35000,key=`feed:v2:reservation:${user}:1:${request.feed_request_id}:meta`;
        while(await redis.pttl(key)>0){assert.ok(Date.now()<until,'Abandoned reservation did not expire');await delay(100);}
      }
      const retry=await launch('none'),response=await post(retry.origin);
      assert.equal(response.status,200,await response.clone().text());
      const result=await response.json() as {serve_id:string;items:Array<{exposure_id:string}>};
      assert.equal(result.items.length,1);assert.ok(result.items[0].exposure_id);
      if(stage==='serve')assert.equal(result.items[0].exposure_id,boundary.exposure_id);
      assert.equal(Number((await sql`SELECT count(*) FROM telemetry.feed_serves WHERE user_id=${user}::uuid`)[0].count),1);
      assert.equal(Number((await sql`SELECT count(*) FROM telemetry.feed_item_provenance WHERE user_id=${user}::uuid`)[0].count),1);
      const replay=await post(retry.origin);assert.equal(replay.status,200);assert.deepEqual(await replay.json(),result);
      assert.equal(Number((await sql`SELECT count(*) FROM private_scoring.scoring_inputs WHERE user_id=${user}::uuid`)[0].count),stage==='sql'?2:1,
        'only an unpublished SQL orphan needs a fresh generation after restart');
      if(stage==='sql')assert.equal(Number((await sql`SELECT count(*) FROM private_scoring.generation_witnesses WHERE generation_id=${String(boundary.generation_id)}::uuid AND event_type='published'`)[0].count),0);
      await stop(retry.child,'SIGTERM');
    }finally{
      for(const child of children)await stop(child,'SIGKILL');
      const keys=await redis.keys(`*${user}*`);if(keys.length)await redis.del(...keys);
      if(seeded){await sql`DELETE FROM telemetry.feed_item_provenance WHERE user_id=${user}::uuid`;
        await sql`DELETE FROM telemetry.feed_serve_items WHERE serve_id IN (SELECT serve_id FROM telemetry.feed_serves WHERE user_id=${user}::uuid)`;
        await sql`DELETE FROM telemetry.feed_serves WHERE user_id=${user}::uuid`;
        await sql`DELETE FROM auth.users WHERE id=${user}::uuid`;await sql`DELETE FROM app.repos WHERE repo_id=${repo}::uuid`;}
      if(roleCreated)await sql.unsafe(`DROP ROLE ${role}`);
    }
  }}finally{redis.disconnect();await sql.end({timeout:1});}
});
