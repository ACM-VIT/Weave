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

test('worker snapshots cross the process boundary without exporting arbitrary Redis data', async () => {
  const { WorkerTelemetryPublisher, readWorkerTelemetry, parseWorkerSnapshot } = await import('../../observability/workerTelemetry.js');
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
  assert.equal(readKeys.length, 16);
  const original = String(raw);
  const snapshot = JSON.parse(original.slice(37));
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
