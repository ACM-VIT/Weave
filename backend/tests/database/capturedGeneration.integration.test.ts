import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postgres from 'postgres';
import { Redis } from 'ioredis';
import { sqlClient as sql } from '../../db/index.js';
import { PostgresFeedPersistence } from '../../adapters/postgresFeedPersistence.js';
import { PostgresScoringPersistence } from '../../adapters/postgresScoringPersistence.js';
import { RedisFeedQueue } from '../../redis/feedQueue.js';
import { FeedGenerationService } from '../../services/feedGenerationService.js';
import { FeedV2Service, FeedRequestInProgressError } from '../../services/feedV2Service.js';
import type { ScoringPersistencePort } from '../../ports/scoringPersistencePort.js';
import type { RecommendationPort } from '../../ports/recommendationPort.js';
import type { ScoringCaptureConfig } from '../../config/scoringCapture.js';
import { assertDisposableDatabase } from './disposableDatabase.js';
const enabled = process.env.RUN_DATABASE_INTEGRATION === '1' && process.env.RUN_REDIS_INTEGRATION === '1';
if(enabled) assertDisposableDatabase();
const integration = enabled ? test : test.skip;
const golden = JSON.parse(readFileSync(new URL('../fixtures/scoring-capture-v1.json',import.meta.url),'utf8'));

integration('real SQL precedes Redis publication and mixed generation provenance survives durable replay/recovery', async () => {
  const url = new URL(process.env.REDIS_TEST_URL ?? '');
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname) && url.pathname==='/15');
  const redis = new Redis(url.toString(),{maxRetriesPerRequest:1});
  const queue = new RedisFeedQueue(redis);
  const persistence = new PostgresFeedPersistence();
  const user = crypto.randomUUID(), suffix=user.replaceAll('-',''), repos=[crypto.randomUUID(),crypto.randomUUID()];
  const writerRole = 'pipeline_writer_'+suffix, feedVersion=9007199254740993n;
  let writer: ReturnType<typeof postgres> | undefined, seeded=false, roleCreated=false, selected=0;
  const generations: string[]=[];
  try {
    await sql`INSERT INTO auth.users(id) VALUES(${user}::uuid)`;
    await sql`INSERT INTO app.users(user_id,username,status) VALUES(${user}::uuid,${'pipeline_'+suffix},'active')`;
    seeded=true;
    for(const [index,repo] of repos.entries()) {
      await sql`INSERT INTO app.repos(repo_id,github_id,owner,name,full_name,url)
        VALUES(${repo}::uuid,${String(crypto.randomInt(1_000_000_000,2_000_000_000))}::bigint,
          'fixture',${repo},${'fixture/'+repo},${'https://github.com/fixture/'+repo})`;
      await sql`INSERT INTO app.repo_content(repo_id,content_version,content_hash) VALUES(${repo}::uuid,1,'fixture-content')`;
    }
    await persistence.getFeedVersion(user);
    await sql`UPDATE app.user_feed_state SET feed_version=${feedVersion.toString()}::bigint WHERE user_id=${user}::uuid`;
    await persistence.recordMlProfileDelivered(user,1n);
    await sql.unsafe(`CREATE ROLE ${writerRole} LOGIN IN ROLE ghsocial_scoring_writer`);roleCreated=true;
    const writerUrl = new URL(process.env.DATABASE_URL!);writerUrl.username=writerRole;writerUrl.password='';
    writer=postgres(writerUrl.toString(),{prepare:false,max:2});
    const storage = new PostgresScoringPersistence(writer);
    const config: Extract<ScoringCaptureConfig,{enabled:true}> = {enabled:true,policy:{policyId:'fixture',policyVersion:'1',retentionDays:30},
      userIds:new Set([user]),writerDatabaseUrl:writerUrl.toString(),capability:'7'.repeat(64),writeTimeoutMs:1000};
    const provider: RecommendationPort = { async generate(input,work) {
      assert.equal(input.feed_version,feedVersion.toString());assert.equal(work?.scoringCaptureCapability,config.capability);
      const context={...golden.context,user_id:user,generation_id:input.generation_id,feed_version:input.feed_version};
      const packet=structuredClone(golden.packet);packet.snapshot.repo_id=repos[selected];
      const canonical=(value:object)=>JSON.stringify(value,Object.keys(value).sort());
      packet.binding_sha256=crypto.createHash('sha256').update(Buffer.concat([
        Buffer.from('{"context":'+canonical(context)+',"snapshot":'+canonical(packet.snapshot)+'}'),Buffer.from(packet.input_base64,'base64')])).digest('hex');
      generations.push(input.generation_id);
      return {schema_version:2,generation_id:input.generation_id,user_id:user,feed_version:String(input.feed_version),
        model_version:context.model_version,embedding_version:'fixture-repository-v1',embedding_versions:['fixture-repository-v1'],
        context_status:{cold_start_applied:false,locale:'not_provided'},served_ranker:'heavy',heavy_ranker_selected:true,ranker_applied:true,
        fallback_code:null,fallback_reason:null,retrieval_mode:'personalized',scoring_capture:{schema_version:1,status:'captured'},
        scoring_context:context,scoring_metadata_complete:false,
        items:[{repo_id:repos[selected],score:0.3,raw_heavy_score:0.2,source:'semantic',scored_input:packet}]};
    }};
    const service=(port: ScoringPersistencePort=storage)=>new FeedGenerationService(persistence,queue,provider,600,15000,undefined,{maxQueueDepth:45},false,
      {timeoutMs:5000,repairTimeoutMs:1000},{config,persistence:port});
    let publications=0;
    const append=queue.append.bind(queue);
    queue.append=async(...args)=>{
      assert.equal(Number((await sql`SELECT count(*) FROM private_scoring.scoring_inputs WHERE generation_id=${generations.at(-1)!}::uuid`)[0].count),1,
        'SQL must commit before the real Redis append is called');
      publications++; return append(...args);
    };
    // A private witness outage occurs AFTER actual Redis acceptance. It must
    // not suppress independent product acknowledgement or report failed/zero.
    await sql.unsafe('REVOKE EXECUTE ON FUNCTION private_scoring.record_generation_witness(uuid,uuid,text) FROM ghsocial_scoring_writer');
    try {
      assert.equal((await service().generate(user,1)).status,'generated');
    } finally {
      await sql.unsafe('GRANT EXECUTE ON FUNCTION private_scoring.record_generation_witness(uuid,uuid,text) TO ghsocial_scoring_writer');
    }
    const publishedAttempt=(await sql`SELECT status,result_count FROM telemetry.generation_attempts WHERE generation_id=${generations.at(-1)!}::uuid`)[0];
    assert.equal(publishedAttempt.status,'completed');assert.equal(publishedAttempt.result_count,1);
    assert.equal(await persistence.hasPublishedGeneration(user,feedVersion),true);
    assert.equal(Number((await sql`SELECT count(*) FROM private_scoring.generation_witnesses WHERE generation_id=${generations.at(-1)!}::uuid AND event_type='published'`)[0].count),0);
    assert.equal(await storage.reconcilePublicationWitnesses([user],1),1);
    assert.equal(await storage.reconcilePublicationWitnesses([user],1),0,'repair is idempotent');
    assert.equal(Number((await sql`SELECT count(*) FROM private_scoring.generation_witnesses WHERE generation_id=${generations.at(-1)!}::uuid AND event_type='published'`)[0].count),1);
    assert.equal(publications,1);
    const firstGeneration=generations.at(-1)!;
    const keys=await redis.keys(`*${user}*`); if(keys.length) await redis.del(...keys);
    // Actual SQL authorization failure after preflight cannot publish anything.
    await sql.unsafe(`REVOKE ghsocial_scoring_writer FROM ${writerRole}`);
    await assert.rejects(service().generate(user,1),/SCORING_PERSISTENCE_UNAVAILABLE/);
    assert.equal(publications,1); assert.equal(await queue.depth(user,feedVersion),0);
    assert.equal(Number((await sql`SELECT count(*) FROM private_scoring.scoring_inputs WHERE generation_id=${generations.at(-1)!}::uuid`)[0].count),0);
    await sql.unsafe(`GRANT ghsocial_scoring_writer TO ${writerRole}`);
    // A real feed-state race after the private commit leaves an explicit stale
    // witness and no Redis publication; an old builder cannot cross namespaces.
    const raced: ScoringPersistencePort = {
      recordWitness: storage.recordWitness.bind(storage),
      reconcilePublicationWitnesses: storage.reconcilePublicationWitnesses.bind(storage),
      async persist(...args) {
        const result=await storage.persist(...args);
        await sql`UPDATE app.user_feed_state SET feed_version=feed_version+1 WHERE user_id=${user}::uuid`;
        return result;
      },
    };
    assert.equal((await service(raced).generate(user,1)).status,'stale');
    assert.equal(publications,1);assert.equal(await queue.depth(user,feedVersion),0);
    assert.equal(Number((await sql`SELECT count(*) FROM private_scoring.generation_witnesses
      WHERE generation_id=${generations.at(-1)!}::uuid AND event_type='stale'`)[0].count),1);
    await sql`UPDATE app.user_feed_state SET feed_version=${feedVersion.toString()}::bigint WHERE user_id=${user}::uuid`;
    const lostLease: ScoringPersistencePort = {
      recordWitness: storage.recordWitness.bind(storage),
      reconcilePublicationWitnesses: storage.reconcilePublicationWitnesses.bind(storage),
      async persist(...args) {
        const result=await storage.persist(...args);
        await redis.del(`feed:v2:generation-lock:${user}:${feedVersion}`);
        return result;
      },
    };
    assert.equal((await service(lostLease).generate(user,1)).status,'coalesced');
    assert.equal(await queue.depth(user,feedVersion),0,'Redis itself fences a lock lost after SQL commit');
    assert.equal(Number((await sql`SELECT count(*) FROM private_scoring.generation_witnesses
      WHERE generation_id=${generations.at(-1)!}::uuid AND event_type='published'`)[0].count),0);
    assert.equal(await storage.reconcilePublicationWitnesses([user],100),0,'a committed private orphan without publication proof stays unpublished');
    // Append two independently captured sets, then deliver one mixed page.
    await service().generate(user,1); const generationA=generations.at(-1)!;
    selected=1; await service().generate(user,1); const generationB=generations.at(-1)!;
    assert.notEqual(generationA,generationB);assert.notEqual(generationA,firstGeneration);
    const serialized=await redis.lrange(`feed:v2:${user}:${feedVersion}`,0,-1);
    assert.equal(serialized.length,2);
    assert.doesNotMatch(serialized.join(''),/input_base64|scoring_context|raw_heavy_score|input_bytes/);
    const request={feed_request_id:crypto.randomUUID(),session_id:crypto.randomUUID(),limit:2,cursor:null};
    const feed=new FeedV2Service(persistence,queue,undefined,false,1500,25,'fixture-cursor-secret',5000,undefined,()=>true);
    const delivered=await feed.getFeed(user,request);
    assert.deepEqual(delivered.items.map(item=>item.generation_id),[generationA,generationB]);
    assert.ok(delivered.items.every(item=>item.exposure_id));
    assert.doesNotMatch(JSON.stringify(delivered),/record_digest|scoring_reference|input_base64|scoring_context/);
    const replay=await feed.getFeed(user,request);
    assert.deepEqual(replay.items.map(item=>[item.generation_id,item.exposure_id]),delivered.items.map(item=>[item.generation_id,item.exposure_id]));
    const historical=await persistence.getRecentPersonalizedEntries(user,feedVersion,2,[],crypto.randomUUID());
    assert.deepEqual(historical.map(item=>item.generation_id),[generationA,generationB]);
    assert.ok(historical.every(item=>item.scoring_reference?.generation_id===item.generation_id));
    for(const generation of [generationA,generationB]) {
      assert.deepEqual((await sql`SELECT input_bytes FROM private_scoring.scoring_inputs WHERE generation_id=${generation}::uuid`)[0].input_bytes,
        Buffer.from(golden.packet.input_base64,'base64'));
      assert.equal(Number((await sql`SELECT count(*) FROM private_scoring.generation_witnesses WHERE generation_id=${generation}::uuid AND event_type='published'`)[0].count),1);
    }
    // Serve proof alone repairs a lost marker, without relying on generation
    // attempt retention. The other captured marker proves the batch cap.
    await sql`DELETE FROM private_scoring.generation_witnesses WHERE generation_id=ANY(${[generationA,generationB]}::uuid[]) AND event_type='published'`;
    await sql`DELETE FROM telemetry.generation_attempts WHERE generation_id=ANY(${[generationA,generationB]}::uuid[])`;
    assert.equal(await storage.reconcilePublicationWitnesses([user],1),1);
    assert.equal(await storage.reconcilePublicationWitnesses([user],1),1);
    assert.equal(await storage.reconcilePublicationWitnesses([user],1),0);
    for(const role of ['ghsocial_backend','ghsocial_scoring_exporter','ghsocial_scoring_retention']) {
      assert.equal((await sql`SELECT has_function_privilege(${role},'private_scoring.reconcile_publication_witnesses(uuid[],integer)','EXECUTE') AS allowed`)[0].allowed,false);
    }
    // A transient database lock failure inside reference validation is not a
    // permanent invalid packet: release the same queue entry for a later retry.
    selected=0;await service().generate(user,1);const temporarilyBlocked=generations.at(-1)!;
    let held!:()=>void,releaseHeld!:()=>void;
    const heldReady=new Promise<void>(resolve=>held=resolve),continueHeld=new Promise<void>(resolve=>releaseHeld=resolve);
    const holding=sql.begin(async tx=>{
      await tx`SELECT generation_id FROM private_scoring.scoring_generations WHERE generation_id=${temporarilyBlocked}::uuid FOR UPDATE`;
      held();await continueHeld;
    });
    await heldReady;
    const blockedRequest={feed_request_id:crypto.randomUUID(),session_id:crypto.randomUUID(),limit:1,cursor:null};
    try {
      await sql.unsafe("ALTER FUNCTION private_scoring.validate_feed_item_provenance() SET lock_timeout='100ms'");
      await assert.rejects(feed.getFeed(user,blockedRequest));
      assert.equal(await queue.depth(user,feedVersion),1,'temporary SQL failure must preserve the unserved reference');
    } finally {
      releaseHeld();await holding;
      await sql.unsafe('ALTER FUNCTION private_scoring.validate_feed_item_provenance() RESET lock_timeout');
    }
    const afterTemporary=await feed.getFeed(user,blockedRequest);
    assert.equal(afterTemporary.items[0].generation_id,temporarilyBlocked,'retry uses the original valid capture without rescoring');
    // A permanent private-reference failure must retire only the unserved
    // reservation, then let a fresh request regenerate. No impression/seen
    // state may be invented for a valid neighbour in the rejected batch.
    for(const failure of ['revoked','expired','purged'] as const) {
      selected=0;await service().generate(user,1);const invalidGeneration=generations.at(-1)!;
      selected=1;await service().generate(user,1);
      if(failure==='revoked')await sql`INSERT INTO private_scoring.generation_witnesses(generation_id,event_type) VALUES(${invalidGeneration}::uuid,'revoked')`;
      else if(failure==='purged')await sql`DELETE FROM private_scoring.scoring_generations WHERE generation_id=${invalidGeneration}::uuid`;
      else await sql.begin(async tx=>{
        await tx.unsafe('SET LOCAL session_replication_role=replica');
        await tx`UPDATE private_scoring.scoring_generations SET created_at=created_at-interval '31 days',expires_at=expires_at-interval '31 days'
          WHERE generation_id=${invalidGeneration}::uuid`;
      });
      const recovering=new FeedV2Service(persistence,queue,(owner,limit,excluded,session)=>service().generate(owner,limit,excluded,'live',session),
        false,1500,25,'fixture-cursor-secret',5000,undefined,()=>true);
      const rejectedRequest={feed_request_id:crypto.randomUUID(),session_id:crypto.randomUUID(),limit:2,cursor:null};
      await assert.rejects(recovering.getFeed(user,rejectedRequest),FeedRequestInProgressError);
      const remaining=await queue.depth(user,feedVersion);
      assert.equal(await persistence.getServeByRequest(user,rejectedRequest.feed_request_id),null);
      assert.equal(Number((await sql`SELECT count(*) FROM telemetry.user_repo_engagement WHERE user_id=${user}::uuid`)[0].count),0,
        'unshown cards must not become impressions/seen exclusions');
      const retryRequest={...rejectedRequest,feed_request_id:crypto.randomUUID(),limit:1};
      const retry=await recovering.getFeed(user,retryRequest).then(value=>({value}),error=>({error}));
      assert.equal(remaining,0,failure+' references must not be released back to the queue');
      assert.ok('value' in retry,failure+' must allow the next request to regenerate rather than repeat409');
      if('value' in retry){
        assert.equal(retry.value.items[0].repo_id,repos[1]);
        assert.notEqual(retry.value.items[0].generation_id,invalidGeneration);
        assert.deepEqual(await recovering.getFeed(user,retryRequest),retry.value);
      }
      assert.deepEqual((await feed.getFeed(user,request)).items.map(item=>item.exposure_id),delivered.items.map(item=>item.exposure_id),
        'permanent queue retirement cannot rewrite an earlier immutable serve');
    }
  } finally {
    const keys=await redis.keys(`*${user}*`);if(keys.length)await redis.del(...keys);redis.disconnect();
    await writer?.end();
    if(seeded) {
      await sql`DELETE FROM telemetry.feed_item_provenance WHERE user_id=${user}::uuid`;
      await sql`DELETE FROM telemetry.feed_serve_items WHERE serve_id IN (SELECT serve_id FROM telemetry.feed_serves WHERE user_id=${user}::uuid)`;
      await sql`DELETE FROM telemetry.feed_serves WHERE user_id=${user}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${user}::uuid`;
      await sql`DELETE FROM app.repos WHERE repo_id=ANY(${repos}::uuid[])`;
    }
    if(roleCreated)await sql.unsafe(`DROP ROLE ${writerRole}`);
    await sql.end({timeout:1});
  }
});
