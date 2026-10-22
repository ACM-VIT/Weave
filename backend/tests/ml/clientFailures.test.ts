import assert from 'node:assert/strict';
import { createServer, type RequestListener, type Server } from 'node:http';
import test from 'node:test';

import { MlV2Client } from '../../services/mlService.js';
import { snapshotMetrics } from '../../observability/metrics.js';

async function withServer(handler: RequestListener, run: (url: string) => Promise<void>): Promise<void> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

const feedback = { schema_version: 2 as const, events: [{
  event_id: '00000000-0000-4000-8000-000000000001', user_id: '00000000-0000-4000-8000-000000000002',
  repo_id: '00000000-0000-4000-8000-000000000003', feedback_version: '1', event_type: 'like' as const,
  dwell_ms: null, occurred_at: new Date(0).toISOString(),
}] };

test('ML transport classifies 429 and 5xx as retryable and 4xx as terminal', async () => {
  for (const [status, retryable] of [[429, true], [503, true], [400, false]] as const) {
    await withServer((_req, response) => { response.writeHead(status, {
      'content-type': 'application/json', ...(status === 429 ? { 'retry-after': '2' } : {}),
    }); response.end('{}'); }, async (url) => {
      const result = await new MlV2Client({ baseUrl: url, internalSecret: 'test', timeoutMs: 500, maxResponseBytes: 10_000 })
        .deliverFeedback(feedback);
      assert.equal(result.accepted, false);
      assert.equal(result.retryable, retryable);
      if (status === 429) assert.equal(result.retry_after_ms, 2_000);
    });
  }
});

test('ML delivery accepts plain-text 2xx and preserves terminal plain-text 4xx status', async () => {
  for (const [status, accepted, retryable] of [[202, true, false], [400, false, false]] as const) {
    await withServer((_req, response) => {
      response.writeHead(status, { 'content-type': 'text/plain' });
      response.end(status === 202 ? 'accepted' : 'invalid onboarding profile');
    }, async (url) => {
      const result = await new MlV2Client({
        baseUrl: url, internalSecret: 'test', timeoutMs: 500, maxResponseBytes: 10_000,
      }).deliverFeedback(feedback);
      assert.equal(result.accepted, accepted);
      assert.equal(result.retryable, retryable);
      assert.equal(result.status_code, status);
      assert.equal(result.detail, status === 202 ? 'accepted' : 'invalid onboarding profile');
    });
  }
});

test('repository-index transport adds the v2 envelope without changing strict source keys', async () => {
  let received: Record<string, unknown> | null = null;
  await withServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      response.writeHead(202, { 'content-type': 'text/plain' });
      response.end('accepted');
    });
  }, async (url) => {
    const result = await new MlV2Client({
      baseUrl: url, internalSecret: 'test', timeoutMs: 500, maxResponseBytes: 10_000,
    }).deliverRepositoryIndex({
      job_id: '00000000-0000-4000-8000-000000000010',
      repo_id: '00000000-0000-4000-8000-000000000011',
      content_version: 1,
      repository: {
        github_id: '123', full_name: 'owner/repository', url: 'https://github.com/owner/repository',
        description: '', primary_language: 'Unknown', languages: [], topics: [], readme: null,
        star_count: 0, fork_count: 0, open_issues_count: 0, pushed_at: null, content_hash: 'hash',
      },
    });
    assert.equal(result.accepted, true);
  });
  const body = received as unknown as Record<string, unknown>;
  assert.equal(body.schema_version, 2);
  assert.deepEqual(Object.keys(body).sort(), [
    'content_version', 'job_id', 'repo_id', 'repository', 'schema_version',
  ]);
});

test('ML recommendation client rejects invalid contracts', async () => {
  await withServer((_req, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ schema_version: 1, items: [] }));
  }, async (url) => {
    const client = new MlV2Client({ baseUrl: url, internalSecret: 'test', timeoutMs: 500, maxResponseBytes: 10_000 });
    await assert.rejects(client.generate({
      schema_version: 2, generation_id: '00000000-0000-4000-8000-000000000001',
      user_id: '00000000-0000-4000-8000-000000000002', feed_version: 1, limit: 10,
      exclude_repo_ids: [], context: { cold_start: false },
    }), /violated the v2 envelope/);
  });
});

test('ML recommendation client still requires JSON', async () => {
  await withServer((_req, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('not-json');
  }, async (url) => {
    const client = new MlV2Client({ baseUrl: url, internalSecret: 'test', timeoutMs: 500, maxResponseBytes: 10_000 });
    await assert.rejects(client.generate({
      schema_version: 2, generation_id: '00000000-0000-4000-8000-000000000001',
      user_id: '00000000-0000-4000-8000-000000000002', feed_version: 1, limit: 10,
      exclude_repo_ids: [], context: { cold_start: false },
    }), /invalid JSON/);
  });
});

test('ML recommendation client accepts validated empty success', async () => {
  const generationId = '00000000-0000-4000-8000-000000000001';
  const userId = '00000000-0000-4000-8000-000000000002';
  await withServer((_req, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      schema_version: 2,
      generation_id: generationId,
      user_id: userId,
      feed_version: 1,
      model_version: 'test-model',
      embedding_version: 'test-embedding',
      items: [],
    }));
  }, async (url) => {
    const client = new MlV2Client({ baseUrl: url, internalSecret: 'test', timeoutMs: 500, maxResponseBytes: 10_000 });
    const result = await client.generate({
      schema_version: 2, generation_id: generationId, user_id: userId, feed_version: 1,
      limit: 10, exclude_repo_ids: [], context: { cold_start: false },
    });
    assert.deepEqual(result.items, []);
  });
});

test('ML recommendation client rejects non-canonical repository IDs', async () => {
  const generationId = '00000000-0000-4000-8000-000000000001';
  const userId = '00000000-0000-4000-8000-000000000002';
  await withServer((_req, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      schema_version: 2,
      generation_id: generationId,
      user_id: userId,
      feed_version: 1,
      model_version: 'test-model',
      embedding_version: 'test-embedding',
      items: [{ repo_id: 'owner/repository', score: 0.9, source: 'semantic' }],
    }));
  }, async (url) => {
    const client = new MlV2Client({ baseUrl: url, internalSecret: 'test', timeoutMs: 500, maxResponseBytes: 10_000 });
    await assert.rejects(client.generate({
      schema_version: 2,
      generation_id: generationId,
      user_id: userId,
      feed_version: 1,
      limit: 10,
      exclude_repo_ids: [],
      context: { cold_start: false },
    }), /invalid or duplicate item/);
  });
});

test('ML transport turns timeout/network failures into retryable delivery results', async () => {
  await withServer((_req, response) => setTimeout(() => response.end('{}'), 100), async (url) => {
    const result = await new MlV2Client({ baseUrl: url, internalSecret: 'test', timeoutMs: 10, maxResponseBytes: 10_000 })
      .deliverFeedback(feedback);
    assert.equal(result.accepted, false);
    assert.equal(result.retryable, true);
    assert.equal(result.status_code, 0);
  });
});

test('durable delivery uses its longer timeout without weakening read timeouts', async () => {
  await withServer((_req, response) => setTimeout(() => {
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end('{"accepted":true}');
  }, 30), async (url) => {
    const result = await new MlV2Client({
      baseUrl: url,
      internalSecret: 'test',
      timeoutMs: 10,
      deliveryTimeoutMs: 100,
      maxResponseBytes: 10_000,
    }).deliverFeedback(feedback);
    assert.equal(result.accepted, true);
    assert.equal(result.status_code, 202);
  });
});

const recommendationInput = {
  schema_version: 2 as const,
  generation_id: '00000000-0000-4000-8000-000000000001',
  user_id: '00000000-0000-4000-8000-000000000002',
  feed_version: 1, limit: 10, exclude_repo_ids: [], context: { cold_start: false },
};
const validRecommendation = {
  ...recommendationInput, model_version: 'test-model', embedding_version: 'test-embedding', items: [],
};
const recommendationConfig = { baseUrl: 'http://ml.test', internalSecret: 'test', timeoutMs: 100, maxResponseBytes: 10_000 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('recommendation recovery admits one probe and closes only after validated success', async (context) => {
  let now = 0;
  let calls = 0;
  const probe = deferred<Response>();
  const countersBefore = snapshotMetrics().counters as Record<string, number>;
  context.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) return new Response('unavailable', { status: 503 });
    if (calls === 2) return probe.promise;
    return Response.json(validRecommendation);
  });
  const client = new MlV2Client(recommendationConfig, { now: () => now, failureThreshold: 1, openMs: 100 });
  await assert.rejects(client.generate(recommendationInput), /status 503/);
  now = 99;
  await assert.rejects(client.generate(recommendationInput), /circuit is open/);
  assert.equal(calls, 1);
  now = 100;
  const recovering = client.generate(recommendationInput);
  const rejected = await Promise.allSettled(Array.from({ length: 32 }, () => client.generate(recommendationInput)));
  assert.ok(rejected.every((result) => result.status === 'rejected'));
  assert.equal(calls, 2, 'cooldown expiry must not fan out concurrent ML requests');
  probe.resolve(Response.json(validRecommendation));
  assert.deepEqual((await recovering).items, [], 'validated empty success still closes recovery');
  await client.generate(recommendationInput);
  assert.equal(calls, 3);
  const counters = snapshotMetrics().counters as Record<string, number>;
  for (const key of [
    'ml_recommendation_circuit_transition_total:[["from","closed"],["reason","dependency"],["to","open"]]',
    'ml_recommendation_circuit_transition_total:[["from","open"],["reason","cooldown"],["to","half-open"]]',
    'ml_recommendation_circuit_transition_total:[["from","half-open"],["reason","success"],["to","closed"]]',
    'ml_recommendation_probe_total:[["outcome","success"]]',
  ]) assert.equal(counters[key] - (countersBefore[key] ?? 0), 1);
});

test('stale closed-state success cannot close a newer open circuit', async (context) => {
  let calls = 0;
  const oldSuccess = deferred<Response>();
  context.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return calls === 1 ? oldSuccess.promise : new Response('unavailable', { status: 503 });
  });
  const client = new MlV2Client(recommendationConfig, { now: () => 0, failureThreshold: 1, openMs: 100 });
  const oldCall = client.generate(recommendationInput);
  await assert.rejects(client.generate(recommendationInput), /status 503/);
  oldSuccess.resolve(Response.json(validRecommendation));
  await oldCall;
  await assert.rejects(client.generate(recommendationInput), /circuit is open/);
  assert.equal(calls, 2);
});

test('contract failures remain visible without consuming the dependency failure threshold', async (context) => {
  let body: unknown = { schema_version: 1 };
  let status = 200;
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(body, { status }); });
  const client = new MlV2Client(recommendationConfig, { now: () => 0, failureThreshold: 1, openMs: 100 });
  for (let index = 0; index < 6; index++) {
    await assert.rejects(client.generate(recommendationInput), { kind: 'contract' });
  }
  body = { ...validRecommendation, items: [null] };
  await assert.rejects(client.generate(recommendationInput), { kind: 'contract' });
  status = 400;
  await assert.rejects(client.generate(recommendationInput), { kind: 'contract', statusCode: 400 });
  status = 429;
  await assert.rejects(client.generate(recommendationInput), { kind: 'dependency', statusCode: 429 });
  await assert.rejects(client.generate(recommendationInput), /circuit is open/);
  assert.equal(calls, 9);
});

test('failed or malformed half-open probes reopen and release their slot', async (context) => {
  let now = 0;
  let calls = 0;
  const responses = [
    new Response('{}', { status: 503 }),
    new Response('not-json'),
    new Response(''),
    new Response('{}', { status: 503 }),
    Response.json(validRecommendation),
  ];
  context.mock.method(globalThis, 'fetch', async () => responses[calls++]!);
  const client = new MlV2Client(recommendationConfig, { now: () => now, failureThreshold: 1, openMs: 100 });
  await assert.rejects(client.generate(recommendationInput), /status 503/);
  now = 100;
  await assert.rejects(client.generate(recommendationInput), { kind: 'contract' });
  now = 199;
  await assert.rejects(client.generate(recommendationInput), /circuit is open/);
  now = 200;
  await assert.rejects(client.generate(recommendationInput), /violated the v2 envelope/);
  now = 300;
  await assert.rejects(client.generate(recommendationInput), { kind: 'dependency' });
  now = 400;
  assert.deepEqual((await client.generate(recommendationInput)).items, []);
  assert.equal(calls, 5);
});

test('a timed-out recovery probe releases its slot before the next cooldown', async (context) => {
  let now = 0;
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    calls++;
    if (calls === 1) return new Response('{}', { status: 503 });
    if (calls === 2) return new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
    });
    return Response.json(validRecommendation);
  });
  const client = new MlV2Client({ ...recommendationConfig, timeoutMs: 5 }, { now: () => now, failureThreshold: 1, openMs: 100 });
  await assert.rejects(client.generate(recommendationInput));
  now = 100;
  await assert.rejects(client.generate(recommendationInput), /abort/i);
  await assert.rejects(client.generate(recommendationInput), /circuit is open/);
  now = 200;
  await client.generate(recommendationInput);
  assert.equal(calls, 3);
});
