import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { MlRecommendationError, MlV2Client } from '../../services/mlService.js';

const fixture = JSON.parse(await readFile(new URL('../fixtures/scoring-capture-v1.json', import.meta.url), 'utf8'));
const input = { schema_version: 2 as const, generation_id: fixture.context.generation_id as string,
  user_id: fixture.context.user_id as string, feed_version: fixture.context.feed_version as string,
  limit: 10, exclude_repo_ids: [], context: { cold_start: false },
  scoring_capture: { schema_version: 1 as const, encoding: 'float32-le-v1' as const } };
const body = { schema_version: 2, generation_id: input.generation_id, user_id: input.user_id,
  feed_version: input.feed_version, model_version: fixture.context.model_version, embedding_version: 'fixture-repository-v1',
  embedding_versions: ['fixture-repository-v1'], served_ranker: 'heavy', heavy_ranker_selected: true,
  ranker_applied: true, fallback_code: null, fallback_reason: null, retrieval_mode: 'personalized',
  context_status: { cold_start_applied: false, locale: 'not_provided' },
  scoring_capture: { schema_version: 1, status: 'captured' }, scoring_context: fixture.context,
  scoring_metadata_complete: false, items: [{ repo_id: fixture.packet.snapshot.repo_id, score: 0.7,
    source: 'semantic', raw_heavy_score: 0.5, scored_input: fixture.packet }] };
const capability = 'fixture-capture-capability-32-chars';

async function exchange(bytes: Uint8Array, check: (client: MlV2Client) => Promise<void>, maximum = 1_000_000) {
  const server = createServer((request, response) => {
    assert.equal(request.headers['x-scoring-capture-capability'], capability);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
    response.end(bytes.subarray(Math.floor(bytes.length / 2)));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try { await check(new MlV2Client({ baseUrl: `http://127.0.0.1:${address.port}`, internalSecret: 'fixture-internal',
    maxResponseBytes: maximum, timeoutMs: 1500 })); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
const work = () => ({ deadline: performance.now() + 1500, scoringCaptureCapability: capability });
const rejects = async (bytes: Uint8Array) => exchange(bytes, async client => {
  await assert.rejects(client.generate(input, work()), error => error instanceof MlRecommendationError
    && error.kind === 'contract' && !/input_base64|PRIVATE|fixture-capture/.test(JSON.stringify(error)));
});

test('captured transport preserves exact decimal versions and sealed packet across real HTTP', async () => {
  const bytes = Buffer.from(JSON.stringify(body));
  await exchange(bytes, async client => assert.deepEqual(await client.generate(input, work()), body), bytes.length);
});

test('captured transport rejects escaped duplicate keys and invalid UTF8 before lossy decoding', async () => {
  const text = JSON.stringify(body);
  await rejects(Buffer.from(text.replace('"schema_version":2', '"schema_version":1,"schema\\u005fversion":2')));
  await rejects(Buffer.from(text.replace('"feature_version":"0"', '"feature_version":"1","feature_version":"0"')));
  const offset = text.indexOf('semantic');
  await rejects(Buffer.concat([Buffer.from(text.slice(0, offset)), Buffer.from([0xff]), Buffer.from(text.slice(offset + 1))]));
});

test('captured transport rejects downgrade, unknown fields, altered binding and incompatible stages', async () => {
  for (const mutate of [
    (value: any) => { delete value.scoring_capture; },
    (value: any) => { value.extra = 'PRIVATE'; },
    (value: any) => { value.items[0].scored_input.binding_sha256 = '0'.repeat(64); },
    (value: any) => { value.raw_heavy_score = 0.9; },
    (value: any) => { value.served_ranker = 'hybrid'; },
    (value: any) => { value.scoring_context.model_version = 'wrong-model'; },
  ]) { const value = structuredClone(body); mutate(value); await rejects(Buffer.from(JSON.stringify(value))); }
});

test('captured empty is explicit and ordinary output cannot downgrade a requested capture', async () => {
  const { scoring_context: _context, scoring_metadata_complete: _complete, ...empty } = body;
  const response = { ...empty, items: [], scoring_capture: { schema_version: 1, status: 'not_scored_empty' } };
  await exchange(Buffer.from(JSON.stringify(response)), async client => {
    assert.deepEqual(await client.generate(input, work()), response);
  });
  await rejects(Buffer.from(JSON.stringify({ ...response, scoring_context: fixture.context })));
});

test('captured failures omit private provider diagnostic text and retain retry classification', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(503, { 'retry-after': '2' });
    response.end(JSON.stringify({ detail: 'PRIVATE input_base64 fixture-capture-capability-32-chars' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try {
    const client = new MlV2Client({ baseUrl: `http://127.0.0.1:${address.port}`, internalSecret: 'fixture',
      timeoutMs: 1500, maxResponseBytes: 1_000_000 });
    await assert.rejects(client.generate(input, work()), error => {
      assert.ok(error instanceof MlRecommendationError);
      assert.equal(error.kind, 'service_unavailable'); assert.equal(error.retryAfterMs, 2000);
      assert.equal(error.detail, undefined); assert.equal(error.cause, undefined);
      assert.doesNotMatch(String(error) + JSON.stringify(error), /PRIVATE|input_base64|fixture-capture/);
      return true;
    });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('captured streaming enforces 1MB even with a larger configured bound and cancels an unending body', async () => {
  let close!: () => void;
  const closed = new Promise<void>(resolve => { close = resolve; });
  const server = createServer((_request, response) => {
    response.once('close', close);
    response.writeHead(200); response.write(' '.repeat(1_000_001));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = new MlV2Client({ baseUrl: `http://127.0.0.1:${address.port}`, internalSecret: 'fixture',
      timeoutMs: 1500, maxResponseBytes: 2_000_000 });
    await assert.rejects(client.generate(input, work()), error => error instanceof MlRecommendationError && /size limit/.test(error.message));
    await Promise.race([closed, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Captured stream was not cancelled')), 1000);
    })]);
  } finally {
    clearTimeout(timer); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});


test('captured parser keeps escaped strings distinct from object structure and accepts exact 1MB', async () => {
  const value = structuredClone(body); value.items[0].source = 'semantic \" { : } [ \\';
  const text = JSON.stringify(value);
  const bytes = Buffer.from(text + ' '.repeat(1_000_000 - Buffer.byteLength(text)));
  await exchange(bytes, async client => assert.deepEqual(await client.generate(input, work()), value), 1_000_001);
});
