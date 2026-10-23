import assert from 'node:assert/strict';
import test from 'node:test';
import { FeedWaitCoordinator } from '../../services/feedWaitCoordinator.js';

const unavailable = () => new Error('wait expired');
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

test('a duplicate burst shares durable probes and a notification only accelerates the next read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0.5);
  const coordinator = new FeedWaitCoordinator<string>(25, unavailable);
  let reads = 0;
  let durable: string | undefined;
  const probe = async () => { reads++; return durable; };
  const burst = Array.from({ length: 100 }, () => coordinator.wait('user:version', probe, 2_000));
  await flush();
  assert.equal(reads, 1);
  t.mock.timers.tick(25); await flush();
  assert.equal(reads, 2);
  coordinator.notify('user:version'); await flush();
  assert.equal(reads, 3, 'a wake hint must re-read durable state, never complete from the notification');
  durable = 'committed serve';
  coordinator.notify('user:version');
  assert.deepEqual(await Promise.all(burst), Array(100).fill(durable));
  assert.equal(reads, 4);
  t.mock.timers.tick(10_000); await flush();
  assert.equal(reads, 4, 'completed groups leave no polling timer');
  await coordinator.drain();
  t.diagnostic(`100 duplicate observers used ${reads} durable probes, including an early wake before commit.`);
});

test('independent coordinators recover a missed notification through bounded polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = new FeedWaitCoordinator<boolean>(25, unavailable);
  const b = new FeedWaitCoordinator<boolean>(25, unavailable);
  let ready = false;
  let reads = 0;
  const probe = async () => { reads++; return ready ? true : undefined; };
  const waits = [a.wait('shared', probe, 1_000), b.wait('shared', probe, 1_000)];
  await flush();
  ready = true;
  a.notify('shared'); // b models another process that did not receive this hint.
  await flush();
  t.mock.timers.tick(250); await flush();
  assert.deepEqual(await Promise.all(waits), [true, true]);
  assert.equal(reads, 4);
  await Promise.all([a.drain(), b.drain()]);
});

test('long waits continue polling at the cap rather than doubling indefinitely', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0.5);
  const coordinator = new FeedWaitCoordinator<string>(25, unavailable);
  let reads = 0;
  let ready = false;
  const result = coordinator.wait('key', async () => { reads++; return ready ? 'committed' : undefined; }, 5_000);
  await flush();
  for (const spacing of [25, 50, 100, 200, 250, 250, 250]) {
    const previous = reads;
    t.mock.timers.tick(spacing - 1); await flush();
    assert.equal(reads, previous, 'the next probe must wait for its backoff');
    t.mock.timers.tick(1); await flush();
    assert.equal(reads, previous + 1, 'later probes must stay within the polling cap');
  }
  ready = true;
  t.mock.timers.tick(250); await flush();
  assert.equal(await result, 'committed');
  await coordinator.drain();
});

test('an original sibling receives completion after another observer cancels', async () => {
  const coordinator = new FeedWaitCoordinator<string>(25, unavailable);
  const controller = new AbortController();
  let complete!: (value: string) => void;
  const held = new Promise<string>(resolve => { complete = resolve; });
  let reads = 0;
  const cancelled = coordinator.wait('key', async () => { reads++; return held; }, 1_000, controller.signal);
  const sibling = coordinator.wait('key', async () => { throw new Error('must share the original read'); }, 1_000);
  const rejected = assert.rejects(cancelled, /observer left/);
  await flush(); controller.abort(new Error('observer left')); await rejected;
  complete('durable serve');
  assert.equal(await sibling, 'durable serve');
  assert.equal(reads, 1);
  await coordinator.drain();
});

test('cancellation isolates observers and never duplicates an outstanding abandoned probe', async () => {
  const coordinator = new FeedWaitCoordinator<string>(25, unavailable, 1);
  let complete!: (value: string) => void;
  let reads = 0;
  const held = new Promise<string>(resolve => { complete = resolve; });
  const first = new AbortController();
  const second = new AbortController();
  const a = coordinator.wait('key', async () => { reads++; return held; }, 1_000, first.signal);
  const b = coordinator.wait('key', async () => { throw new Error('must join the first probe'); }, 1_000, second.signal);
  await flush();
  const rejectedA = assert.rejects(a, /cancel first/);
  first.abort(new Error('cancel first')); await rejectedA;
  assert.equal(coordinator.unobservedProbeCount, 0, 'the remaining observer still owns this shared read');
  const rejectedB = assert.rejects(b, /cancel second/);
  second.abort(new Error('cancel second')); await rejectedB;
  assert.equal(coordinator.unobservedProbeCount, 1);
  await assert.rejects(coordinator.wait('other', async () => 'wrong', 100), /wait expired/);
  const rejoined = coordinator.wait('key', async () => { throw new Error('must reuse outstanding read'); }, 1_000);
  let drained = false;
  const drain = coordinator.drain().then(() => { drained = true; });
  await flush(); assert.equal(drained, false);
  complete('durable result');
  assert.equal(await rejoined, 'durable result');
  await drain;
  assert.equal(reads, 1);
  assert.equal(coordinator.unobservedProbeCount, 0);
  assert.equal(await coordinator.wait('other', async () => 'recovered capacity', 100), 'recovered capacity');
});

test('timeouts and failed probes release observer capacity and stop polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const coordinator = new FeedWaitCoordinator<string>(25, unavailable, 1, 1, 1);
  let reads = 0;
  const expired = assert.rejects(coordinator.wait('key', async () => { reads++; return undefined; }, 50), /wait expired/);
  await flush();
  t.mock.timers.tick(50); await flush(); await expired;
  const finishedReads = reads;
  t.mock.timers.tick(5_000); await flush();
  assert.equal(reads, finishedReads);
  await assert.rejects(coordinator.wait('key', async () => { throw new Error('durable read failed'); }, 50), /durable read failed/);
  assert.equal(await coordinator.wait('replacement', async () => 'ready', 50), 'ready');
  await coordinator.drain();
});
