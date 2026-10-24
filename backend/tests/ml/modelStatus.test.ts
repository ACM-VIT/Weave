import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {MlV2Client} from '../../services/mlService.js';
const id='00000000-0000-4000-8000-000000000035';
test('terminal session dependency status remains distinct over authenticated provider HTTP',async()=>{
 let status='rejected_session_dependency';const server=createServer(async(request,response)=>{
  assert.equal(request.url,'/api/v2/model-operation-status');assert.equal(request.headers['x-internal-secret'],'owned-terminal-status');
  for await(const _ of request){};
  response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({schema_version:1,user_id:id,operation_id:id,model_operation_version:'3',source_envelope_sha256:'a'.repeat(64),status,basis_status:'ready',applied_profile_version:'1',applied_operation_version:'3',applied_feedback_version:'1',current_head:'b'.repeat(64),operation_head:'c'.repeat(64)}));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address==='object');
 const client=new MlV2Client({baseUrl:`http://127.0.0.1:${address.port}`,internalSecret:'owned-terminal-status',timeoutMs:1000,maxResponseBytes:8192});
 const input={schema_version:1 as const,user_id:id,operation_id:id,model_operation_version:'3',source_envelope_sha256:'a'.repeat(64)};
 try{
  const result=await client.modelOperationStatus(input);assert.equal(result.status,'rejected_session_dependency');assert.equal(result.applied_operation_version,'3');assert.equal(result.applied_feedback_version,'1');assert.equal(result.operation_head,'c'.repeat(64));
  status='rejected_unregistered_private_value';await assert.rejects(client.modelOperationStatus(input),/MODEL_OPERATION/);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
