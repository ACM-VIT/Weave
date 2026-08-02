import assert from 'node:assert/strict';
import { createServer, type RequestListener, type Server } from 'node:http';
import test from 'node:test';

import { MlRecommendationError, MlV2Client } from '../../services/mlService.js';

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

test('ML recommendation client rejects an empty successful result', async () => {
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
    await assert.rejects(client.generate({
      schema_version: 2,
      generation_id: generationId,
      user_id: userId,
      feed_version: 1,
      limit: 10,
      exclude_repo_ids: [],
      context: { cold_start: false },
    }), /contained no items/);
  });
});

test('missing user vectors are classified for persona repair and do not open the service circuit', async () => {
  let requests = 0;
  await withServer((_req, response) => {
    requests++;
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ detail: 'User profile vector is unavailable' }));
  }, async (url) => {
    const previousThreshold = process.env.ML_CIRCUIT_FAILURE_THRESHOLD;
    process.env.ML_CIRCUIT_FAILURE_THRESHOLD = '1';
    try {
      const client = new MlV2Client({
        baseUrl: url, internalSecret: 'test', timeoutMs: 500, maxResponseBytes: 10_000,
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(client.generate({
          schema_version: 2,
          generation_id: `00000000-0000-4000-8000-00000000000${attempt + 1}`,
          user_id: '00000000-0000-4000-8000-000000000010',
          feed_version: 1,
          limit: 10,
          exclude_repo_ids: [],
          context: { cold_start: false },
        }), (error: unknown) => error instanceof MlRecommendationError
          && error.kind === 'persona_unavailable');
      }
    } finally {
      if (previousThreshold === undefined) delete process.env.ML_CIRCUIT_FAILURE_THRESHOLD;
      else process.env.ML_CIRCUIT_FAILURE_THRESHOLD = previousThreshold;
    }
  });
  assert.equal(requests, 2);
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
