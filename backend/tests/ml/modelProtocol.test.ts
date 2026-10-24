import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, decimalInt64, type CanonicalValue, modelDigest } from "../../contracts/modelOperations.js";
import { createServer } from "node:http";
import { MlV2Client } from "../../services/mlService.js";

describe("modelCanonical", () => {
  test('canonical operation bytes use Unicode code-point key ordering, original strings and exact decimal int64',()=>{
   assert.equal(canonicalJson({'\u{10000}':1,'\uE000':2}),'{"\uE000":2,"\u{10000}":1}');
   assert.equal(canonicalJson({raw:'{ "Tarun": "Ω" }'}),'{"raw":"{ \\"Tarun\\": \\"Ω\\" }"}');
   assert.equal(decimalInt64('9223372036854775807',true),'9223372036854775807');
   for(const value of ['9223372036854775808','01','-1','1'.repeat(100),''])assert.throws(()=>decimalInt64(value));
   assert.throws(()=>canonicalJson(new Array<CanonicalValue>(1)));
   assert.throws(()=>canonicalJson('\ud800'));
  });
});

describe("modelTransport", () => {
  const id='00000000-0000-4000-8000-000000000035';

  test('model HTTP transport preserves frozen Unicode and opaque feedback bytes and sanitizes failed responses',async()=>{
   const operationJson=JSON.stringify({original_feedback_json:'{ "note": "Tarun Ω" }'});
   let fail=false,malformed=false;const received:string[]=[];
   const server=createServer(async(request,response)=>{
    let raw='';for await(const chunk of request)raw+=chunk;
    assert.equal(request.headers['x-internal-secret'],'fixture-secret');received.push(raw);
    response.writeHead(fail?500:200,{'content-type':'application/json'});
    response.end(JSON.stringify(fail?{detail:'PRIVATE REVOKED CONTEXT'}:{schema_version:1,operations:[{operation_id:id,
     model_operation_version:'9007199254740993',source_envelope_sha256:modelDigest(operationJson),status:'accepted',...(malformed?{unexpected:'PRIVATE REVOKED CONTEXT'}:{})}]}));
   });
   await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
   const client=new MlV2Client({baseUrl:`http://127.0.0.1:${address.port}`,internalSecret:'fixture-secret',timeoutMs:1000,maxResponseBytes:8192});
   try{
    const first=await client.deliverModelOperations({schema_version:1,operations:[{operation_json:operationJson}]});
    assert.equal(first.accepted,true);assert.equal(first.response_body?.operations[0].model_operation_version,'9007199254740993');
    assert.equal(JSON.parse(received[0]).operations[0].operation_json,operationJson);
    malformed=true;const invalid=await client.deliverModelOperations({schema_version:1,operations:[{operation_json:operationJson}]});
    assert.equal(invalid.accepted,false);assert.doesNotMatch(JSON.stringify(invalid),/PRIVATE|REVOKED/);
    malformed=false;fail=true;const failed=await client.deliverModelOperations({schema_version:1,operations:[{operation_json:operationJson}]});
    assert.equal(failed.accepted,false);assert.doesNotMatch(JSON.stringify(failed),/PRIVATE|REVOKED/);
   }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
});

describe("modelStatus", () => {
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
});
