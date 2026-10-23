import { decimalInt64, ModelOperationError } from '../contracts/modelOperations.js';
import type { MlModelOperationResponse, MlProfileWithdrawalResponse, MlModelOperationStatusResponse, MlAppliedModelContext } from '../contracts/ml.v2.js';
const sha=/^[a-f0-9]{64}$/;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function modelRecord(value:unknown):Record<string,unknown>{
 if(!value || typeof value!=='object' || Array.isArray(value))throw new ModelOperationError();return value as Record<string,unknown>;
}
function exactKeys(row:Record<string,unknown>,allowed:readonly string[],required:readonly string[]=allowed):void{
 if(Object.keys(row).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(row,key)))throw new ModelOperationError();
}
function string(value:unknown,pattern?:RegExp):string{if(typeof value!=='string' || (pattern && !pattern.test(value)))throw new ModelOperationError();return value;}
function decimal(value:unknown,positive=false):string{return decimalInt64(string(value),positive);}
function schema(row:Record<string,unknown>):void{if(row.schema_version!==1)throw new ModelOperationError();}
export function parseModelAcknowledgement(value:unknown):MlModelOperationResponse{
 const body=modelRecord(value);schema(body);exactKeys(body,['schema_version','operations']);if(!Array.isArray(body.operations)||body.operations.length>50)throw new ModelOperationError();
 return {schema_version:1,operations:body.operations.map(value=>{const row=modelRecord(value);exactKeys(row,['operation_id','model_operation_version','source_envelope_sha256','status','withdrawal_sha256'],['operation_id','model_operation_version','source_envelope_sha256','status']);
  if(!['accepted','duplicate','withdrawal_accepted'].includes(string(row.status)))throw new ModelOperationError();
  return {operation_id:string(row.operation_id,uuid),model_operation_version:decimal(row.model_operation_version,true),
   source_envelope_sha256:string(row.source_envelope_sha256,sha),status:row.status as 'accepted'|'duplicate'|'withdrawal_accepted',
   ...(row.withdrawal_sha256==null?{}:{withdrawal_sha256:string(row.withdrawal_sha256,sha)})};})};
}
export function parseWithdrawalAcknowledgement(value:unknown):MlProfileWithdrawalResponse{
 const body=modelRecord(value);schema(body);exactKeys(body,['schema_version','withdrawals']);if(!Array.isArray(body.withdrawals)||body.withdrawals.length>50)throw new ModelOperationError();
 return {schema_version:1,withdrawals:body.withdrawals.map(value=>{const row=modelRecord(value);exactKeys(row,['operation_id','model_operation_version','source_envelope_sha256','status','withdrawal_sha256']);
  if(row.status!=='accepted'&&row.status!=='duplicate')throw new ModelOperationError();
  return {operation_id:string(row.operation_id,uuid),model_operation_version:decimal(row.model_operation_version,true),
   source_envelope_sha256:string(row.source_envelope_sha256,sha),withdrawal_sha256:string(row.withdrawal_sha256,sha),status:row.status};})};
}
export function parseModelOperationStatus(value:unknown):MlModelOperationStatusResponse{
 const row=modelRecord(value);schema(row);
 exactKeys(row,['schema_version','user_id','operation_id','model_operation_version','source_envelope_sha256','status','basis_status','applied_profile_version','applied_operation_version','applied_feedback_version','current_head','operation_head','withdrawal_sha256'],['schema_version','user_id','operation_id','model_operation_version','source_envelope_sha256','status','basis_status']);
 if(!['pending','applied','withdrawn_profile','rejected_capacity'].includes(string(row.status)) || !['missing','awaiting_profile','ready'].includes(string(row.basis_status)))throw new ModelOperationError();
 return {schema_version:1,user_id:string(row.user_id,uuid),operation_id:string(row.operation_id,uuid),model_operation_version:decimal(row.model_operation_version,true),
  source_envelope_sha256:string(row.source_envelope_sha256,sha),status:row.status as MlModelOperationStatusResponse['status'],basis_status:row.basis_status as MlModelOperationStatusResponse['basis_status'],
  ...(row.applied_profile_version==null?{}:{applied_profile_version:decimal(row.applied_profile_version,true)}),
  ...(row.applied_operation_version==null?{}:{applied_operation_version:decimal(row.applied_operation_version,true)}),
  ...(row.applied_feedback_version==null?{}:{applied_feedback_version:decimal(row.applied_feedback_version)}),
  ...(row.current_head==null?{}:{current_head:string(row.current_head,sha)}),...(row.operation_head==null?{}:{operation_head:string(row.operation_head,sha)}),
  ...(row.withdrawal_sha256==null?{}:{withdrawal_sha256:string(row.withdrawal_sha256,sha)})};
}
export function parseAppliedModelContext(value:unknown):MlAppliedModelContext{
 const row=modelRecord(value);schema(row);
 exactKeys(row,['schema_version','user_id','session_id','epoch','profile_version','applied_operation_version','applied_feedback_version','state_sha256','head','policy_sha256','effective_vector_sha256','session_witness_sha256','as_of_ms','valid_until_ms','explicit_negative_repo_ids']);
 if(!Array.isArray(row.explicit_negative_repo_ids)||row.explicit_negative_repo_ids.length>256)throw new ModelOperationError();
 return {schema_version:1,user_id:string(row.user_id,uuid),session_id:string(row.session_id,uuid),epoch:decimal(row.epoch,true),
  profile_version:decimal(row.profile_version,true),applied_operation_version:decimal(row.applied_operation_version,true),applied_feedback_version:decimal(row.applied_feedback_version),
  state_sha256:string(row.state_sha256,sha),head:string(row.head,sha),policy_sha256:string(row.policy_sha256,sha),effective_vector_sha256:string(row.effective_vector_sha256,sha),
  session_witness_sha256:string(row.session_witness_sha256,sha),as_of_ms:decimal(row.as_of_ms),valid_until_ms:decimal(row.valid_until_ms,true),
  explicit_negative_repo_ids:row.explicit_negative_repo_ids.map(value=>string(value,uuid))};
}
