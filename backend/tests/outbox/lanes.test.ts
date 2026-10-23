import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { DeliveryResult, MlFeedbackBatch } from '../../contracts/ml.v2.js';
import type { OutboxTransportPort } from '../../ports/outboxTransportPort.js';
import { OutboxService, type OutboxRow, type OutboxClaimOptions } from '../../services/outboxService.js';
import { OutboxDeliveryLanes, feedbackBatchSize } from '../../workers/outboxDeliveryLanes.js';
import { WorkerSupervisor } from '../../runtime/workerSupervisor.js';

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function row(type: OutboxRow['job_type'] = 'feedback', attempts = 1): OutboxRow {
  const id = randomUUID();
  return { outbox_id: id, job_type: type, aggregate_id: randomUUID(), idempotency_key: id, payload: {
    event_id: id, user_id: randomUUID(), repo_id: randomUUID(), feedback_version: '1', event_type: 'like',
    occurred_at: '2026-10-23T00:00:00Z', dwell_ms: null,
  }, attempts, created_at: new Date().toISOString(), claim_token: randomUUID() };
}
function fixture(items: OutboxRow[], feedback?: (batch: MlFeedbackBatch) => Promise<DeliveryResult>) {
  const delivered: string[] = []; const failed: Array<{ row: OutboxRow; retryable: boolean; delay?: number }> = [];
  const claims: Array<{ limit: number; options: OutboxClaimOptions }> = [];
  const outbox = {
    claim: async (limit: number, _lease: unknown, options: OutboxClaimOptions) => {
      claims.push({ limit, options });
      const found = items.filter(item => options.jobTypes?.includes(item.job_type)
        && (!options.attempts || (options.attempts === 'first' ? item.attempts === 1 : item.attempts > 1))).slice(0, limit);
      for (const item of found) items.splice(items.indexOf(item), 1);
      return found;
    },
    nextRunInMs: async () => undefined,
    markDelivered: async (item: OutboxRow) => { delivered.push(item.outbox_id); return true; },
    markFailed: async (item: OutboxRow, _error: string, retryable: boolean, delay?: number) => { failed.push({ row: item, retryable, delay }); },
  } as unknown as OutboxService;
  const transport = {
    deliverFeedback: feedback ?? (async (batch: MlFeedbackBatch) => ({ accepted: true, status_code: 202, retryable: false,
      response_body: { accepted: batch.events.length, duplicates: 0, durable: true, acknowledged_event_ids: batch.events.map(event => event.event_id) } })),
    deliverOnboarding: async () => ({ accepted: true, status_code: 200, retryable: false }),
    deliverRepositoryRefresh: async () => ({ accepted: true, status_code: 200, retryable: false }),
  } as unknown as OutboxTransportPort;
  return { outbox, transport, delivered, failed, claims };
}

test('successful retry wakes a first-attempt lane sleeping behind its predecessor', async () => {
  const first = row('feedback',2), next = row();
  const entered=gate(), release=gate(), resumed=gate();
  const f=fixture([first,next],async batch=>{
    if(batch.events[0]!.event_id===first.payload.event_id){entered.release();await release.promise;}
    else resumed.release();
    return{accepted:true,status_code:202,retryable:false,response_body:{accepted:1,duplicates:0,durable:true,acknowledged_event_ids:[batch.events[0]!.event_id]}};
  });
  const claim=f.outbox.claim.bind(f.outbox);
  f.outbox.claim=async(limit,lease,options)=>options?.attempts==='first'&&!f.delivered.includes(first.outbox_id)?[]:claim(limit,lease,options);
  const supervisor=new WorkerSupervisor();
  const lanes=new OutboxDeliveryLanes(f.outbox,f.transport,1,Date.now,()=>supervisor.wake('first'));
  supervisor.registerAdaptive('first',10,2000,()=>lanes.runOnce('feedback'));
  supervisor.registerAdaptive('retry',10,2000,()=>lanes.runOnce('feedback-retry'));
  supervisor.start();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    await entered.promise;
    while(supervisor.snapshot().first.running)await new Promise(resolve=>setImmediate(resolve));
    release.release();
    await Promise.race([resumed.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Retry did not wake the idle first-attempt lane.')),500);})]);
    assert.ok(f.delivered.includes(first.outbox_id));
  } finally {clearTimeout(timer);release.release();await supervisor.stop();}
});

test('feedback RPCs preserve delivery histograms for success, rejection, failure and timeout',async()=>{
  const {snapshotHistograms}=await import('../../observability/metrics.js');
  for(const outcome of ['success','rejected','failure','timeout','thrown']as const){
    const label=JSON.stringify({operation:'feedback',stage:'outbox_delivery',outcome:outcome==='thrown'?'failure':outcome});
    const before=snapshotHistograms()[label]?.count??0;
    const f=fixture([row()],async batch=>{
      if(outcome==='thrown')throw new Error('Controlled transport failure.');
      return{accepted:outcome==='success',retryable:outcome!=='rejected',status_code:outcome==='success'?202:outcome==='rejected'?400:outcome==='timeout'?504:503,
        ...(outcome==='timeout'?{failure_kind:'timeout' as const}:{}),
        response_body:{accepted:1,duplicates:0,durable:true,acknowledged_event_ids:[batch.events[0]!.event_id]}};
    });
    const pending=new OutboxDeliveryLanes(f.outbox,f.transport).runOnce('feedback');
    if(outcome==='thrown')await assert.rejects(pending,/Controlled/);else await pending;
    assert.equal(snapshotHistograms()[label]?.count,before+1,`delivery outcome ${outcome}`);
  }
});

test('slow repository delivery does not block feedback or onboarding, and busy slots do not claim ahead', async () => {
  const hold = gate(); const entered = gate();
  const f = fixture([row('repo_refresh'), row(), row('onboard')]);
  f.transport.deliverRepositoryRefresh = async () => { entered.release(); await hold.promise; return { accepted: true, status_code: 200, retryable: false }; };
  const lanes = new OutboxDeliveryLanes(f.outbox, f.transport);
  const slow = lanes.runOnce('repository');
  await entered.promise;
  try {
    const claimed = f.claims.length;
    assert.deepEqual(await lanes.runOnce('repository'), { processed: 0 });
    assert.equal(f.claims.length, claimed);
    assert.equal((await lanes.runOnce('feedback')).processed, 1);
    assert.equal((await lanes.runOnce('onboard')).processed, 1);
    assert.equal(f.delivered.length, 2);
  } finally { hold.release(); await slow; }
  assert.equal(f.delivered.length, 3);
});

test('new feedback is bounded per RPC while retry slots always claim one event', async () => {
  const f = fixture([...Array.from({ length: 8 }, () => row()), row('feedback', 2)]);
  const sizes: number[] = [];
  const send = f.transport.deliverFeedback;
  f.transport.deliverFeedback = async batch => { sizes.push(batch.events.length); return send(batch); };
  const lanes = new OutboxDeliveryLanes(f.outbox, f.transport, 3);
  assert.equal((await lanes.runOnce('feedback')).processed, 3);
  assert.equal((await lanes.runOnce('feedback-retry')).processed, 1);
  assert.deepEqual(sizes, [3, 1]);
  assert.deepEqual(f.claims.map(claim => claim.limit), [3, 1]);
});

test('partial acknowledgement finalizes only explicit identities; malformed acknowledgements finalize none', async () => {
  const first = row(); const second = row();
  const f = fixture([first, second], async () => ({ accepted: true, retryable: false, status_code: 202,
    response_body: { accepted: 1, duplicates: 0, durable: true, acknowledged_event_ids: [first.payload.event_id] } }));
  await new OutboxDeliveryLanes(f.outbox, f.transport).runOnce('feedback');
  assert.deepEqual(f.delivered, [first.outbox_id]);
  assert.deepEqual(f.failed.map(item => [item.row.outbox_id, item.retryable]), [[second.outbox_id, true]]);
  const bad = fixture([row(), row()], async () => ({ accepted: true, retryable: false, status_code: 202,
    response_body: { accepted: 2, duplicates: 0, durable: true } }));
  await new OutboxDeliveryLanes(bad.outbox, bad.transport).runOnce('feedback');
  assert.deepEqual(bad.delivered, []); assert.ok(bad.failed.every(item => item.retryable));
});

test('batch conflict or ambiguous timeout retries every unknown member; singleton conflict is terminal', async () => {
  for (const status of [0, 409, 503]) {
    const send = async () => ({ accepted: false, retryable: status !== 409, status_code: status });
    const f = fixture([row(), row()], send);
    await new OutboxDeliveryLanes(f.outbox, f.transport).runOnce('feedback');
    assert.equal(f.failed.length, 2); assert.ok(f.failed.every(item => item.retryable));
  }
  const f = fixture([row('feedback', 2)], async () => ({ accepted: false, retryable: false, status_code: 409 }));
  await new OutboxDeliveryLanes(f.outbox, f.transport).runOnce('feedback-retry');
  assert.equal(f.failed[0]?.retryable, false);
});

test('feedback backpressure stops both feedback slots before claiming; retry deadlines remain visible', async () => {
  let now = 1000;
  const f = fixture([row(), row(), row('feedback', 2)], async () => ({ accepted: false, retryable: true,
    status_code: 429, retry_after_ms: 2000 }));
  const lanes = new OutboxDeliveryLanes(f.outbox, f.transport, 2, () => now);
  await lanes.runOnce('feedback');
  const count = f.claims.length;
  assert.deepEqual(await lanes.runOnce('feedback'), { processed: 0, nextRunInMs: 2000 });
  assert.deepEqual(await lanes.runOnce('feedback-retry'), { processed: 0, nextRunInMs: 2000 });
  assert.equal(f.claims.length, count); assert.ok(f.failed.every(item => item.delay === 2000));
  now += 2000;
  assert.equal((await lanes.runOnce('feedback-retry')).processed, 1);
});

test('supervisor shutdown drains its admitted RPC without starting another claim', async () => {
  const hold = gate(); const entered = gate();
  const f = fixture([row(), row()], async batch => { entered.release(); await hold.promise;
    return { accepted: true, retryable: false, status_code: 202, response_body: { accepted: 1, duplicates: 0,
      durable: true, acknowledged_event_ids: [batch.events[0]!.event_id] } }; });
  const lanes = new OutboxDeliveryLanes(f.outbox, f.transport, 1);
  const supervisor = new WorkerSupervisor();
  supervisor.registerAdaptive('test-feedback', 1, 20, () => lanes.runOnce('feedback'));
  supervisor.start(); await entered.promise;
  const stopping = supervisor.stop(); supervisor.wake('test-feedback'); hold.release(); await stopping;
  assert.equal(f.claims.length, 1); assert.equal(f.delivered.length, 1);
});

test('batch configuration rejects unbounded or malformed values', () => {
  for (const value of ['0', '101', '1.5', 'no']) assert.throws(() => feedbackBatchSize(value));
  assert.equal(feedbackBatchSize('1'), 1); assert.equal(feedbackBatchSize('100'), 100);
});
