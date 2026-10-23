import {OutboxService} from '../../services/outboxService.js';
import {OutboxWorker} from '../../workers/outboxWorker.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { sqlClient } from '../../db/index.js';
import { appendModelOperation,lockModelLane,enqueueModelProfile,sequencePendingModelFeedback,withdrawPendingProfiles } from '../../services/modelOperationService.js';
import { FeedIntentSessionService } from '../../services/feedIntentSessionService.js';
import { canonicalJson,modelDigest } from '../../contracts/modelOperations.js';
import { buildMlOnboardingJob } from '../../services/mlOnboardingService.js';
import { processInteractionBatchV2 } from '../../services/activityV2Service.js';
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
