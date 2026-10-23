import assert from 'node:assert/strict';
import test from 'node:test';

import type { OutboxTransportPort } from '../../ports/outboxTransportPort.js';
import {
  OutboxService,
  RepositoryIndexCompletionConflictError,
  type OutboxRow,
} from '../../services/outboxService.js';
import { OutboxWorker } from '../../workers/outboxWorker.js';

function row(id: string): OutboxRow {
  return {
    outbox_id: id,
    job_type: 'onboard',
    aggregate_id: '00000000-0000-4000-8000-000000000010',
    idempotency_key: `onboard:${id}`,
    payload: {
      job_id: id,
      user_id: '00000000-0000-4000-8000-000000000010',
      profile_version: 1,
      profile: { username: 'canary-user' },
    },
    attempts: 1,
    created_at: new Date(0).toISOString(),
    claim_token: '00000000-0000-4000-8000-000000000020',
  };
}

function repositoryRow(): OutboxRow {
  return {
    ...row('00000000-0000-4000-8000-000000000003'),
    job_type: 'repo_index',
    aggregate_id: '00000000-0000-4000-8000-000000000010',
    idempotency_key: 'repo_index:00000000-0000-4000-8000-000000000010:1',
    payload: {
      job_id: '00000000-0000-4000-8000-000000000003',
      repo_id: '00000000-0000-4000-8000-000000000010',
      content_version: 1,
      repository: { content_hash: 'worker-content-hash' },
    },
  };
}

const repositoryResponse = {
  schema_version: 2 as const,
  accepted: true as const,
  status: 'applied' as const,
  job_id: '00000000-0000-4000-8000-000000000003',
  repo_id: '00000000-0000-4000-8000-000000000010',
  content_version: 1,
  embedding_version: 'embedding-v2',
  card_summary: {
    summary: 'This is a concise repository discovery summary. It gives developers useful context.',
    highlights: [],
    prompt_version: 'repo-card-summary-v1',
    model_version: 'test-model',
    format_version: 'repo-card-summary-json-v1',
    source: 'generated' as const,
  },
};

test('outbox claims each row immediately before sequential delivery', async () => {
  const first = row('00000000-0000-4000-8000-000000000001');
  const second = row('00000000-0000-4000-8000-000000000002');
  const pending = [[first], [second], []] as OutboxRow[][];
  const claimLimits: number[] = [];
  const delivered: string[] = [];
  const outbox = {
    prepareOnboardingDelivery: async () => true,
    claim: async (limit: number) => {
      claimLimits.push(limit);
      return pending.shift() ?? [];
    },
    markDelivered: async (item: OutboxRow) => { delivered.push(item.outbox_id); },
    markFailed: async () => { throw new Error('unexpected failure'); },
  } as unknown as OutboxService;
  const transport = {
    deliverOnboarding: async () => ({ accepted: true, retryable: false, status_code: 200 }),
  } as unknown as OutboxTransportPort;

  const processed = await new OutboxWorker(outbox, transport).runOnce(50);

  assert.equal(processed, 2);
  assert.deepEqual(claimLimits, [1, 1, 1]);
  assert.deepEqual(delivered, [first.outbox_id, second.outbox_id]);
});

test('repository-index delivery persists its response atomically instead of marking first', async () => {
  const item = repositoryRow();
  const calls: string[] = [];
  const outbox = {
    claim: async () => [item],
    completeRepositoryIndex: async (_row: OutboxRow, response: unknown) => {
      calls.push('complete');
      assert.deepEqual(response, repositoryResponse);
      return true;
    },
    markDelivered: async () => { calls.push('mark-delivered'); },
    markFailed: async () => { calls.push('mark-failed'); },
  } as unknown as OutboxService;
  const transport = {
    deliverRepositoryIndex: async () => ({
      accepted: true, retryable: false, status_code: 200, response_body: repositoryResponse,
    }),
  } as unknown as OutboxTransportPort;

  assert.equal(await new OutboxWorker(outbox, transport).runOnce(1), 1);
  assert.deepEqual(calls, ['complete']);
});

test('repository-index response is not finalized when persistence crashes or omits the artifact', async () => {
  const item = repositoryRow();
  const crashOutbox = {
    claim: async () => [item],
    completeRepositoryIndex: async () => { throw new Error('database crash'); },
    markDelivered: async () => { throw new Error('must not mark separately'); },
    markFailed: async () => { throw new Error('must remain claimed for lease retry'); },
  } as unknown as OutboxService;
  const acceptedTransport = {
    deliverRepositoryIndex: async () => ({
      accepted: true, retryable: false, status_code: 200, response_body: repositoryResponse,
    }),
  } as unknown as OutboxTransportPort;
  await assert.rejects(
    new OutboxWorker(crashOutbox, acceptedTransport).runOnce(1),
    /database crash/,
  );

  let failed = '';
  const missingOutbox = {
    claim: async () => [item],
    completeRepositoryIndex: async () => { throw new Error('must not complete'); },
    markDelivered: async () => { throw new Error('must not mark separately'); },
    markFailed: async (_row: OutboxRow, detail: string) => { failed = detail; },
  } as unknown as OutboxService;
  const missingTransport = {
    deliverRepositoryIndex: async () => ({ accepted: true, retryable: false, status_code: 200 }),
  } as unknown as OutboxTransportPort;
  await new OutboxWorker(missingOutbox, missingTransport).runOnce(1);
  assert.match(failed, /without a versioned card-summary response/);
});

test('repository-index contract and deterministic completion conflicts become terminal failures', async () => {
  const item = repositoryRow();
  const failures: Array<{ detail: string; retryable: boolean }> = [];
  const conflictOutbox = {
    claim: async () => [item],
    completeRepositoryIndex: async () => {
      throw new RepositoryIndexCompletionConflictError('immutable artifact conflict');
    },
    markDelivered: async () => { throw new Error('must not mark separately'); },
    markFailed: async (_row: OutboxRow, detail: string, retryable: boolean) => {
      failures.push({ detail, retryable });
    },
  } as unknown as OutboxService;
  const transport = {
    deliverRepositoryIndex: async () => ({
      accepted: true, retryable: false, status_code: 200, response_body: repositoryResponse,
    }),
  } as unknown as OutboxTransportPort;

  assert.equal(await new OutboxWorker(conflictOutbox, transport).runOnce(1), 1);
  assert.deepEqual(failures, [{ detail: 'immutable artifact conflict', retryable: false }]);

  failures.length = 0;
  item.payload = { ...item.payload, repository: { content_hash: '' } };
  assert.equal(await new OutboxWorker(conflictOutbox, transport).runOnce(1), 1);
  assert.equal(failures[0].retryable, false);
  assert.match(failures[0].detail, /content hash/);
});


test('refresh transport excludes internal content-index dependency metadata', async () => {
  const item: OutboxRow = { ...row('00000000-0000-4000-8000-000000000099'), job_type: 'repo_refresh',
    payload: { job_id: '00000000-0000-4000-8000-000000000099',
      repo_id: '00000000-0000-4000-8000-000000000010', feature_version: 7,
      features: { star_count: 3 }, required_content_version: 2 } };
  const outbox = { claim: async () => [item], markDelivered: async () => {},
    markFailed: async () => { throw new Error('unexpected failure'); } } as unknown as OutboxService;
  const transport = { deliverRepositoryRefresh: async (payload: unknown) => {
    assert.deepEqual(payload, { job_id: '00000000-0000-4000-8000-000000000099',
      repo_id: '00000000-0000-4000-8000-000000000010', feature_version: 7,
      features: { star_count: 3 } });
    return { accepted: true, retryable: false, status_code: 200 };
  } } as unknown as OutboxTransportPort;
  assert.equal(await new OutboxWorker(outbox, transport).runOnce(1), 1);
});

test('durable enqueue context links distinct delivery attempts without leaking internal metadata', async () => {
  const { startSpan, withOutboxTrace, snapshotSpans } = await import('../../observability/tracing.js');
  // Sampled trusted context makes parent/child evidence deterministic.
  const parent = startSpan('http', 'http_completion', true,
    '00-01111111111111111111111111111111-1111111111111111-01');
  const job = row('00000000-0000-4000-8000-000000000030');
  const original = job.payload;
  job.payload = JSON.parse(JSON.stringify(parent.run(() => withOutboxTrace(original))));
  assert.equal(original._traceparent, undefined);
  const calls: string[] = [];
  const worker = new OutboxWorker({
    prepareOnboardingDelivery: async () => true,
    markDelivered: async () => undefined,
  } as unknown as OutboxService, {
    deliverOnboarding: async (payload: object) => {
      assert.deepEqual(payload, original);
      const child = startSpan('onboard', 'ml_transport');
      calls.push(child.traceparent);
      child.finish('success');
      return { accepted: true, retryable: false, status_code: 200 };
    },
  } as unknown as OutboxTransportPort);
  await worker.deliverClaimed(job);
  await worker.deliverClaimed(job);
  assert.equal(calls[0].split('-')[1], parent.traceparent.split('-')[1]);
  assert.notEqual(calls[0], calls[1]);
  const attempts = snapshotSpans().filter(span => span.trace_id === parent.traceparent.split('-')[1]
    && span.stage === 'outbox_delivery');
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every(span => span.parent_span_id === parent.traceparent.split('-')[2]));
  assert.equal(job.idempotency_key, 'onboard:00000000-0000-4000-8000-000000000030');
});

test('legacy and malformed outbox context produce fresh roots even inside unrelated ALS', async () => {
  const { startSpan, withOutboxTrace } = await import('../../observability/tracing.js');
  const ambient = startSpan('http', 'http_completion', true);
  for (const invalid of [undefined, '', '00-' + '0'.repeat(32) + '-1111111111111111-01', { unexpected: true }]) {
    const job = row('00000000-0000-4000-8000-000000000031');
    job.payload._traceparent = invalid;
    let deliveredTrace = '';
    const worker = new OutboxWorker({ prepareOnboardingDelivery: async () => true,
      markDelivered: async () => undefined } as unknown as OutboxService, {
      deliverOnboarding: async () => {
        deliveredTrace = withOutboxTrace({})._traceparent!;
        return { accepted: true, retryable: false, status_code: 200 };
      },
    } as unknown as OutboxTransportPort);
    await ambient.run(() => worker.deliverClaimed(job));
    assert.notEqual(deliveredTrace.split('-')[1], ambient.traceparent.split('-')[1]);
  }
});
