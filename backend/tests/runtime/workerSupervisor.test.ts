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
