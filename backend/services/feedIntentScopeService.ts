import type { Sql } from 'postgres';
import { sqlClient } from '../db/index.js';
import type { FeedIntentScope } from '../contracts/feedIntent.js';
import type { MlAppliedModelContext, MlModelRecommendationContext } from '../contracts/ml.v2.js';
import { canonicalJson,modelDigest,ModelOperationError,type CanonicalValue } from '../contracts/modelOperations.js';
import { ModelLaneAuthorityService } from './modelLaneAuthorityService.js';
export class FeedIntentScopeService {
 constructor(private readonly authority:ModelLaneAuthorityService,private readonly db:Sql=sqlClient){}
 async snapshot(userId:string,sessionId:string){
  const [row]=await this.db`SELECT state.feed_version,state.model_operation_version,state.model_policy_sha256,state.model_initialized,
    state.feedback_version,state.model_policy_limits,u.profile_version,s.intent_epoch,s.epoch_started_ms,s.status,s.epoch_witness_sha256,s.policy_sha256
    FROM app.user_feed_state state JOIN app.users u USING(user_id)
    LEFT JOIN telemetry.feed_intent_sessions s ON s.user_id=state.user_id AND s.session_id=${sessionId}::uuid
    WHERE state.user_id=${userId}::uuid AND u.status='active'`;
  if(!row?.model_policy_sha256)return null;
  if(!row.model_initialized||row.status!=='active'||row.policy_sha256!==row.model_policy_sha256)throw new ModelOperationError('MODEL_SESSION_PENDING',409);
  const limits=row.model_policy_limits as Record<string,unknown>;
  if(!Number.isSafeInteger(limits?.generation_freshness_ms)||Number(limits.generation_freshness_ms)<1)throw new ModelOperationError();
  return {generationFreshnessMs:Number(limits.generation_freshness_ms),userId,sessionId,feedVersion:String(row.feed_version),profileVersion:String(row.profile_version),acceptedOperationVersion:String(row.model_operation_version),
    feedbackVersion:String(row.feedback_version),epoch:String(row.intent_epoch),epochStartedMs:String(row.epoch_started_ms),
    witnessSha256:String(row.epoch_witness_sha256),policySha256:String(row.policy_sha256)};
 }
 async resolve(userId:string,sessionId:string,asOfMs?:string):Promise<FeedIntentScope|null>{
  if(!await this.authority.isEnabled(userId))return null;
  await this.authority.ensureProfileReady(userId);
  const snapshot=await this.snapshot(userId,sessionId);if(!snapshot)throw new ModelOperationError();
  const context:MlModelRecommendationContext={schema_version:1,session_id:sessionId,epoch:snapshot.epoch,policy_sha256:snapshot.policySha256,
    minimum_applied_operation_version:snapshot.acceptedOperationVersion,required_profile_version:snapshot.profileVersion,as_of_ms:asOfMs??String(Date.now())};
  const response=await this.authority.transport.modelAuthority({schema_version:1,user_id:userId,model_context:context});
  const applied=response.model_context;
  this.validate(snapshot,context,applied);
  const queueScope=modelDigest(canonicalJson({userId,feedVersion:snapshot.feedVersion,profileVersion:snapshot.profileVersion,
    sessionId,epoch:snapshot.epoch,policySha256:snapshot.policySha256,applied} as CanonicalValue));
  return {...snapshot,queueScope,context,applied};
 }
 private validate(snapshot:NonNullable<Awaited<ReturnType<FeedIntentScopeService['snapshot']>>>,context:MlModelRecommendationContext,applied:MlAppliedModelContext){
  if(applied.user_id!==snapshot.userId||applied.session_id!==snapshot.sessionId||applied.epoch!==snapshot.epoch
    ||applied.policy_sha256!==snapshot.policySha256||applied.profile_version!==snapshot.profileVersion||applied.applied_operation_version!==snapshot.acceptedOperationVersion
    ||applied.applied_feedback_version!==snapshot.feedbackVersion||applied.session_witness_sha256!==snapshot.witnessSha256||applied.as_of_ms!==context.as_of_ms
    ||BigInt(applied.valid_until_ms)>BigInt(context.as_of_ms)+BigInt(snapshot.generationFreshnessMs)
    ||BigInt(applied.valid_until_ms)<=BigInt(Date.now())||BigInt(applied.as_of_ms)<BigInt(snapshot.epochStartedMs))throw new ModelOperationError('MODEL_SESSION_PENDING',409);
 }
 async isCurrent(scope:FeedIntentScope):Promise<boolean>{
  if(BigInt(scope.applied.valid_until_ms)<=BigInt(Date.now()))return false;
  const snapshot=await this.snapshot(scope.userId,scope.sessionId);
  return Boolean(snapshot&&snapshot.feedVersion===scope.feedVersion&&snapshot.profileVersion===scope.profileVersion
    &&snapshot.acceptedOperationVersion===scope.acceptedOperationVersion&&snapshot.epoch===scope.epoch
    &&snapshot.witnessSha256===scope.witnessSha256&&snapshot.policySha256===scope.policySha256);
 }
 async persistGeneration(scope:FeedIntentScope,generationId:string,applied:MlAppliedModelContext):Promise<void>{
  if(canonicalJson(applied as CanonicalValue)!==canonicalJson(scope.applied as CanonicalValue)||!await this.isCurrent(scope))throw new ModelOperationError('MODEL_SESSION_PENDING',409);
  await this.db`INSERT INTO telemetry.feed_model_generations(generation_id,user_id,session_id,queue_scope,applied_context,valid_until_ms)
    VALUES(${generationId}::uuid,${scope.userId}::uuid,${scope.sessionId}::uuid,${scope.queueScope},${JSON.stringify(applied)}::jsonb,${applied.valid_until_ms}::bigint)`;
 }
}
