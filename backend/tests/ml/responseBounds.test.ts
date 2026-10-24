import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { MlRecommendationError, MlV2Client } from '../../services/mlService.js';

const id = '00000000-0000-4000-8000-000000000001';
const input = { schema_version: 2 as const, generation_id: id, user_id: id, feed_version: 1,
  limit: 10, exclude_repo_ids: [], context: { cold_start: false } };
const recommendation = { schema_version: 2, generation_id: id, user_id: id, feed_version: 1,
  model_version: 'ranker-v1', embedding_version: 'embedding-v2', items: [],
  context_status: { cold_start_applied: false, locale: 'not_provided' }, embedding_versions: [],
  served_ranker: 'heavy', heavy_ranker_selected: true, ranker_applied: true,
  fallback_code: null, fallback_reason: null, retrieval_mode: 'personalized' };
const feedback = { schema_version: 2 as const, events: [] };
const job = { job_id: id, repo_id: id, content_version: 1,
  repository: { full_name: 'fixture/repository', content_hash: 'hash' } };

async function withServer(handler: RequestListener, run: (url: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function within<T>(value: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([value, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

const client = (baseUrl: string, maxResponseBytes: number, timeoutMs = 500) =>
  new MlV2Client({ baseUrl, internalSecret: 'fixture', maxResponseBytes, timeoutMs,
    repositoryIndexTimeoutMs: timeoutMs }, { failureThreshold: 1 });

// Never end the response: a read-then-check implementation reaches its deadline,
// whereas the byte bound must cancel as soon as the first excess byte arrives.
test('unending oversized success cancels HTTP body and preserves contract/delivery classification', async () => {
  for (const operation of ['recommendation', 'repository', 'feedback', 'health'] as const) {
    let closed!: () => void;
    const bodyClosed = new Promise<void>(resolve => { closed = resolve; });
    await withServer((_request, response) => {
      response.once('close', closed);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('x'.repeat(129));
    }, async url => {
      const ml = client(url, 128);
      if (operation === 'recommendation') {
        await assert.rejects(ml.generate(input), error => error instanceof MlRecommendationError
          && error.kind === 'contract' && /size limit/.test(error.message));
      } else if (operation === 'health') {
        await assert.rejects(ml.health(), /size limit/);
      } else {
        const result = operation === 'repository' ? await ml.deliverRepositoryIndex(job) : await ml.deliverFeedback(feedback);
        assert.equal(result.accepted, false);
        assert.equal(result.retryable, operation === 'feedback');
        assert.equal(result.failure_kind, undefined, 'overflow is not a transport timeout');
        assert.match(result.detail ?? '', /size limit/);
      }
      await within(bodyClosed, 500, 'Oversized HTTP body was not cancelled');
    });
  }
});

test('unending oversized HTTP failures keep status/retry-after and bounded diagnostics', async () => {
  for (const [status, retryable] of [[400, false], [429, true], [503, true]] as const) {
    await withServer((_request, response) => {
      response.writeHead(status, { 'retry-after': '2' }); response.write('x'.repeat(129));
    }, async url => {
      const result = await client(url, 128).deliverRepositoryIndex(job);
      assert.equal(result.status_code, status); assert.equal(result.retryable, retryable);
      assert.equal(result.failure_kind, undefined); assert.equal(result.retry_after_ms, 2000);
      assert.equal(result.detail, 'x'.repeat(128));
    });
  }
});

test('exact byte cap accepts split UTF8, including BOM; compressed length cannot bypass decoded body bound', async () => {
  const expected = { detail: 'Tarun café 🙂' };
  const bytes = Buffer.from('\uFEFF' + JSON.stringify(expected));
  await withServer(async (_request, response) => {
    response.writeHead(200);
    // Split inside both the 2-byte and 4-byte Unicode sequences.
    for (let index = 0; index < bytes.length; index++) {
      response.write(bytes.subarray(index, index + 1));
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    response.end();
  }, async url => {
    const result = await client(url, bytes.length).deliverFeedback(feedback);
    assert.equal(result.accepted, true); assert.deepEqual(result.response_body, expected);
    const excess = await client(url, bytes.length - 1).deliverFeedback(feedback);
    assert.equal(excess.accepted, false); assert.equal(excess.failure_kind, undefined);
  });
  const compressed = gzipSync(Buffer.from(JSON.stringify({ padding: 'x'.repeat(10_000) })));
  assert.ok(compressed.length < 128);
  await withServer((_request, response) => {
    response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': compressed.length }); response.end(compressed);
  }, async url => { await assert.rejects(client(url, 128).generate(input), { kind: 'contract' }); });
});

test('misleading Content-Length metadata neither bypasses the cap nor rejects an exact-cap body', async context => {
  const bytes = Buffer.from(JSON.stringify(recommendation));
  let oversized = false;
  const actualFetch = globalThis.fetch;
  // The HTTP parser itself enforces wire framing. Rewrite only the exposed
  // header, keeping the actual HTTP stream, to exercise untrusted metadata.
  context.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    const response = await actualFetch(url, options);
    return new Response(response.body, { status: response.status,
      headers: { 'content-length': oversized ? '1' : String(bytes.length * 100) } });
  });
  await withServer((_request, response) => response.end(oversized ? Buffer.alloc(bytes.length + 1, 'x') : bytes), async url => {
    const ml = client(url, bytes.length);
    assert.deepEqual(await ml.generate(input), recommendation);
    oversized = true;
    await assert.rejects(ml.generate(input), { kind: 'contract' });
  });
});

test('overflow does not open recommendation circuit; exact-cap required JSON remains accepted', async () => {
  let calls = 0;
  const bytes = Buffer.from(JSON.stringify(recommendation));
  await withServer((_request, response) => {
    if (++calls === 1) { response.writeHead(200); response.write(Buffer.alloc(bytes.length + 1, 'x')); }
    else response.end(bytes);
  }, async url => {
    const ml = client(url, bytes.length);
    await assert.rejects(ml.generate(input), { kind: 'contract' });
    assert.deepEqual(await ml.generate(input), recommendation); assert.equal(calls, 2);
  });
});

test('deadline during body read closes socket and completed body does not leave an abort timer', async context => {
  let closed!: () => void;
  const bodyClosed = new Promise<void>(resolve => { closed = resolve; });
  let arrived!: () => void;
  const bodyStarted = new Promise<void>(resolve => { arrived = resolve; });
  await withServer((_request, response) => {
    response.once('close', closed); response.writeHead(200); response.write('{'); arrived();
  }, async url => {
    const pending = client(url, 128, 1000).deliverFeedback(feedback);
    // Establish an actual partial response before classifying body-read timeout.
    await within(bodyStarted, 500, 'HTTP partial response did not arrive before the deadline');
    const result = await within(pending, 1500, 'ML deadline did not settle');
    assert.equal(result.failure_kind, 'timeout'); assert.equal(result.retryable, true);
    await within(bodyClosed, 500, 'Timed-out HTTP body was not closed');
  });
  const signals: AbortSignal[] = [];
  const actualFetch = globalThis.fetch;
  context.mock.method(globalThis, 'fetch', (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    if (options?.signal) signals.push(options.signal);
    return actualFetch(url, options);
  });
  await withServer((_request, response) => response.end('{}'), async url => {
    assert.equal((await client(url, 128, 50).deliverFeedback(feedback)).accepted, true);
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(signals.at(-1)?.aborted, false, 'completed request timer was cleared');
  });
});

test('deadline before request arrival settles without waiting for a nonexistent response body', async context => {
  let arrivals = 0;
  context.mock.method(globalThis, 'fetch', (_url: Parameters<typeof fetch>[0], options?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = options!.signal!;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
  await withServer((_request, response) => { arrivals++; response.end('{}'); }, async url => {
    const result = await within(client(url, 128, 50).deliverFeedback(feedback), 500, 'Pre-arrival deadline did not settle');
    assert.equal(result.failure_kind, 'timeout'); assert.equal(result.retryable, true);
    assert.equal(arrivals, 0, 'no response body exists to wait on');
  });
});
