import { runReadmeSummaryWorker } from '../../workers/readmeSummaryWorker.js';
import { ReadmeRequestLimiter } from '../../services/readmeSummaryGenerator.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { WorkerSupervisor } from '../../runtime/workerSupervisor.js';

test('adaptive worker polls quickly while active and backs off while idle', async () => {
  const supervisor = new WorkerSupervisor();
  const starts: number[] = [];

  supervisor.registerAdaptive('adaptive', 5, 80, async () => {
    starts.push(Date.now());
    return starts.length === 1 ? 1 : 0;
  });

  supervisor.start();
  await wait(35);
  assert.equal(starts.length, 2);

  await wait(30);
  assert.equal(starts.length, 2);

  await wait(70);
  assert.ok(starts.length >= 3);
  await supervisor.stop();
});

test('adaptive worker rejects an idle interval shorter than its active interval', () => {
  const supervisor = new WorkerSupervisor();
  assert.throws(
    () => supervisor.registerAdaptive('invalid', 100, 50, async () => 0),
    /idle must be at least active/,
  );
});

test('an early wake still checks the reported due time instead of the idle interval', async () => {
  const supervisor = new WorkerSupervisor();
  const dueAt = Date.now()+100;
  let checkedEarly = false;
  let processed = false;
  supervisor.registerAdaptive('delayed', 5, 60_000, async () => {
    if (Date.now() < dueAt) {
      checkedEarly = true;
      return { processed: 0, nextRunInMs: dueAt-Date.now() };
    }
    processed = true;
    return { processed: 1 };
  });
  try {
    supervisor.start();
    supervisor.wake('delayed');
    assert.equal(checkedEarly, true);
    assert.equal(processed, false);
    const deadline = Date.now()+2_000;
    while (!processed) { assert.ok(Date.now()<deadline); await wait(5); }
  } finally { await supervisor.stop(); }
});

test('wake hints coalesce during a run, interrupt idle polling and stop with the worker', async () => {
  const supervisor = new WorkerSupervisor();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0; let concurrent = 0; let maximum = 0;
  const until = async (condition: () => boolean) => {
    const deadline = Date.now()+2000;
    while (!condition()) { assert.ok(Date.now()<deadline); await wait(2); }
  };
  supervisor.registerAdaptive('wakeable', 5, 60_000, async () => {
    calls++; concurrent++; maximum = Math.max(maximum, concurrent);
    try { if (calls === 1) await held; return 0; }
    finally { concurrent--; }
  });
  try {
    supervisor.start();
    for (let n = 0; n < 100; n++) supervisor.wake('wakeable');
    assert.equal(calls, 1);
    release();
    await until(() => calls === 2 && !supervisor.snapshot().wakeable.running);
    await wait(10);
    assert.equal(calls, 2);
    supervisor.wake('wakeable');
    await until(() => calls === 3 && !supervisor.snapshot().wakeable.running);
    assert.equal(maximum, 1);
  } finally { release(); await supervisor.stop(); }
  supervisor.wake('wakeable');
  await wait(10);
  assert.equal(calls, 3);
});

test('worker snapshots cross the process boundary without exporting arbitrary Redis data', async () => {
  const { WorkerTelemetryPublisher, readWorkerTelemetry, parseWorkerSnapshot } = await import('../../observability/workerTelemetry.js');
  const { observeMetric, incrementMetric } = await import('../../observability/metrics.js');
  observeMetric('outbox_feedback_events_per_request',3);
  incrementMetric('outbox_feedback_unacknowledged_total');
  incrementMetric('private_fixture_value',{secret:'must-not-export'});
  let raw: string | null = null;
  let readKeys: string[] = [];
  const redis = {
    eval: async (_script: string, count: number, ...args: (string | number)[]) => {
      assert.equal(count, 16);
      const owner = String(args[count]);
      if (args.length > count + 1) raw = `${owner}\n${args[count + 1]}`;
      else raw = null;
      return 1;
    },
    mget: async (...keys: string[]) => { readKeys = keys; return [raw, ...Array(15).fill(null)]; },
  };
  const publisher = new WorkerTelemetryPublisher(redis, 'outbox');
  await publisher.publish();
  const result = await readWorkerTelemetry(redis);
  assert.equal(result.status, 'ok');
  assert.equal(result.snapshots.length, 1);
  assert.equal(result.snapshots[0].role, 'outbox');
  assert.deepEqual(result.snapshots[0].feedback_delivery,{
    outbox_feedback_events_per_request:{count:1,p50:3,p95:3,p99:3,max:3},outbox_feedback_unacknowledged_total:1,
  });
  assert.equal(readKeys.length, 16);
  const original = String(raw);
  const snapshot = JSON.parse(original.slice(37));
  assert.ok(!original.includes('must-not-export'));
  const {feedback_delivery: _metrics,...legacy}=snapshot;
  assert.ok(parseWorkerSnapshot(original.slice(0,37)+JSON.stringify(legacy)),'older worker snapshots remain readable');
  assert.equal(parseWorkerSnapshot(original.slice(0,37)+JSON.stringify({...snapshot,feedback_delivery:{...snapshot.feedback_delivery,secret:'x'}})),null);
  assert.equal(parseWorkerSnapshot(original.slice(0,37)+JSON.stringify({...snapshot,feedback_delivery:{...snapshot.feedback_delivery,outbox_feedback_events_per_request:{count:1,p50:3,p95:3,p99:3,max:101}}})),null);
  assert.equal(parseWorkerSnapshot(original, snapshot.captured_at_ms + 61_000), null);
  assert.equal(parseWorkerSnapshot(original.slice(0, 37) + JSON.stringify({ ...snapshot, secret: 'must-not-export' })), null);
  assert.equal(parseWorkerSnapshot('x'.repeat(300_000)), null);
  await publisher.stop();
  assert.equal((await readWorkerTelemetry(redis)).status, 'empty');
});

test('worker telemetry retains its overlap guard until the real Redis call settles', async () => {
  const { WorkerTelemetryPublisher } = await import('../../observability/workerTelemetry.js');
  let calls = 0;
  let finish!: (value: number) => void;
  const redis = {
    eval: async () => { calls++; return new Promise<number>(resolve => { finish = resolve; }); },
    mget: async () => [],
  };
  const publisher = new WorkerTelemetryPublisher(redis, 'outbox');
  const first = publisher.publish();
  await Promise.resolve();
  await publisher.publish();
  assert.equal(calls, 1);
  finish(1);
  await first;
});


test('bounded once processing lets ready jobs pass a stalled peer and preserves the total limit',async()=>{
  let release!:()=>void;const stalled=new Promise<void>(resolve=>{release=resolve;});
  let calls=0,active=0,maximum=0,finished=false;const delivered:string[]=[];
  const repoIds=['scoped-repo'];
  const running=runReadmeSummaryWorker({processOne:async ids=>{
    assert.equal(ids,repoIds);const index=calls++;active++;maximum=Math.max(maximum,active);
    if(index===0)await stalled;else await new Promise(resolve=>setImmediate(resolve));
    active--;return {status:'completed',repo_id:String(index)};
  }},{limit:5,concurrency:2,once:true,repoIds,onResult:result=>{delivered.push(result.repo_id!);}}).then(result=>{finished=true;return result;});
  try {
    for(let turn=0;delivered.length<4&&turn<100;turn++)await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(delivered,['1','2','3','4']);assert.equal(maximum,2);assert.equal(calls,5);assert.equal(finished,false);
  } finally {release();}
  assert.deepEqual(await running,{processed:5,failures:0});assert.equal(active,0);
});

test('daemon drains beyond its turn limit while a peer stalls and backs off only on an empty queue',async()=>{
  let release!:()=>void;const stalled=new Promise<void>(resolve=>{release=resolve;});
  const stop=new AbortController();let calls=0,sleeps=0,finished=false;
  const delivered:string[]=[];
  const running=runReadmeSummaryWorker({processOne:async()=>{
    const index=calls++;
    if(index===0)await stalled;
    if(index===9)return {status:'idle'};
    return {status:'completed',repo_id:String(index)};
  }},{limit:1,concurrency:2,once:false,signal:stop.signal,onResult:result=>{delivered.push(result.repo_id!);},
    sleep:async milliseconds=>{assert.equal(milliseconds,3000);sleeps++;stop.abort();},
  }).then(result=>{finished=true;return result;});
  try {
    for(let turn=0;!sleeps&&turn<100;turn++)await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(delivered,['1','2','3','4','5','6','7','8']);
    assert.equal(sleeps,1);assert.equal(finished,false,'stop still owns the stalled processing slot');
  } finally {release();stop.abort();}
  assert.deepEqual(await running,{processed:9,failures:0});
});

for(const failure of ['summary_provider_daily_quota_exhausted','claim-error']) test(`worker stops new claims and drains peers after ${failure}`,async()=>{
  let release!:()=>void;const stalled=new Promise<void>(resolve=>{release=resolve;});let calls=0,settled=false;
  const running=runReadmeSummaryWorker({processOne:async()=>{
    if(calls++===0){if(failure==='claim-error')throw new Error(failure);return {status:'failed',error:failure};}
    await stalled;return {status:'completed'};
  }},{limit:10,concurrency:2,once:false,onResult:()=>{}});
  const observed=running.then(result=>({result}),error=>({error})).then(result=>{settled=true;return result;});
  try {
    await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);assert.equal(settled,false);
  } finally {release();}
  const outcome=await observed;assert.equal(calls,2);
  if(failure==='claim-error'){assert.ok('error' in outcome);assert.equal(outcome.error.message,'claim-error');}
  else {assert.ok('result' in outcome);assert.deepEqual(outcome.result,{processed:2,failures:1});}
});

test('stop wakes idle workers without waiting for their next poll or claiming more work',async()=>{
  const stop=new AbortController();let calls=0,finished=false;
  const running=runReadmeSummaryWorker({processOne:async()=>{calls++;return {status:'idle'};}},
    {limit:10,concurrency:2,once:false,signal:stop.signal,onResult:()=>{}}).then(()=>{finished=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);assert.equal(finished,false);
  stop.abort();await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,true);assert.equal(calls,2);await running;
});


test('concurrent digest attempts and repairs share distinct provider RPM reservations',async()=>{
  const waits:number[]=[];
  const limiter=new ReadmeRequestLimiter(1,()=>0,async milliseconds=>{waits.push(milliseconds);});
  await Promise.all(Array.from({length:4},()=>limiter.wait()));
  assert.deepEqual(waits,[60000,120000,180000]);
});
