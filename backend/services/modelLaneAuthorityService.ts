import type { Sql } from 'postgres';
import { sqlClient } from '../db/index.js';
import type { MlModelOperationStatusRequest, MlModelOperationStatusResponse, MlModelAuthorityRequest, MlModelAuthorityResponse } from '../contracts/ml.v2.js';
import { ModelOperationError } from '../contracts/modelOperations.js';
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
 async ensureProfileReady(userId:string):Promise<bigint>{
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
   const [row]=await tx`SELECT outbox_id,model_operation_version,source_envelope_sha256,withdrawal_json FROM telemetry.ml_outbox
     WHERE idempotency_key=${`model:${userId}:profile:${job.profile_version}`}`;
   if(!row||row.withdrawal_json)throw new ModelOperationError('MODEL_PROFILE_PENDING',409);
   const [state]=await tx`SELECT model_operation_version,feedback_version FROM app.user_feed_state WHERE user_id=${userId}::uuid`;
   return {operationId:String(row.outbox_id),operationVersion:String(row.model_operation_version),sourceSha:String(row.source_envelope_sha256),
    profileVersion:String(profile.profile_version),frontier:String(state.model_operation_version),feedbackVersion:String(state.feedback_version)};
  });
  const status=await this.transport.modelOperationStatus({schema_version:1,user_id:userId,operation_id:source.operationId,
    model_operation_version:source.operationVersion,source_envelope_sha256:source.sourceSha});
  if(status.user_id!==userId||status.operation_id!==source.operationId||status.model_operation_version!==source.operationVersion
   ||status.source_envelope_sha256!==source.sourceSha||status.status!=='applied'||status.basis_status!=='ready'
   ||status.applied_profile_version!==source.profileVersion||!status.current_head||!status.operation_head
   ||!status.applied_operation_version||BigInt(status.applied_operation_version)<BigInt(source.operationVersion)
   ||BigInt(status.applied_operation_version)>BigInt(source.frontier)||status.applied_feedback_version==null
   ||BigInt(status.applied_feedback_version)>BigInt(source.feedbackVersion))throw new ModelOperationError('MODEL_PROFILE_PENDING',409);
  await this.db.begin(async tx=>{
   const [profile]=await tx`SELECT profile_version FROM app.users WHERE user_id=${userId}::uuid AND status='active' FOR KEY SHARE`;
   if(String(profile?.profile_version)!==source.profileVersion)throw new ModelOperationError('MODEL_PROFILE_PENDING',409);
   const lane=await lockModelLane(tx,userId);if(!lane)throw new ModelOperationError();
   const [row]=await tx`SELECT withdrawal_json,source_envelope_sha256 FROM telemetry.ml_outbox WHERE outbox_id=${source.operationId}::uuid`;
   if(!row||row.withdrawal_json||row.source_envelope_sha256!==source.sourceSha)throw new ModelOperationError('MODEL_PROFILE_PENDING',409);
   await tx`UPDATE telemetry.ml_outbox SET response_payload=${JSON.stringify({model_profile_applied:true,status:'applied',basis_status:'ready',operation_id:source.operationId,
     model_operation_version:source.operationVersion,source_envelope_sha256:source.sourceSha,operation_head:status.operation_head,
     observed_head:status.current_head,applied_profile_version:source.profileVersion})}::jsonb
     WHERE outbox_id=${source.operationId}::uuid AND response_payload IS NULL`;
   if(!lane.initialized)await sequencePendingModelFeedback(tx,lane);
  });
  return BigInt(source.profileVersion);
 }
}
