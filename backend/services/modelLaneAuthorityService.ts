import type { Sql } from 'postgres';
import { sqlClient } from '../db/index.js';
import type { MlModelOperationStatusRequest, MlModelOperationStatusResponse, MlModelAuthorityRequest, MlModelAuthorityResponse } from '../contracts/ml.v2.js';
import { canonicalJson, modelDigest, ModelOperationError, type CanonicalValue } from '../contracts/modelOperations.js';
import { modelRecord, parseModelOperationStatus } from './modelOperationValidation.js';
import { lockModelLane, sequencePendingModelFeedback, enqueueModelProfile } from './modelOperationService.js';
import { buildMlOnboardingJob, hasMlEmbeddingContext } from './mlOnboardingService.js';
export interface ModelAuthorityTransport {
 modelOperationStatus(input:MlModelOperationStatusRequest):Promise<MlModelOperationStatusResponse>;
 modelAuthority(input:MlModelAuthorityRequest):Promise<MlModelAuthorityResponse>;
}
export class ModelLaneAuthorityService {
 constructor(readonly transport:ModelAuthorityTransport,private readonly db:Sql=sqlClient){}
 async isEnabled(userId:string):Promise<boolean>{
  const [row]=await this.db`SELECT model_policy_sha256 FROM app.user_feed_state WHERE user_id=${userId}::uuid`;
  return Boolean(row?.model_policy_sha256);
 }
 async ensureProfileReady(userId:string,options:{reuseAppliedProof?:boolean}={}):Promise<bigint>{
  // Only feed resolution opts in: it immediately checks fresh serving authority.
  // Session admission retains a fresh provider-readiness check by default.
  if(options.reuseAppliedProof){
   const [row]=await this.db`SELECT u.profile_version,state.model_policy_sha256,outbox.outbox_id,
     outbox.model_operation_version,outbox.source_envelope_sha256,outbox.response_payload
     FROM app.users u JOIN app.user_feed_state state USING(user_id)
     JOIN telemetry.ml_outbox outbox ON outbox.aggregate_id=u.user_id AND outbox.job_type='model_operation'
       AND outbox.idempotency_key='model:'||u.user_id::text||':profile:'||u.profile_version::text
     WHERE u.user_id=${userId}::uuid AND u.status='active' AND state.model_initialized=true
       AND state.model_policy_sha256 IS NOT NULL AND outbox.withdrawal_json IS NULL
       AND outbox.model_operation_version>0 AND outbox.model_operation_version<=state.model_operation_version`;
   const proof=row?.response_payload;
   if(proof&&typeof proof==='object'&&!Array.isArray(proof)&&proof.profile_attestation_version===1
     &&proof.model_profile_applied===true&&proof.status==='applied'&&proof.basis_status==='ready'
     &&proof.user_id===userId&&proof.policy_sha256===row.model_policy_sha256
     &&proof.operation_id===String(row.outbox_id)&&proof.model_operation_version===String(row.model_operation_version)
     &&proof.source_envelope_sha256===row.source_envelope_sha256&&proof.applied_profile_version===String(row.profile_version)
     &&typeof proof.operation_head==='string'&&/^[a-f0-9]{64}$/.test(proof.operation_head)
     &&typeof proof.observed_head==='string'&&/^[a-f0-9]{64}$/.test(proof.observed_head))return BigInt(String(row.profile_version));
  }
  // Enqueue/reuse under product locks. Network authority reads happen afterwards.
  const source=await this.db.begin(async tx=>{
   const [profile]=await tx`SELECT * FROM app.users WHERE user_id=${userId}::uuid AND status='active' FOR KEY SHARE`;
   if(!profile)throw new ModelOperationError();
   const lane=await lockModelLane(tx,userId);if(!lane)throw new ModelOperationError('MODEL_POLICY_DISABLED',409);
   const job=buildMlOnboardingJob(userId,Number(profile.profile_version),{username:String(profile.username),
    fullName:profile.full_name==null?null:String(profile.full_name),bio:profile.bio==null?null:String(profile.bio),
    githubUsername:profile.github_handle==null?null:String(profile.github_handle),avatarUrl:profile.avatar_url==null?null:String(profile.avatar_url),
    interests:Array.isArray(profile.interests)?profile.interests.map(String):[],skills:Array.isArray(profile.skills)?profile.skills.map(String):[],
    techStack:Array.isArray(profile.tech_stack)?profile.tech_stack.map(String):[]});
   if(!Number.isSafeInteger(job.profile_version)||!hasMlEmbeddingContext(job.profile))throw new ModelOperationError('MODEL_PROFILE_CONTEXT_REQUIRED',409);
   const [existing]=await tx`SELECT outbox_id FROM telemetry.ml_outbox WHERE idempotency_key=${`model:${userId}:profile:${job.profile_version}`}`;
   if(!existing)await enqueueModelProfile(tx,lane,job);
   const [row]=await tx`SELECT outbox_id,model_operation_version,source_envelope_sha256,withdrawal_json,operation_json FROM telemetry.ml_outbox
     WHERE idempotency_key=${`model:${userId}:profile:${job.profile_version}`}`;
   if(!row||row.withdrawal_json)throw new ModelOperationError('MODEL_PROFILE_PENDING',409);
   // Bind the proof recipe to the immutable source, not newly rebuilt metadata.
   // Existing proofs without this identity-bound recipe are refreshed once.
   try{
    const envelope=modelRecord(JSON.parse(String(row.operation_json))),operation=modelRecord(envelope.operation);
    if(modelDigest(String(row.operation_json))!==row.source_envelope_sha256
      ||canonicalJson(envelope as CanonicalValue)!==row.operation_json||envelope.kind!=='profile'
      ||envelope.user_id!==userId||envelope.operation_id!==String(row.outbox_id)
      ||envelope.model_operation_version!==String(row.model_operation_version)||envelope.policy_sha256!==lane.policySha256
      ||operation.profile_version!==String(profile.profile_version))throw new ModelOperationError();
   }catch{throw new ModelOperationError('MODEL_PROFILE_PENDING',409);}
   const [state]=await tx`SELECT model_operation_version,feedback_version FROM app.user_feed_state WHERE user_id=${userId}::uuid`;
   return {operationId:String(row.outbox_id),operationVersion:String(row.model_operation_version),sourceSha:String(row.source_envelope_sha256),
    profileVersion:String(profile.profile_version),policySha:lane.policySha256,frontier:String(state.model_operation_version),feedbackVersion:String(state.feedback_version)};
  });
  const status=parseModelOperationStatus(await this.transport.modelOperationStatus({schema_version:1,user_id:userId,operation_id:source.operationId,
    model_operation_version:source.operationVersion,source_envelope_sha256:source.sourceSha}));
  if(status.user_id!==userId||status.operation_id!==source.operationId||status.model_operation_version!==source.operationVersion
   ||status.source_envelope_sha256!==source.sourceSha||status.status!=='applied'||status.basis_status!=='ready'
   ||status.applied_profile_version!==source.profileVersion||!status.current_head||!status.operation_head
   ||!status.applied_operation_version||BigInt(status.applied_operation_version)<BigInt(source.operationVersion)
   ||BigInt(status.applied_operation_version)>BigInt(source.frontier)||status.applied_feedback_version==null
   ||BigInt(status.applied_feedback_version)>BigInt(source.feedbackVersion))throw new ModelOperationError('MODEL_PROFILE_PENDING',409);
  await this.db.begin(async tx=>{
   const [profile]=await tx`SELECT profile_version FROM app.users WHERE user_id=${userId}::uuid AND status='active' FOR KEY SHARE`;
   if(String(profile?.profile_version)!==source.profileVersion)throw new ModelOperationError('MODEL_PROFILE_PENDING',409);
   const lane=await lockModelLane(tx,userId);if(!lane||lane.policySha256!==source.policySha)throw new ModelOperationError('MODEL_PROFILE_PENDING',409);
   const [row]=await tx`SELECT withdrawal_json,source_envelope_sha256 FROM telemetry.ml_outbox WHERE outbox_id=${source.operationId}::uuid`;
   if(!row||row.withdrawal_json||row.source_envelope_sha256!==source.sourceSha)throw new ModelOperationError('MODEL_PROFILE_PENDING',409);
   await tx`UPDATE telemetry.ml_outbox SET response_payload=
     (CASE WHEN jsonb_typeof(response_payload)='object' THEN response_payload ELSE '{}'::jsonb END)||
     ${JSON.stringify({profile_attestation_version:1,user_id:userId,policy_sha256:source.policySha,model_profile_applied:true,status:'applied',basis_status:'ready',operation_id:source.operationId,
     model_operation_version:source.operationVersion,source_envelope_sha256:source.sourceSha,operation_head:status.operation_head,
     observed_head:status.current_head,applied_profile_version:source.profileVersion})}::jsonb
     WHERE outbox_id=${source.operationId}::uuid`;
   if(!lane.initialized)await sequencePendingModelFeedback(tx,lane);
  });
  return BigInt(source.profileVersion);
 }
}
