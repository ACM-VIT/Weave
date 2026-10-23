import crypto from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { canonicalJson, decimalInt64, MAX_MODEL_OPERATION_BYTES, MODEL_POLICY_VERSION, modelDigest, ModelOperationError,
  type CanonicalAttribution, type CanonicalValue, type FrozenModelOperation, type ModelOperationInput } from '../contracts/modelOperations.js';
import { withOutboxTrace } from '../observability/tracing.js';
import type { MlOnboardingJob } from '../contracts/ml.v2.js';

export interface ModelPolicyLimits { input_bytes: number; max_sessions: number; generation_freshness_ms: number; idle_expiry_ms: number }
const locked = Symbol('lockedModelLane');
export interface LockedModelLane {
  readonly [locked]: true; readonly userId: string; readonly policySha256: string;
  readonly initialized: boolean; readonly limits: ModelPolicyLimits;
}
function limits(value: Record<string, unknown>): ModelPolicyLimits {
  const fields = ['input_bytes','max_sessions','generation_freshness_ms','idle_expiry_ms'] as const;
  for (const key of fields) if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 1) throw new ModelOperationError();
  if (Number(value.input_bytes) > MAX_MODEL_OPERATION_BYTES || Number(value.max_sessions)>1000) throw new ModelOperationError();
  return { input_bytes:Number(value.input_bytes),max_sessions:Number(value.max_sessions),generation_freshness_ms:Number(value.generation_freshness_ms),idle_expiry_ms:Number(value.idle_expiry_ms) };
}
/** Caller owns the parent user lock BEFORE this call; never upgrade it after feed. */
export async function lockModelLane(tx: TransactionSql, userId: string): Promise<LockedModelLane | null> {
  const [state] = await tx`SELECT model_policy_sha256,model_policy_limits,model_initialized,feedback_version FROM app.user_feed_state WHERE user_id=${userId}::uuid FOR UPDATE`;
  if (!state?.model_policy_sha256) return null;
  if(state.model_initialized!==true&&BigInt(String(state.feedback_version))>0n){
    const [pending]=await tx`SELECT count(*)::bigint AS count,min(feedback_version) AS first,max(feedback_version) AS last
      FROM telemetry.pending_model_feedback WHERE user_id=${userId}::uuid`;
    if(String(pending.count)!==String(state.feedback_version)||String(pending.first)!=='1'||String(pending.last)!==String(state.feedback_version))
      throw new ModelOperationError('MODEL_CUTOVER_REQUIRED',409);
  }
  return { [locked]:true,userId,policySha256:String(state.model_policy_sha256),initialized:state.model_initialized===true,
    limits:limits(state.model_policy_limits as Record<string,unknown>) };
}
function frozen(row: Record<string, unknown>): FrozenModelOperation {
  const operationJson=String(row.operation_json);
  const envelope=JSON.parse(operationJson) as { accepted_at_ms:string };
  if (modelDigest(operationJson)!==row.source_envelope_sha256) throw new ModelOperationError();
  return {operationId:String(row.outbox_id),userId:String(row.aggregate_id),version:String(row.model_operation_version),
    previousVersion:String(row.previous_model_operation_version),acceptedAtMs:envelope.accepted_at_ms,
    sourceSha256:String(row.source_envelope_sha256),operationJson};
}
export interface AllocatedOperation { operationId:string; previous:string; next:string; acceptedAtMs:string }
/** Same transaction and already-held feed lock as the product mutation. No I/O. */
export async function appendModelOperation(tx: TransactionSql, lane:LockedModelLane, key:string,
  logicalRequest:CanonicalValue, build:(allocated:AllocatedOperation)=>ModelOperationInput,
  originalAcceptedAtMs?:string):Promise<{reused:boolean;operation:FrozenModelOperation}> {
  try {
    const idempotencyKey=`model:${lane.userId}:${key}`;
    const logicalSha=modelDigest(canonicalJson(logicalRequest));
    const [existing]=await tx`SELECT * FROM telemetry.ml_outbox WHERE idempotency_key=${idempotencyKey}`;
    if(existing){if(existing.aggregate_id!==lane.userId || existing.logical_request_sha256!==logicalSha)throw new ModelOperationError('MODEL_OPERATION_CONFLICT',409);
      return {reused:true,operation:frozen(existing)};}
    const [state]=await tx`UPDATE app.user_feed_state SET model_operation_version=model_operation_version+1,
      model_accepted_at_ms=GREATEST(model_accepted_at_ms,floor(extract(epoch FROM clock_timestamp())*1000)::bigint),updated_at=now()
      WHERE user_id=${lane.userId}::uuid AND model_policy_sha256=${lane.policySha256} AND model_operation_version<9223372036854775807
      RETURNING model_operation_version,model_accepted_at_ms`;
    if(!state)throw new ModelOperationError();
    const next=String(state.model_operation_version),previous=(BigInt(next)-1n).toString();
    const acceptedAtMs=originalAcceptedAtMs===undefined?String(state.model_accepted_at_ms):decimalInt64(originalAcceptedAtMs);
    if(BigInt(acceptedAtMs)>BigInt(String(state.model_accepted_at_ms)))throw new ModelOperationError();
    const operationId=crypto.randomUUID();
    const input=build({operationId,previous,next,acceptedAtMs});
    // DTO fields are finite JSON; no trace metadata or JSONB reconstruction.
    const operationJson=canonicalJson({schema_version:1,operation_id:operationId,user_id:lane.userId,
      model_operation_version:next,previous_model_operation_version:previous,accepted_at_ms:acceptedAtMs,
      policy_version:MODEL_POLICY_VERSION,policy_sha256:lane.policySha256,...input} as CanonicalValue);
    if(Buffer.byteLength(operationJson,'utf8')>lane.limits.input_bytes)throw new ModelOperationError('MODEL_OPERATION_TOO_LARGE',413);
    const sourceSha256=modelDigest(operationJson);
    await tx`INSERT INTO telemetry.ml_outbox(outbox_id,job_type,aggregate_id,idempotency_key,payload,
      model_operation_version,previous_model_operation_version,operation_json,source_envelope_sha256,logical_request_sha256)
      VALUES(${operationId}::uuid,'model_operation',${lane.userId}::uuid,${idempotencyKey},'{}'::jsonb,
        ${next}::bigint,${previous}::bigint,${operationJson},${sourceSha256},${logicalSha})`;
    return {reused:false,operation:{operationId,userId:lane.userId,version:next,previousVersion:previous,acceptedAtMs,sourceSha256,operationJson}};
  } catch(error) {if(error instanceof ModelOperationError)throw error; throw new ModelOperationError();}
}
export async function enqueueModelProfile(tx:TransactionSql,lane:LockedModelLane,job:MlOnboardingJob):Promise<boolean>{
  const result=await appendModelOperation(tx,lane,`profile:${job.profile_version}`,
    {kind:'profile',profile_version:String(job.profile_version),profile:job.profile} as CanonicalValue,
    ()=>({kind:'profile',operation:{job_id:job.job_id,profile_version:String(job.profile_version),
      allow_genesis:!lane.initialized,original_profile_context:job.profile}}));
  return !result.reused;
}
export async function canonicalFeedbackAttribution(tx:TransactionSql,lane:LockedModelLane,serveId:string|null):Promise<CanonicalAttribution|undefined>{
  if(!serveId)return undefined;
  const [row]=await tx`SELECT serve.session_id,serve.intent_epoch,serve.intent_epoch_started_ms,serve.intent_epoch_witness_sha256,
    serve.intent_policy_sha256,current.status,current.intent_epoch AS current_epoch,current.policy_sha256
    FROM telemetry.feed_serves serve LEFT JOIN telemetry.feed_intent_sessions current ON current.session_id=serve.session_id AND current.user_id=serve.user_id
    WHERE serve.serve_id=${serveId}::uuid AND serve.user_id=${lane.userId}::uuid`;
  if(!row?.intent_epoch)return undefined;
  if(row.intent_policy_sha256!==lane.policySha256 || !row.status)throw new ModelOperationError();
  return {user_id:lane.userId,session_id:String(row.session_id),epoch:String(row.intent_epoch),epoch_started_ms:String(row.intent_epoch_started_ms),
    active_at_acceptance:row.status==='active' && String(row.current_epoch)===String(row.intent_epoch) && row.policy_sha256===lane.policySha256,
    witness_sha256:String(row.intent_epoch_witness_sha256)};
}
export async function enqueueModelFeedback(tx:TransactionSql,lane:LockedModelLane,eventId:string,feedbackVersion:string,
  originalFeedbackJson:string,serveId:string|null):Promise<void>{
  const attribution=await canonicalFeedbackAttribution(tx,lane,serveId);
  const input:ModelOperationInput={kind:'feedback',operation:{original_feedback_json:originalFeedbackJson,...(attribution?{canonical_attribution:attribution}:{})}};
  if(!lane.initialized){
    await tx`INSERT INTO telemetry.pending_model_feedback(event_id,user_id,feedback_version,original_feedback_json,accepted_at_ms,canonical_attribution)
      VALUES(${eventId}::uuid,${lane.userId}::uuid,${feedbackVersion}::bigint,${originalFeedbackJson},floor(extract(epoch FROM clock_timestamp())*1000)::bigint,
        ${attribution?JSON.stringify(attribution):null}::jsonb)`;
    return;
  }
  await appendModelOperation(tx,lane,`feedback:${eventId}`,input as CanonicalValue,()=>input);
}
/** Only call after proving a real applied profile using the authenticated provider. */
export async function sequencePendingModelFeedback(tx:TransactionSql,lane:LockedModelLane):Promise<void>{
  const rows=await tx`SELECT * FROM telemetry.pending_model_feedback WHERE user_id=${lane.userId}::uuid AND operation_id IS NULL ORDER BY feedback_version FOR UPDATE`;
  for(const row of rows){
    const input:ModelOperationInput={kind:'feedback',operation:{original_feedback_json:String(row.original_feedback_json),
      ...(row.canonical_attribution?{canonical_attribution:row.canonical_attribution as CanonicalAttribution}:{})}};
    const result=await appendModelOperation(tx,lane,`feedback:${String(row.event_id)}`,input as CanonicalValue,()=>input,String(row.accepted_at_ms));
    await tx`UPDATE telemetry.pending_model_feedback SET operation_id=${result.operation.operationId}::uuid WHERE event_id=${String(row.event_id)}::uuid`;
  }
  await tx`UPDATE app.user_feed_state SET model_initialized=true WHERE user_id=${lane.userId}::uuid`;
}

/** Shared producer for registered profile/onboarding and verified persona paths. */
export async function enqueueProfileDelivery(tx:TransactionSql,job:MlOnboardingJob):Promise<boolean>{
  const lane=await lockModelLane(tx,job.user_id);
  if(lane)return enqueueModelProfile(tx,lane,job);
  // Preserve the existing disabled payload and trace behavior exactly.
  const rows=await tx`INSERT INTO telemetry.ml_outbox(job_type,aggregate_id,idempotency_key,payload)
    VALUES('onboard',${job.user_id}::uuid,${`onboard:${job.user_id}:${job.profile_version}`},${JSON.stringify(withOutboxTrace(job))}::jsonb)
    ON CONFLICT(idempotency_key) DO NOTHING RETURNING outbox_id`;
  return rows.length>0;
}

/** Consent revocation preserves originals and sends only bounded source attestations. */
async function withdrawPendingProfilesInTransaction(tx:TransactionSql,lane:LockedModelLane,throughProfileVersion:string):Promise<void>{
  const rows=await tx`SELECT * FROM telemetry.ml_outbox WHERE aggregate_id=${lane.userId}::uuid AND job_type='model_operation'
    AND operation_json::jsonb->>'kind'='profile' AND withdrawal_json IS NULL
    AND (operation_json::jsonb->'operation'->>'profile_version')::bigint<=${throughProfileVersion}::bigint ORDER BY model_operation_version FOR UPDATE`;
  const [clock]=await tx`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS revoked_at_ms`;
  for(const row of rows){
    const original=JSON.parse(String(row.operation_json)) as {operation_id:string;user_id:string;model_operation_version:string;previous_model_operation_version:string;
      accepted_at_ms:string;policy_version:string;policy_sha256:string;operation:{job_id:string;profile_version:string;allow_genesis:boolean}};
    const revokedAtMs=String(clock.revoked_at_ms);
    const witness=modelDigest(canonicalJson({user_id:lane.userId,operation_id:original.operation_id,
      source_envelope_sha256:String(row.source_envelope_sha256),revoked_at_ms:revokedAtMs,reason:'github_consent_revoked'}));
    const withdrawal=canonicalJson({schema_version:1,operation_id:original.operation_id,user_id:lane.userId,
      model_operation_version:original.model_operation_version,previous_model_operation_version:original.previous_model_operation_version,
      accepted_at_ms:original.accepted_at_ms,policy_version:original.policy_version,policy_sha256:original.policy_sha256,
      source_envelope_sha256:String(row.source_envelope_sha256),profile_job_id:original.operation.job_id,profile_version:original.operation.profile_version,
      allow_genesis:original.operation.allow_genesis,revoked_at_ms:revokedAtMs,revocation_witness_sha256:witness,reason:'github_consent_revoked'});
    await tx`UPDATE telemetry.ml_outbox SET withdrawal_json=${withdrawal},status='pending',attempts=0,
      available_at=now(),claim_token=NULL,claimed_at=NULL,last_error=NULL WHERE outbox_id=${String(row.outbox_id)}::uuid`;
  }
}

export async function withdrawPendingProfiles(tx:TransactionSql,lane:LockedModelLane,throughProfileVersion:string):Promise<void>{
  try{await withdrawPendingProfilesInTransaction(tx,lane,throughProfileVersion);}
  catch(error){if(error instanceof ModelOperationError)throw error;throw new ModelOperationError();}
}
