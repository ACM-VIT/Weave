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
