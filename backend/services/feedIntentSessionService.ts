import type { Sql, TransactionSql } from 'postgres';
import { sqlClient } from '../db/index.js';
import { canonicalJson, decimalInt64, modelDigest, ModelOperationError, type CanonicalValue, type FrozenModelOperation } from '../contracts/modelOperations.js';
import { appendModelOperation, lockModelLane, type LockedModelLane } from './modelOperationService.js';

export type SessionControl = { kind:'begin'; request_id:string; session_id:string }
  | { kind:'reset'|'end'; request_id:string; session_id:string; expected_epoch:string };
export interface FeedIntentSession {
  sessionId:string; epoch:string; epochStartedMs:string; status:'active'|'retired';
  policySha256:string; witnessSha256:string; requiredOperationVersion:string;
}
export function sessionFromRow(row:Record<string,unknown>):FeedIntentSession{
  return {sessionId:String(row.session_id),epoch:String(row.intent_epoch),epochStartedMs:String(row.epoch_started_ms),
    status:row.status==='active'?'active':'retired',policySha256:String(row.policy_sha256),
    witnessSha256:String(row.status==='retired'?row.retirement_witness_sha256:row.epoch_witness_sha256),
    requiredOperationVersion:String(row.last_control_operation_version)};
}
export async function lockedSession(tx:TransactionSql,lane:LockedModelLane,sessionId:string):Promise<FeedIntentSession>{
  const [row]=await tx`SELECT * FROM telemetry.feed_intent_sessions WHERE session_id=${sessionId}::uuid FOR UPDATE`;
  if(!row || row.user_id!==lane.userId || row.policy_sha256!==lane.policySha256)throw new ModelOperationError('MODEL_SESSION_UNKNOWN',409);
  return sessionFromRow(row);
}
/** Parent+feed locks fence controls against feedback acceptance and serve commit. */
export class FeedIntentSessionService {
  constructor(private readonly db:Sql=sqlClient){}
  async control(userId:string,input:SessionControl):Promise<{session:FeedIntentSession;operation:FrozenModelOperation}>{
    return this.db.begin(async tx=>{
      const [owner]=await tx`SELECT user_id FROM app.users WHERE user_id=${userId}::uuid AND status='active' FOR KEY SHARE`;
      if(!owner)throw new ModelOperationError('MODEL_SESSION_UNKNOWN',404);
      const lane=await lockModelLane(tx,userId);
      if(!lane)throw new ModelOperationError('MODEL_POLICY_DISABLED',409);
      if(!lane.initialized)throw new ModelOperationError('MODEL_PROFILE_PENDING',409);
      if(input.kind!=='begin')decimalInt64(input.expected_epoch,true);
      const key=`control:${input.request_id}`;
      const logical={...input} as CanonicalValue;
      const [prior]=await tx`SELECT logical_request_sha256 FROM telemetry.ml_outbox WHERE idempotency_key=${`model:${userId}:${key}`}`;
      if(prior){
        if(prior.logical_request_sha256!==modelDigest(canonicalJson(logical)))throw new ModelOperationError('MODEL_OPERATION_CONFLICT',409);
        const result=await appendModelOperation(tx,lane,key,logical,()=>{throw new ModelOperationError();});
        return {session:await lockedSession(tx,lane,input.session_id),operation:result.operation};
      }
      const [existing]=await tx`SELECT * FROM telemetry.feed_intent_sessions WHERE session_id=${input.session_id}::uuid FOR UPDATE`;
      if(input.kind==='begin'){
        if(existing)throw new ModelOperationError('MODEL_SESSION_UNAVAILABLE',409);
        const [count]=await tx`SELECT count(*)::int AS live FROM telemetry.feed_intent_sessions WHERE user_id=${userId}::uuid AND status='active'`;
        if(Number(count.live)>=lane.limits.max_sessions)throw new ModelOperationError('MODEL_SESSION_CAPACITY',429);
      } else if(!existing || existing.user_id!==userId || existing.status!=='active' || String(existing.intent_epoch)!==input.expected_epoch
        || existing.policy_sha256!==lane.policySha256)throw new ModelOperationError('MODEL_SESSION_STALE',409);
      const epoch=input.kind==='begin'?'1':input.kind==='reset'?(BigInt(input.expected_epoch)+1n).toString():input.expected_epoch;
      decimalInt64(epoch,true);
      let witness='';let started='';
      const result=await appendModelOperation(tx,lane,key,logical,allocated=>{
        started=input.kind==='end'?String(existing.epoch_started_ms):allocated.acceptedAtMs;
        witness=modelDigest(canonicalJson({user_id:userId,session_id:input.session_id,epoch,epoch_started_ms:started,
          policy_sha256:lane.policySha256,control_id:allocated.operationId,model_operation_version:allocated.next,kind:input.kind}));
        if(input.kind==='begin')return {kind:'begin',operation:{session_id:input.session_id,epoch,epoch_started_ms:started,witness_sha256:witness}};
        if(input.kind==='reset')return {kind:'reset',operation:{session_id:input.session_id,old_epoch:input.expected_epoch,new_epoch:epoch,new_epoch_started_ms:started,witness_sha256:witness}};
        return {kind:'end',operation:{session_id:input.session_id,epoch,epoch_started_ms:started,retired:true,witness_sha256:witness}};
      });
      if(input.kind==='begin')await tx`INSERT INTO telemetry.feed_intent_sessions(session_id,user_id,intent_epoch,epoch_started_ms,
        policy_sha256,status,begin_operation_version,last_control_operation_version,epoch_witness_sha256)
        VALUES(${input.session_id}::uuid,${userId}::uuid,1,${started}::bigint,${lane.policySha256},'active',${result.operation.version}::bigint,${result.operation.version}::bigint,${witness})`;
      else if(input.kind==='reset')await tx`UPDATE telemetry.feed_intent_sessions SET intent_epoch=${epoch}::bigint,
        epoch_started_ms=${started}::bigint,epoch_witness_sha256=${witness},last_control_operation_version=${result.operation.version}::bigint WHERE session_id=${input.session_id}::uuid`;
      else await tx`UPDATE telemetry.feed_intent_sessions SET status='retired',retirement_witness_sha256=${witness},
        last_control_operation_version=${result.operation.version}::bigint WHERE session_id=${input.session_id}::uuid`;
      await tx`UPDATE app.user_feed_state SET feed_version=feed_version+1 WHERE user_id=${userId}::uuid`;
      return {session:await lockedSession(tx,lane,input.session_id),operation:result.operation};
    }).catch(error=>{if(error instanceof ModelOperationError)throw error;throw new ModelOperationError();});
  }
}
