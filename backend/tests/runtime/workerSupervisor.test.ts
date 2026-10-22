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
