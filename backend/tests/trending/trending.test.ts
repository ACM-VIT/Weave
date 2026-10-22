import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import {
  TRENDING_FRESHNESS_MS,
  TrendingUnavailableError,
  TrendingSnapshotService,
  type TrendingSnapshot,
} from '../../services/trendingSnapshotService.js';

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:1/test';
process.env.JWT_SECRET ??= 'trending-local-test-secret';
const [{ createTrendingHandler }, { requireAuth }, { sqlClient }] = await Promise.all([
  import('../../controllers/trendingController.js'),
  import('../../middlewares/authMiddleware.js'),
  import('../../db/index.js'),
]);
test.after(async () => { await sqlClient.end({ timeout: 0 }); });

function fixture() {
  const state = {
    time: 0,
    available: [{ period: 'daily', snapshot_id: 'snapshot-1', captured_at: '2026-10-22T00:00:00Z' }] as TrendingSnapshot[],
    cards: [{ repo_id: 'repo-1', likes_count: 0, position: 7 }] as Record<string, unknown>[],
    probes: 0,
    hydrations: [] as string[],
  };
  const service = new TrendingSnapshotService({
    available: async () => { state.probes++; return structuredClone(state.available); },
    cards: async id => { state.hydrations.push(id); return structuredClone(state.cards); },
  }, () => state.time);
  return { state, service };
}

const data = (response: { body: string }) => JSON.parse(response.body).data;

test('reuses serialized cards and exact-body validators, but rechecks the active snapshot', async () => {
  const { state, service } = fixture();
  const first = await service.get();
  for (let n = 0; n < 10; n++) assert.equal(await service.get('daily'), first);
  assert.equal(state.probes, 11);
  assert.deepEqual(state.hydrations, ['snapshot-1']);
  assert.equal(first.etag, `"${createHash('sha256').update(first.body).digest('hex')}"`);
  assert.deepEqual(data(first).items, state.cards);
});

test('snapshot activation invalidates immediately, even at the same captured timestamp', async () => {
  const { state, service } = fixture();
  const first = await service.get();
  state.available[0].snapshot_id = 'snapshot-2';
  state.cards[0].repo_id = 'repo-2';
  const next = await service.get();
  assert.equal(data(next).items[0].repo_id, 'repo-2');
  assert.notEqual(next.etag, first.etag);
  assert.deepEqual(state.hydrations, ['snapshot-1', 'snapshot-2']);
  state.available[0].activation_version = '2026-10-22 00:01:00.000001+00';
  state.cards[0].repo_id = 'replayed-repo';
  assert.equal(data(await service.get()).items[0].repo_id, 'replayed-repo', 'replayed snapshot IDs use their activation version');
  assert.equal(state.hydrations.length, 3);
  state.available[0].activation_version = '2026-10-22 00:01:00.000002+00';
  state.cards[0].repo_id = 'microsecond-replay';
  assert.equal(data(await service.get()).items[0].repo_id, 'microsecond-replay', 'the version fence must not lose PostgreSQL timestamp precision');
});

test('preserves missing-period fallback, empty results and recovered periods', async () => {
  const { state, service } = fixture();
  state.available = [];
  assert.deepEqual(data(await service.get('weekly')), {
    period: 'daily', available_periods: [], captured_at: null, items: [],
  });
  assert.deepEqual(state.hydrations, []);
  state.available = [{ period: 'weekly', snapshot_id: 'weekly-1', captured_at: '2026-10-21T00:00:00Z' }];
  const weekly = await service.get('monthly');
  assert.equal(data(weekly).period, 'weekly');
  state.available.unshift({ period: 'daily', snapshot_id: 'daily-1', captured_at: '2026-10-22T00:00:00Z' });
  const daily = await service.get('monthly');
  assert.equal(data(daily).period, 'daily');
  assert.deepEqual(data(daily).available_periods, ['daily', 'weekly']);
  const recovered = await service.get('weekly');
  assert.deepEqual(data(recovered).available_periods, ['daily', 'weekly']);
  assert.notEqual(recovered.etag, weekly.etag, 'available periods are part of the response validator');
  state.available = [];
  assert.deepEqual(data(await service.get()).items, [], 'cached cards cannot survive loss of all eligible snapshots');
});

test('bounds counter/status staleness without extending freshness on cache hits', async () => {
  const { state, service } = fixture();
  state.cards.push({ repo_id: 'removed-repo' });
  const first = await service.get();
  state.cards = [{ repo_id: 'repo-1', likes_count: 4, position: 7 }];
  state.time = TRENDING_FRESHNESS_MS - 1;
  assert.equal(await service.get(), first);
  state.time++;
  const fresh = await service.get();
  assert.deepEqual(data(fresh).items, state.cards);
  assert.notEqual(fresh.etag, first.etag);
  assert.equal(state.hydrations.length, 2);
  state.time += TRENDING_FRESHNESS_MS;
  assert.equal((await service.get()).etag, fresh.etag, 'expiry alone must not change an unchanged body validator');
});

test('coalesces concurrent hydration and retries failed loads instead of caching errors', async () => {
  let calls = 0;
  let finish!: (cards: Record<string, unknown>[]) => void;
  const { state } = fixture();
  const service = new TrendingSnapshotService({
    available: async () => state.available,
    cards: async () => {
      calls++;
      if (calls === 1) throw new Error('database unavailable');
      return new Promise(resolve => { finish = resolve; });
    },
  });
  await assert.rejects(service.get(), /database unavailable/);
  const waiting = Array.from({ length: 20 }, () => service.get());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  finish(state.cards);
  const results = await Promise.all(waiting);
  assert.ok(results.every(value => value === results[0]));
});

test('expired pending hydration cannot serve late callers or start unbounded replacement queries', async () => {
  const { state } = fixture();
  const stale = structuredClone(state.cards);
  let finish!: () => void;
  let calls = 0;
  const service = new TrendingSnapshotService({
    available: async () => structuredClone(state.available),
    cards: async () => {
      calls++;
      if (calls === 1) return new Promise(resolve => { finish = () => resolve(stale); });
      return structuredClone(state.cards);
    },
  }, () => state.time);
  const first = service.get();
  await new Promise(resolve => setImmediate(resolve));
  state.time = TRENDING_FRESHNESS_MS;
  state.cards = [{ repo_id: 'current-repo', likes_count: 9 }];
  const later = Array.from({ length: 20 }, () => service.get());
  const results = Promise.allSettled([first, ...later]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1, 'expired work retains its admission slot until it actually finishes');
  finish();
  for (const result of await results) {
    assert.equal(result.status, 'rejected', 'neither the original caller nor late callers may receive expired data');
    if (result.status === 'rejected') assert.equal(result.reason.statusCode, 503);
  }
  assert.deepEqual(data(await service.get()).items, state.cards, 'retry reads a fresh database snapshot');
  assert.equal(calls, 2);
});

test('a newer snapshot waits for the old query to release its admission slot', async () => {
  const { state } = fixture();
  let failOld!: (error: Error) => void;
  let calls = 0;
  const service = new TrendingSnapshotService({
    available: async () => structuredClone(state.available),
    cards: async id => {
      calls++;
      if (id === 'snapshot-1') return new Promise((_resolve, reject) => { failOld = reject; });
      return state.cards;
    },
  });
  const old = assert.rejects(service.get(), /old query failed/);
  await new Promise(resolve => setImmediate(resolve));
  state.available[0].snapshot_id = 'snapshot-2';
  await assert.rejects(service.get(), { statusCode: 503 });
  assert.equal(calls, 1);
  failOld(new Error('old query failed'));
  await old;
  const current = await service.get();
  assert.equal(await service.get(), current);
  assert.equal(calls, 2);
});

test('a slow hydration does not start a new freshness budget on completion', async () => {
  const { state } = fixture();
  let calls = 0;
  const service = new TrendingSnapshotService({
    available: async () => state.available,
    cards: async () => { calls++; state.time += TRENDING_FRESHNESS_MS; return state.cards; },
  }, () => state.time);
  await assert.rejects(service.get(), { statusCode: 503 });
  await assert.rejects(service.get(), { statusCode: 503 });
  assert.equal(calls, 2);
});

test('the wall-clock deadline returns 503 while retaining admission until underlying work settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { state } = fixture();
  let calls = 0;
  let finish!: () => void;
  const service = new TrendingSnapshotService({
    available: async () => state.available,
    cards: async () => {
      calls++;
      if (calls === 1) return new Promise(resolve => { finish = () => resolve(state.cards); });
      return state.cards;
    },
  }, () => state.time);
  const first = assert.rejects(service.get(), { statusCode: 503 });
  await new Promise(resolve => setImmediate(resolve));
  state.time = TRENDING_FRESHNESS_MS;
  t.mock.timers.tick(TRENDING_FRESHNESS_MS);
  await first;
  await assert.rejects(service.get(), { statusCode: 503 });
  assert.equal(calls, 1, 'a caller deadline must not admit another database query');
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(data(await service.get()).items, state.cards);
  assert.equal(calls, 2);
});

type HttpResult = { status: number; headers: http.IncomingHttpHeaders; body: string };
function get(url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { headers, method }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

async function serve(t: test.TestContext, service: TrendingSnapshotService, viewerState?: Parameters<typeof createTrendingHandler>[1]) {
  const app = express();
  app.get('/trending', requireAuth, createTrendingHandler(service, viewerState));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/trending`;
}

const authorization = (user = 'viewer-1') => `Bearer ${jwt.sign({ userId: user }, process.env.JWT_SECRET!)}`;

test('HTTP hydration deadlines and PostgreSQL cancellation return retryable 503 rather than cached content', async t => {
  const { state } = fixture();
  for (const error of [new TrendingUnavailableError(), Object.assign(new Error('statement timeout'), { code: '57014' })]) {
    const service = new TrendingSnapshotService({ available: async () => state.available, cards: async () => { throw error; } });
    const url = await serve(t, service);
    const response = await get(url, { authorization: authorization(), 'if-none-match': '*' });
    assert.equal(response.status, 503);
    assert.equal(response.headers['retry-after'], '1');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(JSON.parse(response.body).success, false);
  }
});

test('HTTP validators support weak/list/wildcard matches, HEAD, auth and forced revalidation', async t => {
  const { state, service } = fixture();
  const url = await serve(t, service);
  const headers = { authorization: authorization() };
  const first = await get(url, headers);
  const etag = String(first.headers.etag);
  assert.equal(first.status, 200);
  assert.equal(first.headers['cache-control'], 'private, no-cache');
  assert.equal(first.headers.vary, 'Authorization');
  assert.equal(first.headers['content-type'], 'application/json; charset=utf-8');
  for (const validator of [etag, `W/${etag}`, `"another", W/${etag}`, '*']) {
    const match = await get(url, { ...headers, 'if-none-match': validator });
    assert.equal(match.status, 304);
    assert.equal(match.body, '');
    assert.equal(match.headers['content-type'], undefined);
    assert.equal(match.headers['content-length'], undefined);
    assert.equal(match.headers.etag, etag);
  }
  assert.equal((await get(url, { ...headers, 'if-none-match': '"different"' })).status, 200);
  assert.equal((await get(url, { ...headers, 'if-none-match': etag, 'cache-control': 'no-cache' })).status, 200);
  assert.equal((await get(url, { ...headers, 'if-none-match': etag }, 'HEAD')).status, 304);
  const head = await get(url, headers, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal((await get(url, { 'if-none-match': etag })).status, 401);
  assert.equal((await get(`${url}?period=yearly`, headers)).status, 400);
  assert.equal((await get(`${url}?period=daily&period=weekly`, headers)).status, 400);
  assert.equal((await get(url, { authorization: authorization('viewer-2') })).body, first.body);
  assert.equal(state.hydrations.length, 1, 'the public projection is shared across authenticated viewers');
});

test('repeated local conditional requests reduce card queries and transferred body bytes', async t => {
  const { state, service } = fixture();
  state.cards = Array.from({ length: 100 }, (_, i) => ({ repo_id: `repo-${i}`, position: i, description: 'Public repository description' }));
  const url = await serve(t, service);
  const headers = { authorization: authorization() };
  const first = await get(url, headers);
  let bodyBytes = Buffer.byteLength(first.body);
  const requests = 25;
  for (let n = 1; n < requests; n++) {
    const response = await get(url, { ...headers, 'if-none-match': String(first.headers.etag) });
    assert.equal(response.status, 304);
    bodyBytes += Buffer.byteLength(response.body);
  }
  assert.equal(state.probes, requests);
  assert.equal(state.hydrations.length, 1);
  assert.equal(bodyBytes, Buffer.byteLength(first.body));
  t.diagnostic(`${requests} local requests: ${state.probes} snapshot probes + 1 bounded card hydration; 96% card-cache hits; ${bodyBytes} body bytes versus ${bodyBytes * requests} uncached bytes (headers excluded).`);
});

test('viewer overlays remain fresh and isolated while public Trending hydration is shared', async t => {
  const {state,service}=fixture();
  let saved=false;
  const url=await serve(t,service,async(viewer,ids)=>ids.map(repo_id=>({repo_id,
    viewer_reaction:viewer==='viewer-1'?'like':null,viewer_saved:viewer==='viewer-1'&&saved,
    selected_list_ids:viewer==='viewer-1'&&saved?['collection:owned']:[],
  })));
  const first=await get(url,{authorization:authorization()});
  const other=await get(url,{authorization:authorization('viewer-2'),'if-none-match':String(first.headers.etag)});
  assert.equal(other.status,200);
  assert.equal(JSON.parse(other.body).data.items[0].viewer_reaction,null);
  assert.notEqual(other.headers.etag,first.headers.etag);
  saved=true;
  const updated=await get(url,{authorization:authorization(),'if-none-match':String(first.headers.etag)});
  assert.equal(updated.status,200);
  assert.equal(JSON.parse(updated.body).data.items[0].viewer_saved,true);
  assert.deepEqual(JSON.parse(updated.body).data.items[0].selected_list_ids,['collection:owned']);
  assert.equal(state.hydrations.length,1);
  assert.equal('viewer_saved' in JSON.parse((await service.get()).body).data.items[0],false);
});
