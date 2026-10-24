import assert from 'node:assert/strict';
import test from 'node:test';
import {modelDigest} from '../../contracts/modelOperations.js';
import {snapshotHistograms} from '../../observability/metrics.js';
import {mlOperation,snapshotSpans} from '../../observability/tracing.js';
import {parseWorkerSnapshot} from '../../observability/workerTelemetry.js';
import type {OutboxRow,OutboxService} from '../../services/outboxService.js';
import type {OutboxTransportPort} from '../../ports/outboxTransportPort.js';
import {OutboxWorker} from '../../workers/outboxWorker.js';

for(const [scenario,outcome] of [['accepted','success'],['wrong-source','failure'],['rejected','rejected'],['timeout','timeout']] as const)test(`ordered delivery records queue age and validated ${scenario} outcome without private inputs`,async()=>{
 const operation='{"kind":"feedback","operation":{"original_feedback_json":"PRIVATE_METRIC_SOURCE"}}';
 const row:OutboxRow={outbox_id:'00000000-0000-4000-8000-000000000035',aggregate_id:'00000000-0000-4000-8000-000000000036',
  job_type:'model_operation',idempotency_key:'private-fixture',payload:{},created_at:new Date(Date.now()-5000).toISOString(),attempts:1,
  claim_token:'00000000-0000-4000-8000-000000000037',model_operation_version:'1',operation_json:operation,source_envelope_sha256:modelDigest(operation)};
 const count=(stage:string,result:string)=>snapshotHistograms()[JSON.stringify({operation:'model_operation',stage,outcome:result})]?.count??0;
 const beforeAge=count('outbox_age','success'),beforeDelivery=count('outbox_delivery',outcome);
 const service={prepareModelDelivery:async()=>row,markDelivered:async()=>{},markFailed:async()=>{}} as unknown as OutboxService;
 const unused=async()=>({accepted:false,retryable:true,status_code:503});
 const transport:OutboxTransportPort={deliverFeedback:unused,deliverOnboarding:unused,deliverRepositoryIndex:unused,deliverRepositoryRefresh:unused,deliverModelOperations:async()=>scenario==='rejected'?{accepted:false,retryable:true,status_code:429}:
  scenario==='timeout'?{accepted:false,retryable:true,status_code:0,failure_kind:'timeout'}:
  {accepted:true,retryable:false,status_code:202,response_body:{schema_version:1,operations:[{operation_id:row.outbox_id,model_operation_version:'1',
    source_envelope_sha256:scenario==='wrong-source'?'b'.repeat(64):row.source_envelope_sha256!,status:'accepted'}]}}};
 assert.equal((await new OutboxWorker(service,transport).deliverClaimed(row)).accepted,scenario==='accepted');
 assert.equal(count('outbox_age','success'),beforeAge+1);assert.equal(count('outbox_delivery',outcome),beforeDelivery+1);
 const metrics=snapshotHistograms(),spans=snapshotSpans();assert.doesNotMatch(JSON.stringify({metrics,spans}),/PRIVATE_METRIC_SOURCE|original_feedback_json|private-fixture/);
 const owner='00000000-0000-4000-8000-000000000099';
 assert.ok(parseWorkerSnapshot(owner+'\n'+JSON.stringify({process_id:owner,role:'outbox',captured_at_ms:Date.now(),stage_duration_ms:metrics,trace_spans:spans})),
  'fleet snapshots accept the same fixed ordered-operation labels');
});
test('ordered ML endpoints have fixed bounded telemetry names',()=>{
 assert.deepEqual(['/api/v2/model-operations','/api/v2/model-operation-withdrawals','/api/v2/model-operation-status','/api/v2/model-authority'].map(mlOperation),
  ['model_operation','model_withdrawal','model_status','model_authority']);
 assert.equal(mlOperation('/api/v2/model-operations/private-user'),'other');
});
