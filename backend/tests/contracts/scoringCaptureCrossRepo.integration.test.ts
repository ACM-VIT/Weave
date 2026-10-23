import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { Redis } from 'ioredis';
import { sqlClient as sql } from '../../db/index.js';
import { PostgresFeedPersistence } from '../../adapters/postgresFeedPersistence.js';
import { assertDisposableDatabase } from '../database/disposableDatabase.js';

const manifestPath=process.env.SCORING_CAPTURE_PROVIDER_MANIFEST;
test('registered Node feed -> registered Python capture -> actual ranker -> private SQL -> Redis -> durable serve',
  {skip:!manifestPath,timeout:60000},async()=>{
  assertDisposableDatabase();assert.ok(manifestPath && path.isAbsolute(manifestPath));
  const fixture=JSON.parse(await readFile(manifestPath,'utf8'));
  const provider=new URL(fixture.origin),redisUrl=new URL(process.env.REDIS_TEST_URL ?? '');
  assert.ok(provider.protocol==='http:' && ['127.0.0.1','localhost'].includes(provider.hostname));
  assert.ok(['127.0.0.1','localhost'].includes(redisUrl.hostname) && redisUrl.pathname==='/15');
  assert.ok(path.isAbsolute(fixture.actual_tensors_path));
  const release=JSON.parse(await readFile(new URL('../../contracts/ml-contract-release.json',import.meta.url),'utf8'));
  assert.equal(fixture.provider_commit,release.revision);
  const user=String(fixture.user_id),repos=fixture.repo_ids as string[],suffix=crypto.randomBytes(6).toString('hex');
  const role='paired_capture_'+suffix,version=9223372036854775807n;
  const redis=new Redis(redisUrl.toString(),{maxRetriesPerRequest:1});
  let server:Server|undefined,closeRuntime:(()=>Promise<void>)|undefined,disconnectRuntime:(()=>void)|undefined;
  let seeded=false,roleCreated=false;
  const oldEnvironment={...process.env};
  try {
    assert.equal(Number((await sql`SELECT count(*) FROM app.users WHERE user_id=${user}::uuid`)[0].count),0);
    assert.equal(Number((await sql`SELECT count(*) FROM app.repos WHERE repo_id=ANY(${repos}::uuid[])`)[0].count),0);
    await sql`INSERT INTO auth.users(id) VALUES(${user}::uuid)`;
    await sql`INSERT INTO app.users(user_id,username,status,profile_version)
      VALUES(${user}::uuid,${'paired_'+suffix},'active',2)`;seeded=true;
    for(const [index,id] of repos.entries()) {
      await sql`INSERT INTO app.repos(repo_id,github_id,full_name,owner,name,url)
        VALUES(${id}::uuid,${String(crypto.randomInt(1_000_000_000,2_000_000_000))}::bigint,
          ${'fixture/'+id},'fixture',${id},${'https://github.com/fixture/'+id})`;
      await sql`INSERT INTO app.repo_content(repo_id,content_version,content_hash)
        VALUES(${id}::uuid,1,${'a'.repeat(64)})`;
    }
    const persistence=new PostgresFeedPersistence();
    await persistence.getFeedVersion(user);
    await sql`UPDATE app.user_feed_state SET feed_version=${version.toString()}::bigint WHERE user_id=${user}::uuid`;
    await persistence.recordMlProfileDelivered(user,2n);
    await sql.unsafe(`CREATE ROLE ${role} LOGIN IN ROLE ghsocial_scoring_writer`);roleCreated=true;
    const writer=new URL(process.env.DATABASE_URL!);writer.username=role;writer.password='';
    Object.assign(process.env,{NODE_ENV:'test',JWT_SECRET:'paired-fixture-jwt-secret',SUPABASE_URL:'http://127.0.0.1:9',SUPABASE_KEY:'paired-fixture-key',
      REDIS_URL:redisUrl.toString(),ML_SERVICE_URL:fixture.origin,INTERNAL_API_SECRET:fixture.fixture_secret,
      DB_SCHEMA_V2_READS:'true',DB_SCHEMA_V2_WRITES:'true',FEED_V2:'true',FEED_RESERVATIONS:'true',
      ML_V2_RECOMMENDATIONS:'true',ML_FEEDBACK_OUTBOX:'false',ML_QDRANT_ONLY:'true',TRENDING_FALLBACK:'false',
      FEED_REFILL_INDEX_READY:'false',FEED_SOCIAL_CANDIDATES_ENABLED:'false',FEED_V2_SHADOW_PERCENT:'0',
      SCORING_CAPTURE_ENABLED:'true',SCORING_CAPTURE_POLICY_ID:'paired-fixture',SCORING_CAPTURE_POLICY_VERSION:'1',
      SCORING_CAPTURE_RETENTION_DAYS:'30',SCORING_CAPTURE_USER_IDS:user,SCORING_CAPTURE_DATABASE_URL:writer.toString(),
      SCORING_CAPTURE_CAPABILITY:fixture.fixture_capability,SCORING_CAPTURE_WRITE_TIMEOUT_MS:'2000',
      ML_GENERATION_TIMEOUT_MS:'15000',ML_ONBOARDING_TIMEOUT_MS:'1000',FEED_GENERATION_TIMEOUT_MS:'30000',FEED_FOREGROUND_WAIT_MS:'20000'});
    const [{default:app},{getApplicationRuntime,ApplicationRuntime},{default:runtimeRedis}]=await Promise.all([
      import('../../app.js'),import('../../runtime/applicationRuntime.js'),import('../../config/redis.js')]);
    closeRuntime=()=>getApplicationRuntime().supervisor.stop();disconnectRuntime=()=>runtimeRedis.disconnect();
    server=await new Promise<Server>(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
    const address=server.address();assert.ok(address && typeof address==='object');
    const request={feed_request_id:crypto.randomUUID(),session_id:crypto.randomUUID(),limit:5,cursor:null};
    const headers={'content-type':'application/json',authorization:'Bearer '+jwt.sign({userId:user,email:'fixture@example.com'},process.env.JWT_SECRET!)};
    const post=()=>fetch(`http://127.0.0.1:${address.port}/api/v2/feed`,{method:'POST',headers,body:JSON.stringify(request)});
    const response=await post();assert.equal(response.status,200,await response.clone().text());
    const result=await response.json() as {serve_id:string;feed_version:string;items:Array<{repo_id:string;exposure_id:string;generation_id:string}>};
    assert.equal(result.feed_version,version.toString());assert.equal(result.items.length,5);
    assert.ok(result.items.every(item=>item.exposure_id && item.generation_id));
    assert.doesNotMatch(JSON.stringify(result),/input_base64|scoring_context|record_digest|scoring_reference|raw_heavy_score/);
    const replay=await post();assert.equal(replay.status,200);assert.deepEqual(await replay.json(),result);
    const inputs=await sql`SELECT input.input_bytes,generation.context_bytes FROM private_scoring.scoring_inputs input
      JOIN private_scoring.scoring_generations generation USING(generation_id,user_id) WHERE input.user_id=${user}::uuid`;
    assert.ok(inputs.length>=5);
    const actual=JSON.parse(await readFile(fixture.actual_tensors_path,'utf8'));
    const actualRows=new Set<string>((actual.matrices as string[][]).flat());assert.ok(actualRows.size>=inputs.length);
    for(const row of inputs) {
      assert.ok(actualRows.has(row.input_bytes.toString('base64')),'SQL input must equal an actual trained model forward row');
      const context=JSON.parse(row.context_bytes.toString('utf8'));
      assert.equal(context.feed_version,version.toString());assert.equal(context.profile_version,'2');
      assert.equal(context.feedback_version,'3');assert.equal(context.feedback_state_revision,'4');
    }
    const stored=await sql`SELECT count(*) FROM telemetry.feed_item_provenance WHERE serve_id=${result.serve_id}::uuid AND capture_status='captured'`;
    assert.equal(Number(stored[0].count),5);
    const queued=await redis.lrange(`feed:v2:${user}:${version}`,0,-1);
    assert.ok(queued.length);assert.doesNotMatch(queued.join(''),/input_base64|scoring_context|raw_heavy_score/);
    // Default-disabled runtime uses ordinary provider wire and collects no rows.
    process.env.SCORING_CAPTURE_ENABLED='false';
    await sql`UPDATE app.user_feed_state SET feed_version=1 WHERE user_id=${user}::uuid`;
    const ordinary=new ApplicationRuntime();
    try {
      const before=Number((await sql`SELECT count(*) FROM private_scoring.scoring_inputs WHERE user_id=${user}::uuid`)[0].count);
      assert.equal(ordinary.privateScoring,null);
      assert.equal((await ordinary.generation!.generate(user,5)).status,'generated');
      assert.equal(Number((await sql`SELECT count(*) FROM private_scoring.scoring_inputs WHERE user_id=${user}::uuid`)[0].count),before);
      assert.doesNotMatch((await redis.lrange(`feed:v2:${user}:1`,0,-1)).join(''),/scoring_reference|input_base64/);
    } finally {await ordinary.supervisor.stop();}
  } finally {
    server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
    await closeRuntime?.();disconnectRuntime?.();
    const keys=await redis.keys(`*${user}*`);if(keys.length)await redis.del(...keys);redis.disconnect();
    if(seeded){
      await sql`DELETE FROM telemetry.feed_item_provenance WHERE user_id=${user}::uuid`;
      await sql`DELETE FROM telemetry.feed_serve_items WHERE serve_id IN (SELECT serve_id FROM telemetry.feed_serves WHERE user_id=${user}::uuid)`;
      await sql`DELETE FROM telemetry.feed_serves WHERE user_id=${user}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${user}::uuid`;
      await sql`DELETE FROM app.repos WHERE repo_id=ANY(${repos}::uuid[])`;
    }
    if(roleCreated)await sql.unsafe(`DROP ROLE ${role}`);
    for(const key of Object.keys(process.env))if(!(key in oldEnvironment))delete process.env[key];
    Object.assign(process.env,oldEnvironment);await sql.end({timeout:1});
  }
});
