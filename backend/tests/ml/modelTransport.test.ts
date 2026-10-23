import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { MlV2Client } from '../../services/mlService.js';
import { modelDigest } from '../../contracts/modelOperations.js';
const id='00000000-0000-4000-8000-000000000035';
test('model HTTP transport preserves frozen Unicode and opaque feedback bytes and sanitizes failed responses',async()=>{
 const operationJson=JSON.stringify({original_feedback_json:'{ "note": "Tarun Ω" }'});
 let fail=false;const received:string[]=[];
 const server=createServer(async(request,response)=>{
  let raw='';for await(const chunk of request)raw+=chunk;
  assert.equal(request.headers['x-internal-secret'],'fixture-secret');received.push(raw);
  response.writeHead(fail?500:200,{'content-type':'application/json'});
  response.end(JSON.stringify(fail?{detail:'PRIVATE REVOKED CONTEXT'}:{schema_version:1,operations:[{operation_id:id,
   model_operation_version:'9007199254740993',source_envelope_sha256:modelDigest(operationJson),status:'accepted'}]}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
 const client=new MlV2Client({baseUrl:`http://127.0.0.1:${address.port}`,internalSecret:'fixture-secret',timeoutMs:1000,maxResponseBytes:8192});
 try{
  const first=await client.deliverModelOperations({schema_version:1,operations:[{operation_json:operationJson}]});
  assert.equal(first.accepted,true);assert.equal(first.response_body?.operations[0].model_operation_version,'9007199254740993');
  assert.equal(JSON.parse(received[0]).operations[0].operation_json,operationJson);
  fail=true;const failed=await client.deliverModelOperations({schema_version:1,operations:[{operation_json:operationJson}]});
  assert.equal(failed.accepted,false);assert.doesNotMatch(JSON.stringify(failed),/PRIVATE|REVOKED/);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
