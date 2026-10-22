import assert from 'node:assert/strict';
import test from 'node:test';
import { workerErrorSummary } from '../../runtime/workerError.js';
import { FeedPrewarmWorker } from '../../workers/feedPrewarmWorker.js';
import { MlRecommendationError } from '../../services/mlService.js';

test('worker diagnostics retain operational codes without arbitrary messages or connection details', () => {
  const cause = Object.assign(new Error('postgres://user:secret@private/database'), { code: 'ECONNREFUSED' });
  const error = new TypeError('fetch failed', { cause });
  assert.deepEqual(workerErrorSummary(error), {
    name: 'TypeError', reason: 'transport_failed', cause_code: 'ECONNREFUSED',
  });
  const databaseError = Object.assign(new Error('password authentication failed for secret-user'), {
    name: 'PostgresError', code: '28P01', detail: 'private SQL parameters',
  });
  assert.deepEqual(workerErrorSummary(databaseError), { name: 'PostgresError', code: '28P01' });
  assert.deepEqual(workerErrorSummary(new Error('ML recommendation circuit is open.')), {
    name: 'Error', reason: 'ml_circuit_open',
  });
  assert.deepEqual(workerErrorSummary(new Error('constructor')), { name: 'Error' });
  error.cause = error;
  assert.deepEqual(workerErrorSummary(error), { name: 'TypeError', reason: 'transport_failed' });
});

test('failed prewarm logs a safe dependency diagnosis and reports its durable retry deadline', async t => {
  const log = t.mock.method(console, 'error', () => {});
  const job = { userId: 'test', feedVersion: 1n, profileVersion: 1n, claimToken: 'claim', attempts: 1 };
  let retried = false;
  const worker = new FeedPrewarmWorker({
    claim: async () => job,
    finish: async () => { assert.fail('failed generation cannot complete'); },
    retry: async claimed => { assert.equal(claimed, job); retried = true; },
    nextRunInMs: async () => 2_000,
  }, { generate: async () => { throw new MlRecommendationError('secret response payload', 'dependency', 503); } });
  assert.deepEqual(await worker.runOnce(), { processed: 1, nextRunInMs: 2_000 });
  assert.equal(retried, true);
  assert.equal(log.mock.callCount(), 1);
  assert.deepEqual(log.mock.calls[0].arguments[1], {
    name: 'MlRecommendationError', kind: 'dependency', status: 503,
  });
  assert.equal(JSON.stringify(log.mock.calls[0].arguments).includes('secret'), false);
});
