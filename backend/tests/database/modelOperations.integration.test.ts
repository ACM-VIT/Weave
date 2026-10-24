import {PostgresFeedPersistence} from '../../adapters/postgresFeedPersistence.js';
import type {FeedIntentScope} from '../../contracts/feedIntent.js';
import {OutboxService} from '../../services/outboxService.js';
import {RetentionWorker} from '../../workers/retentionWorker.js';
import {OutboxWorker} from '../../workers/outboxWorker.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { sqlClient } from '../../db/index.js';
import { appendModelOperation,lockModelLane,enqueueModelProfile,sequencePendingModelFeedback,withdrawPendingProfiles } from '../../services/modelOperationService.js';
import { FeedIntentSessionService } from '../../services/feedIntentSessionService.js';
import { canonicalJson,modelDigest } from '../../contracts/modelOperations.js';
import { buildMlOnboardingJob } from '../../services/mlOnboardingService.js';
import { processInteractionBatchV2,processInteractionBatchV2InTransaction } from '../../services/activityV2Service.js';
import { assertDisposableDatabase } from './disposableDatabase.js';
const enabled=process.env.RUN_MODEL_OPERATION_INTEGRATION==='1';
if(enabled)assertDisposableDatabase();
const integration=enabled?test:test.skip;
const owners:string[]=[];
const policy='a'.repeat(64);
const controls=new FeedIntentSessionService();
async function fixture(initialized=true){
  const id=crypto.randomUUID();owners.push(id);
  await sqlClient`INSERT INTO auth.users(id) VALUES(${id}::uuid)`;
  await sqlClient`INSERT INTO app.users(user_id,username,status) VALUES(${id}::uuid,${'model_'+id},'active')`;
  await sqlClient`INSERT INTO app.user_feed_state(user_id,model_policy_sha256,model_policy_limits,model_initialized)
    VALUES(${id}::uuid,${policy},${JSON.stringify({input_bytes:131072,max_sessions:2,generation_freshness_ms:10000,idle_expiry_ms:60000})}::jsonb,${initialized})`;
  return id;
}
async function append(owner:string,key:string,fail=false){
 return sqlClient.begin(async tx=>{
   await tx`SELECT user_id FROM app.users WHERE user_id=${owner}::uuid FOR KEY SHARE`;
   const lane=await lockModelLane(tx,owner);assert.ok(lane);
   const result=await appendModelOperation(tx,lane,key,{kind:'test',key},()=>({kind:'feedback',operation:{original_feedback_json:'{ "opaque": "Tarun Ω" }'}}));
   if(fail)throw new Error('rollback');return result;
 });
}
test.after(async()=>{
 if(!enabled)return;
 await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=ANY(${owners}::uuid[])`;
 await sqlClient`DELETE FROM app.users WHERE user_id=ANY(${owners}::uuid[])`;
 await sqlClient`DELETE FROM auth.users WHERE id=ANY(${owners}::uuid[])`;
 await sqlClient.end({timeout:1});
});
integration('same-owner KEY SHARE waiters allocate gap-free operations and duplicate source exactly',async()=>{
 const owner=await fixture();
 const results=await Promise.all(Array.from({length:12},(_,i)=>append(owner,'test:'+i)));
 assert.deepEqual(results.map(r=>BigInt(r.operation.version)).sort((a,b)=>a<b?-1:1),Array.from({length:12},(_,i)=>BigInt(i+1)));
 const before=results[4].operation;
 const replay=await append(owner,'test:4');assert.equal(replay.reused,true);assert.deepEqual(replay.operation,before);
 assert.equal(modelDigest(before.operationJson),before.sourceSha256);
 assert.equal(JSON.parse(before.operationJson).operation.original_feedback_json,'{ "opaque": "Tarun Ω" }');
 await assert.rejects(append(owner,'rollback',true),/rollback/);
 assert.equal((await append(owner,'next')).operation.version,'13');
});
integration('frozen source and common versions cannot be changed or superseded',async()=>{
 const owner=await fixture();const result=await append(owner,'immutable');
 await assert.rejects(sqlClient`UPDATE telemetry.ml_outbox SET operation_json='{}' WHERE outbox_id=${result.operation.operationId}::uuid`,/IMMUTABLE/);
 await assert.rejects(sqlClient`UPDATE telemetry.ml_outbox SET status='superseded' WHERE outbox_id=${result.operation.operationId}::uuid`,/CANNOT_SKIP/);
 assert.equal((await append(owner,'immutable')).operation.operationJson,result.operation.operationJson);
});
integration('two-device controls seal old epochs, permanently retire UUIDs, and reuse exact control retries',async()=>{
 const owner=await fixture();const other=await fixture();const first=crypto.randomUUID(),second=crypto.randomUUID();
 const begin={kind:'begin' as const,request_id:crypto.randomUUID(),session_id:first};
 const started=await controls.control(owner,begin);
 await controls.control(owner,{kind:'begin',request_id:crypto.randomUUID(),session_id:second});
 await assert.rejects(controls.control(owner,{kind:'begin',request_id:crypto.randomUUID(),session_id:crypto.randomUUID()}),/CAPACITY/);
 const reset=await controls.control(owner,{kind:'reset',request_id:crypto.randomUUID(),session_id:first,expected_epoch:'1'});
 assert.equal(reset.session.epoch,'2');assert.notEqual(reset.session.witnessSha256,started.session.witnessSha256);
 const replay=await controls.control(owner,begin);assert.deepEqual(replay.operation,started.operation);assert.equal(replay.session.epoch,'2');
 await assert.rejects(controls.control(other,{kind:'begin',request_id:crypto.randomUUID(),session_id:first}),/UNAVAILABLE/);
 await assert.rejects(controls.control(owner,{kind:'reset',request_id:crypto.randomUUID(),session_id:first,expected_epoch:'1'}),/STALE/);
 const ended=await controls.control(owner,{kind:'end',request_id:crypto.randomUUID(),session_id:first,expected_epoch:'2'});
 assert.equal(ended.session.status,'retired');assert.notEqual(ended.session.witnessSha256,reset.session.witnessSha256);
 await assert.rejects(controls.control(owner,{kind:'begin',request_id:crypto.randomUUID(),session_id:first}),/UNAVAILABLE/);
 await controls.control(owner,{kind:'begin',request_id:crypto.randomUUID(),session_id:crypto.randomUUID()});
 await sqlClient`DELETE FROM app.users WHERE user_id=${owner}::uuid`;
 const [tombstone]=await sqlClient`SELECT user_id,status FROM telemetry.feed_intent_sessions WHERE session_id=${first}::uuid`;
 assert.equal(tombstone.user_id,null);assert.equal(tombstone.status,'retired');
 await assert.rejects(controls.control(other,{kind:'begin',request_id:crypto.randomUUID(),session_id:first}),/UNAVAILABLE/);
});
integration('pre-genesis Begin refuses and profile retry retains original job and Unicode bytes',async()=>{
 const owner=await fixture(false);
 await assert.rejects(controls.control(owner,{kind:'begin',request_id:crypto.randomUUID(),session_id:crypto.randomUUID()}),/PROFILE_PENDING/);
 const job=buildMlOnboardingJob(owner,1,{username:'Tarun',bio:'Ω and Rust'});
 await sqlClient.begin(async tx=>{await tx`SELECT user_id FROM app.users WHERE user_id=${owner}::uuid FOR UPDATE`;const lane=await lockModelLane(tx,owner);assert.ok(lane);
   assert.equal(await enqueueModelProfile(tx,lane,job),true);assert.equal(await enqueueModelProfile(tx,lane,{...job,job_id:crypto.randomUUID()}),false);});
 const [row]=await sqlClient`SELECT operation_json FROM telemetry.ml_outbox WHERE aggregate_id=${owner}::uuid`;
 const envelope=JSON.parse(row.operation_json);assert.equal(envelope.operation.job_id,job.job_id);assert.equal(envelope.operation.allow_genesis,true);
 assert.equal(row.operation_json,canonicalJson(envelope));
});

integration('real product feedback remains durable before genesis and drains once in original feedback order',async()=>{
 const owner=await fixture(false),repo=crypto.randomUUID();
 await sqlClient`INSERT INTO app.user_stats(user_id) VALUES(${owner}::uuid)`;
 await sqlClient`INSERT INTO app.repos(repo_id,github_id,full_name,owner,name,url,status)
   VALUES(${repo}::uuid,${Date.now()}::bigint,${'fixture/'+repo},'fixture',${repo},${'https://github.com/fixture/'+repo},'active')`;
 try{
 const event={event_id:crypto.randomUUID(),schema_version:2 as const,session_id:crypto.randomUUID(),serve_id:null,
   repo_id:repo,position:null,event_type:'like' as const,dwell_ms:null,client_occurred_at:'2026-10-20T12:00:00.000Z',context:{}};
 const result=await processInteractionBatchV2(owner,[event]);assert.equal(result.results[0].feedback_version,'1');
 await processInteractionBatchV2(owner,[event]);
 const pending=await sqlClient`SELECT * FROM telemetry.pending_model_feedback WHERE user_id=${owner}::uuid`;
 assert.equal(pending.length,1);assert.equal(pending[0].operation_id,null);
 assert.equal(JSON.parse(pending[0].original_feedback_json).feedback_version,'1');
 assert.equal((await sqlClient`SELECT 1 FROM telemetry.ml_outbox WHERE aggregate_id=${owner}::uuid`).length,0);
 await sqlClient.begin(async tx=>{
   await tx`SELECT user_id FROM app.users WHERE user_id=${owner}::uuid FOR KEY SHARE`;
   const lane=await lockModelLane(tx,owner);assert.ok(lane);
   await enqueueModelProfile(tx,lane,buildMlOnboardingJob(owner,1,{username:'Tarun',bio:'Rust'}));
   // This checks the drain primitive only; real applied-authority gating has its own HTTP suite.
   await sequencePendingModelFeedback(tx,lane);await sequencePendingModelFeedback(tx,lane);
 });
 const rows=await sqlClient`SELECT operation_json FROM telemetry.ml_outbox WHERE aggregate_id=${owner}::uuid ORDER BY model_operation_version`;
 assert.deepEqual(rows.map(row=>JSON.parse(row.operation_json).kind),['profile','feedback']);
 const frozen=JSON.parse(rows[1].operation_json);assert.equal(frozen.operation.original_feedback_json,pending[0].original_feedback_json);
 assert.equal(frozen.accepted_at_ms,String(pending[0].accepted_at_ms));
 assert.equal('canonical_attribution' in frozen.operation,false);
 const retention=new RetentionWorker();
 await sqlClient`UPDATE app.user_feed_state SET model_initialized=true WHERE user_id=${owner}::uuid`;
 let unlock!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>started=r),release=new Promise<void>(r=>unlock=r);
 const delivering=sqlClient.begin(async tx=>{
  await tx`UPDATE telemetry.ml_outbox SET status='delivered',delivered_at=now()-interval '40 days' WHERE aggregate_id=${owner}::uuid`;started();await release;
 });
 await ready;
 try{await retention.pruneModelCopies();assert.equal((await sqlClient`SELECT 1 FROM telemetry.pending_model_feedback WHERE user_id=${owner}::uuid`).length,1);}
 finally{unlock();await delivering;}
 await retention.runOnce();
 assert.equal((await sqlClient`SELECT 1 FROM telemetry.pending_model_feedback WHERE user_id=${owner}::uuid`).length,0);
 assert.deepEqual((await sqlClient`SELECT operation_json FROM telemetry.ml_outbox WHERE aggregate_id=${owner}::uuid ORDER BY model_operation_version`).map(r=>r.operation_json),rows.map(r=>r.operation_json));

 }finally{await sqlClient`DELETE FROM telemetry.pending_model_feedback WHERE user_id=${owner}::uuid`;await sqlClient`DELETE FROM telemetry.interaction_events WHERE user_id=${owner}::uuid`;await sqlClient`DELETE FROM app.repos WHERE repo_id=${repo}::uuid`;}
});

integration('unregistered nonzero legacy feedback history refuses implicit model genesis',async()=>{
 const owner=await fixture(false);
 await sqlClient`UPDATE app.user_feed_state SET feedback_version=1 WHERE user_id=${owner}::uuid`;
 await assert.rejects(sqlClient.begin(async tx=>{
  await tx`SELECT user_id FROM app.users WHERE user_id=${owner}::uuid FOR KEY SHARE`;
  await lockModelLane(tx,owner);
 }),/MODEL_CUTOVER_REQUIRED/);
 assert.equal((await sqlClient`SELECT 1 FROM telemetry.ml_outbox WHERE aggregate_id=${owner}::uuid`).length,0);
});

integration('dead common predecessor blocks ordinary jobs while source-bound withdrawal bypasses dispatch without raw context',async()=>{
 const owner=await fixture();const lower=await append(owner,'blocked-feedback');
 await sqlClient`UPDATE telemetry.ml_outbox SET status='dead' WHERE outbox_id=${lower.operation.operationId}::uuid`;
 let original='';
 await sqlClient.begin(async tx=>{
  await tx`SELECT user_id FROM app.users WHERE user_id=${owner}::uuid FOR KEY SHARE`;
  const lane=await lockModelLane(tx,owner);assert.ok(lane);
  await enqueueModelProfile(tx,lane,buildMlOnboardingJob(owner,2,{username:'Tarun',bio:'PRIVATE_REVOKED_PROFILE'}));
  const [row]=await tx`SELECT operation_json FROM telemetry.ml_outbox WHERE aggregate_id=${owner}::uuid AND model_operation_version=2`;
  original=row.operation_json;await withdrawPendingProfiles(tx,lane,'2');
 });
 const outbox=new OutboxService();const claimed=(await outbox.claim(100,undefined,{jobTypes:['model_operation']})).find(row=>row.aggregate_id===owner);
 assert.ok(claimed);assert.equal(String(claimed.model_operation_version),'2');assert.equal(claimed.operation_json,original);
 assert.doesNotMatch(claimed.withdrawal_json!,/PRIVATE_REVOKED_PROFILE/);
 let sent='';
 const unavailable=async()=>({accepted:false,retryable:true,status_code:503});
 const worker=new OutboxWorker(outbox,{deliverFeedback:unavailable,deliverOnboarding:unavailable,deliverRepositoryIndex:unavailable,deliverRepositoryRefresh:unavailable,
  deliverModelOperations:async()=>{throw new Error('Revoked original was forwarded');},
  deliverProfileWithdrawals:async batch=>{
   sent=batch.withdrawals[0].withdrawal_json;
   return {accepted:true,retryable:false,status_code:202,response_body:{schema_version:1,withdrawals:[{
    operation_id:claimed.outbox_id,model_operation_version:String(claimed.model_operation_version),source_envelope_sha256:claimed.source_envelope_sha256!,
    withdrawal_sha256:modelDigest(sent),status:'accepted'}]}};
  }});
 assert.equal((await worker.deliverClaimed(claimed)).accepted,true);assert.equal(sent,claimed.withdrawal_json);
 await append(owner,'still-blocked');
 assert.equal((await outbox.claim(100,undefined,{jobTypes:['model_operation']})).filter(row=>row.aggregate_id===owner).length,0);
 assert.equal((await sqlClient`SELECT status FROM telemetry.ml_outbox WHERE outbox_id=${lower.operation.operationId}::uuid`)[0].status,'dead');
});

integration('SQL constraint details cannot expose frozen profile source through new-lane errors',async()=>{
 const owner=await fixture();
 await sqlClient.unsafe(`CREATE FUNCTION telemetry.model_fixture_reject() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION USING MESSAGE='fixture failure',DETAIL='PRIVATE_PROFILE_CONSTRAINT_DETAIL';END $$`);
 await sqlClient.unsafe('CREATE TRIGGER model_fixture_reject BEFORE INSERT ON telemetry.ml_outbox FOR EACH ROW EXECUTE FUNCTION telemetry.model_fixture_reject()');
 try{
  await assert.rejects(sqlClient.begin(async tx=>{
   await tx`SELECT user_id FROM app.users WHERE user_id=${owner}::uuid FOR KEY SHARE`;
   const lane=await lockModelLane(tx,owner);assert.ok(lane);
   await enqueueModelProfile(tx,lane,buildMlOnboardingJob(owner,1,{username:'Tarun',bio:'PRIVATE_PROFILE_CONSTRAINT_DETAIL'}));
  }),error=>{
   assert.doesNotMatch(String(error)+JSON.stringify(error),/PRIVATE_PROFILE_CONSTRAINT_DETAIL/);
   assert.equal('cause' in (error as Error),false);return /MODEL_OPERATION_UNAVAILABLE/.test(String(error));
  });
 }finally{
  await sqlClient.unsafe('DROP TRIGGER model_fixture_reject ON telemetry.ml_outbox');
  await sqlClient.unsafe('DROP FUNCTION telemetry.model_fixture_reject()');
 }
});

integration('only identity-bound applied proof suppresses historical profile withdrawal',async()=>{
 const owner=await fixture();
 await sqlClient.begin(async tx=>{
  await tx`SELECT user_id FROM app.users WHERE user_id=${owner}::uuid FOR KEY SHARE`;
  const lane=await lockModelLane(tx,owner);assert.ok(lane);
  for(let version=1;version<=3;version++)await enqueueModelProfile(tx,lane,buildMlOnboardingJob(owner,version,{username:'Tarun',bio:'Rust '+version}));
 });
 const originals=await sqlClient`SELECT outbox_id,source_envelope_sha256,model_operation_version FROM telemetry.ml_outbox WHERE aggregate_id=${owner}::uuid ORDER BY model_operation_version`;
 for(const [index,row] of originals.entries()){
  const proof={model_profile_applied:true,status:'applied',basis_status:'ready',operation_id:String(row.outbox_id),model_operation_version:String(row.model_operation_version),
   applied_profile_version:String(row.model_operation_version),source_envelope_sha256:index===0?'0'.repeat(64):String(row.source_envelope_sha256),
   operation_head:'a'.repeat(64),observed_head:'b'.repeat(64)};
  await sqlClient`UPDATE telemetry.ml_outbox SET status='delivered',response_payload=${index===2?null:JSON.stringify(proof)}::jsonb WHERE outbox_id=${String(row.outbox_id)}::uuid`;
 }
 await sqlClient.begin(async tx=>{
  await tx`SELECT user_id FROM app.users WHERE user_id=${owner}::uuid FOR KEY SHARE`;
  const lane=await lockModelLane(tx,owner);assert.ok(lane);await withdrawPendingProfiles(tx,lane,'3');
 });
 const rows=await sqlClient`SELECT withdrawal_json,status FROM telemetry.ml_outbox WHERE aggregate_id=${owner}::uuid ORDER BY model_operation_version`;
 assert.equal(typeof rows[0].withdrawal_json,'string');assert.equal(rows[1].withdrawal_json,null);assert.equal(rows[1].status,'delivered');
 assert.equal(typeof rows[2].withdrawal_json,'string');
});

integration('the backend role can withdraw a pending profile without gaining frozen-source write access',async()=>{
 const owner=await fixture();
 await sqlClient.begin(async tx=>{
  await tx`SELECT user_id FROM app.users WHERE user_id=${owner}::uuid FOR KEY SHARE`;
  const lane=await lockModelLane(tx,owner);assert.ok(lane);
  await enqueueModelProfile(tx,lane,buildMlOnboardingJob(owner,2,{username:'Tarun',bio:'PRIVATE_ROLE_WITHDRAWAL'}));
 });
 const [before]=await sqlClient`SELECT outbox_id,operation_json,source_envelope_sha256 FROM telemetry.ml_outbox WHERE aggregate_id=${owner}::uuid`;
 await sqlClient.begin(async tx=>{
  await tx.unsafe('SET LOCAL ROLE ghsocial_backend');
  await tx`SELECT user_id FROM app.users WHERE user_id=${owner}::uuid FOR KEY SHARE`;
  const lane=await lockModelLane(tx,owner);assert.ok(lane);
  await withdrawPendingProfiles(tx,lane,'2');
 });
 const [after]=await sqlClient`SELECT operation_json,source_envelope_sha256,withdrawal_json FROM telemetry.ml_outbox WHERE outbox_id=${before.outbox_id}::uuid`;
 assert.equal(after.operation_json,before.operation_json);assert.equal(after.source_envelope_sha256,before.source_envelope_sha256);
 assert.ok(after.withdrawal_json);assert.doesNotMatch(after.withdrawal_json,/PRIVATE_ROLE_WITHDRAWAL/);
 const [privileges]=await sqlClient`SELECT has_column_privilege('ghsocial_backend','telemetry.ml_outbox','withdrawal_json','UPDATE') AS withdrawal,
  has_column_privilege('ghsocial_backend','telemetry.ml_outbox','operation_json','UPDATE') AS frozen`;
 assert.deepEqual({...privileges},{withdrawal:true,frozen:false});
});

integration('bounded context cleanup skips leased rows and preserves live bodies and expired headers',async()=>{
 const owner=await fixture(),session=crypto.randomUUID();await controls.control(owner,{kind:'begin',request_id:crypto.randomUUID(),session_id:session});
 const ids=Array.from({length:4},()=>crypto.randomUUID());
 for(let i=0;i<ids.length;i++)await sqlClient`INSERT INTO telemetry.feed_model_generations(generation_id,user_id,session_id,queue_scope,applied_context,valid_until_ms)
  VALUES(${ids[i]}::uuid,${owner}::uuid,${session}::uuid,${policy},'{}',${Date.now()+(i===3?60000:-60000)}::bigint)`;
 const worker=new RetentionWorker();let unlock!:()=>void,locked!:()=>void;const ready=new Promise<void>(r=>locked=r),release=new Promise<void>(r=>unlock=r);
 const held=sqlClient.begin(async tx=>{await tx`SELECT generation_id FROM telemetry.feed_model_generations WHERE generation_id=${ids[0]}::uuid FOR UPDATE`;locked();await release;});
 await ready;
 try{assert.equal((await worker.pruneModelCopies(1)).contexts,1);
 assert.equal((await sqlClient`SELECT count(*)::int n FROM telemetry.feed_model_generations WHERE user_id=${owner}::uuid AND applied_context IS NULL`)[0].n,1);}
 finally{unlock();await held;}
 await worker.pruneModelCopies();const rows=await sqlClient`SELECT generation_id,applied_context FROM telemetry.feed_model_generations WHERE user_id=${owner}::uuid`;
 assert.equal(rows.length,4);assert.equal(rows.filter(r=>r.applied_context===null).length,3);assert.deepEqual(rows.find(r=>r.generation_id===ids[3])!.applied_context,{});
});

integration('capacity reclaims idle sessions with ordered End before Begin while preserving retries and active tabs',async()=>{
 const owner=await fixture(),other=await fixture(),first=crypto.randomUUID(),second=crypto.randomUUID();
 const begin={kind:'begin' as const,request_id:crypto.randomUUID(),session_id:first};const initial=await controls.control(owner,begin);
 await controls.control(owner,{kind:'begin',request_id:crypto.randomUUID(),session_id:second});
 await sqlClient`UPDATE telemetry.feed_intent_sessions SET last_presence_ms=floor(extract(epoch FROM clock_timestamp())*1000)::bigint-60000 WHERE session_id=${first}::uuid`;
 const [stamp]=await sqlClient`SELECT last_presence_ms FROM telemetry.feed_intent_sessions WHERE session_id=${first}::uuid`;
 await assert.rejects(controls.control(other,{kind:'reset',request_id:crypto.randomUUID(),session_id:first,expected_epoch:'1'}),/STALE/);
 assert.equal(String((await sqlClient`SELECT last_presence_ms FROM telemetry.feed_intent_sessions WHERE session_id=${first}::uuid`)[0].last_presence_ms),String(stamp.last_presence_ms));
 const fresh=crypto.randomUUID(),created=await controls.control(owner,{kind:'begin',request_id:crypto.randomUUID(),session_id:fresh});
 assert.equal(created.operation.version,'4');
 const rows=await sqlClient`SELECT operation_json FROM telemetry.ml_outbox WHERE aggregate_id=${owner}::uuid ORDER BY model_operation_version`;
 const operations=rows.map(r=>JSON.parse(r.operation_json));assert.deepEqual(operations.map(o=>o.kind),['begin','begin','end','begin']);
 assert.equal(operations[2].operation.session_id,first);assert.equal(operations[2].operation.epoch_started_ms,initial.session.epochStartedMs);assert.equal(operations[2].operation.retired,true);
 const replay=await controls.control(owner,begin);assert.deepEqual(replay.operation,initial.operation);assert.equal(replay.session.status,'retired');
 await assert.rejects(controls.control(owner,{kind:'begin',request_id:crypto.randomUUID(),session_id:first}),/UNAVAILABLE/);
 await assert.rejects(controls.control(owner,{kind:'begin',request_id:crypto.randomUUID(),session_id:crypto.randomUUID()}),/CAPACITY/);
 // A different client Reset refreshes backend presence and cannot be reclaimed
 // using an older observation of the same session epoch.
 await sqlClient`UPDATE telemetry.feed_intent_sessions SET last_presence_ms=1 WHERE session_id=${second}::uuid`;
 const reset=await controls.control(owner,{kind:'reset',request_id:crypto.randomUUID(),session_id:second,expected_epoch:'1'});
 assert.equal(reset.session.epoch,'2');
 await assert.rejects(controls.control(owner,{kind:'begin',request_id:crypto.randomUUID(),session_id:crypto.randomUUID()}),/CAPACITY/);
 const live=await sqlClient`SELECT status,intent_epoch FROM telemetry.feed_intent_sessions WHERE session_id=${second}::uuid`;
 assert.equal(live[0].status,'active');assert.equal(String(live[0].intent_epoch),'2');
});

integration('only a committed current scoped serve renews backend presence and retains historical replay',async()=>{
 const owner=await fixture(),session=crypto.randomUUID(),persistence=new PostgresFeedPersistence();
 const begin=await controls.control(owner,{kind:'begin',request_id:crypto.randomUUID(),session_id:session});
 const [state]=await sqlClient`SELECT feed_version FROM app.user_feed_state WHERE user_id=${owner}::uuid`;
 const now=String(Date.now()),scope:FeedIntentScope={userId:owner,sessionId:session,feedVersion:String(state.feed_version),profileVersion:'1',acceptedOperationVersion:'1',epoch:'1',epochStartedMs:begin.session.epochStartedMs,witnessSha256:begin.session.witnessSha256,policySha256:policy,queueScope:policy,
 context:{schema_version:1,session_id:session,epoch:'1',policy_sha256:policy,minimum_applied_operation_version:'1',required_profile_version:'1',as_of_ms:now},
 applied:{schema_version:1,user_id:owner,session_id:session,epoch:'1',policy_sha256:policy,profile_version:'1',applied_operation_version:'1',applied_feedback_version:'0',as_of_ms:now,valid_until_ms:String(Date.now()+60000),head:policy,state_sha256:policy,effective_vector_sha256:policy,session_witness_sha256:begin.session.witnessSha256,explicit_negative_repo_ids:[]}};
 const input={user_id:owner,session_id:session,feed_request_id:crypto.randomUUID(),feed_version:BigInt(state.feed_version),generation_id:null,source:'personalized' as const,model_version:null,next_cursor:null,items:[],intent_scope:scope};
 await sqlClient`UPDATE telemetry.feed_intent_sessions SET last_presence_ms=1 WHERE session_id=${session}::uuid`;
 await assert.rejects(persistence.createServe({...input,intent_scope:{...scope,epoch:'2'}}),/MODEL_SESSION_PENDING/);
 assert.equal(String((await sqlClient`SELECT last_presence_ms FROM telemetry.feed_intent_sessions WHERE session_id=${session}::uuid`)[0].last_presence_ms),'1');
 const served=await persistence.createServe(input);assert.ok(BigInt(String((await sqlClient`SELECT last_presence_ms FROM telemetry.feed_intent_sessions WHERE session_id=${session}::uuid`)[0].last_presence_ms))>=BigInt(now));
 await controls.control(owner,{kind:'end',request_id:crypto.randomUUID(),session_id:session,expected_epoch:'1'});
 const replay=await persistence.getServeByRequest(owner,input.feed_request_id);assert.equal(replay!.serve_id,served.serve_id);assert.equal(replay!.intent_scope,undefined);
});

integration('new current attributed activity protects an interaction-only tab; duplicates, old epochs and rollback do not renew',async()=>{
 const owner=await fixture(),other=await fixture(),session=crypto.randomUUID(),idle=crypto.randomUUID(),repo=crypto.randomUUID(),serve=crypto.randomUUID();
 const begin=await controls.control(owner,{kind:'begin',request_id:crypto.randomUUID(),session_id:session});await controls.control(owner,{kind:'begin',request_id:crypto.randomUUID(),session_id:idle});
 await sqlClient`INSERT INTO app.repos(repo_id,github_id,full_name,owner,name,url,status) VALUES(${repo}::uuid,${Date.now()}::bigint,${'fixture/'+repo},'fixture',${repo},${'https://github.com/fixture/'+repo},'active')`;
 try{
  await sqlClient`INSERT INTO telemetry.feed_serves(serve_id,feed_request_id,user_id,session_id,feed_version,source,intent_epoch,intent_epoch_started_ms,intent_epoch_witness_sha256,intent_policy_sha256)
   VALUES(${serve}::uuid,${crypto.randomUUID()}::uuid,${owner}::uuid,${session}::uuid,2,'personalized',1,${begin.session.epochStartedMs}::bigint,${begin.session.witnessSha256},${policy})`;
  await sqlClient`INSERT INTO telemetry.feed_serve_items(serve_id,position,repo_id,source) VALUES(${serve}::uuid,0,${repo}::uuid,'personalized')`;
  const event={event_id:crypto.randomUUID(),schema_version:2 as const,session_id:session,serve_id:serve,repo_id:repo,position:0,event_type:'readme_open' as const,dwell_ms:null,client_occurred_at:new Date().toISOString(),context:{}};
  const stamp=async()=>String((await sqlClient`SELECT last_presence_ms FROM telemetry.feed_intent_sessions WHERE session_id=${session}::uuid`)[0].last_presence_ms);
  await sqlClient`UPDATE telemetry.feed_intent_sessions SET last_presence_ms=1 WHERE user_id=${owner}::uuid`;
  await assert.rejects(processInteractionBatchV2(other,[event]),/does not match/);assert.equal(await stamp(),'1');
  await assert.rejects(sqlClient.begin(async tx=>{await processInteractionBatchV2InTransaction(tx,owner,[event]);throw new Error('rollback fixture');}),/rollback fixture/);assert.equal(await stamp(),'1');
  await processInteractionBatchV2(owner,[event]);assert.ok(BigInt(await stamp())>1n);
  await controls.control(owner,{kind:'begin',request_id:crypto.randomUUID(),session_id:crypto.randomUUID()});
  assert.equal((await sqlClient`SELECT status FROM telemetry.feed_intent_sessions WHERE session_id=${session}::uuid`)[0].status,'active');
  assert.equal((await sqlClient`SELECT status FROM telemetry.feed_intent_sessions WHERE session_id=${idle}::uuid`)[0].status,'retired');
  await sqlClient`UPDATE telemetry.feed_intent_sessions SET last_presence_ms=1 WHERE session_id=${session}::uuid`;
  assert.equal((await processInteractionBatchV2(owner,[event])).results[0].status,'duplicate');assert.equal(await stamp(),'1');
  await controls.control(owner,{kind:'reset',request_id:crypto.randomUUID(),session_id:session,expected_epoch:'1'});
  await sqlClient`UPDATE telemetry.feed_intent_sessions SET last_presence_ms=1 WHERE session_id=${session}::uuid`;
  await processInteractionBatchV2(owner,[{...event,event_id:crypto.randomUUID()}]);assert.equal(await stamp(),'1');
 }finally{await sqlClient`DELETE FROM telemetry.interaction_events WHERE user_id=${owner}::uuid`;await sqlClient`DELETE FROM telemetry.feed_serves WHERE serve_id=${serve}::uuid`;await sqlClient`DELETE FROM app.repos WHERE repo_id=${repo}::uuid`;}
});
