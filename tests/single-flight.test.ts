import assert from 'node:assert/strict';
import test from 'node:test';

import { createSingleFlight } from '../src/utils/single-flight';

test('single flight shares one operation across concurrent callers and resets afterward', async () => {
  let calls = 0;
  const operation = createSingleFlight(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return calls;
  });

  assert.deepEqual(await Promise.all(Array.from({ length: 10 }, () => operation())), Array(10).fill(1));
  assert.equal(calls, 1);
  assert.equal(await operation(), 2);
  assert.equal(calls, 2);
});

test('single flight resets after a rejection', async () => {
  let calls = 0;
  const operation = createSingleFlight(async () => {
    calls += 1;
    if (calls === 1) throw new Error('first attempt failed');
    return 'recovered';
  });

  await assert.rejects(operation(), /first attempt failed/);
  assert.equal(await operation(), 'recovered');
});
