import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { RedisSearchSnapshotStore } from '../../adapters/redisSearchSnapshotStore.js';
import { hybridRank, parseSearchRequest, parseSemanticResponse, preserveHydrationOrder, SearchService, type SearchPersistence, type SearchRef, type SearchRequest } from '../../services/searchService.js';

const ids = [1,2,3,4].map(n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`);
function request(extra = {}): SearchRequest { return parseSearchRequest({ schema_version: 2, search_id: crypto.randomUUID(), query: 'image understanding', ...extra }); }
function persistence(extra: Partial<SearchPersistence> = {}): SearchPersistence {
  return { lexical: async () => [{ id: ids[0], exact: false }], people: async () => [], lists: async () => [],
    hydrate: async (_viewer,refs) => refs.map(ref => ({ ...ref, data: { repo_id: ref.id } })), ...extra };
}
function body(req: SearchRequest, items = [{ repo_id: ids[1], score: 0.9 }]) { return { schema_version: 2, search_id: req.search_id, embedding_version: 'repo-embedding-v2', items }; }

test('Redis snapshots support pagination across API instances, TTL expiry and viewer binding', async () => {
  let now = 0;
  const entries = new Map<string, { value: string; expires: number }>();
  const redis = {
    async get(key: string) { const entry = entries.get(key); return entry && entry.expires > now ? entry.value : null; },
    async setex(key: string, seconds: number, value: string) { entries.set(key, { value, expires: now + seconds * 1000 }); },
  };
  let semanticCalls = 0;
  const store = new RedisSearchSnapshotStore(redis);
  const makeInstance = () => new SearchService(persistence(), async req => { semanticCalls++; return body(req); },
    () => now, { get: key => store.get(key), set: (key, snapshot) => store.set(key, snapshot) });
  const req = request({ limit: 1 });
  const first = await makeInstance().search('viewer', req);
  const second = await makeInstance().search('viewer', { ...req, cursor: first.next_cursor });
  assert.deepEqual(second.items.map(item => item.id), [ids[1]]);
  assert.equal(semanticCalls, 1);
  await assert.rejects(makeInstance().search('other', { ...req, cursor: first.next_cursor }), /expired/);
  now = 120001;
  await assert.rejects(makeInstance().search('viewer', { ...req, cursor: first.next_cursor }), /expired/);
});

test('search input is versioned, bounded, literal-filtered and cursor-bounded', () => {
  for (const value of [{ query: 'a' },{ query: 'a'.repeat(513) },{ limit: 51 },{ group: 'topics' },{ schema_version: 1 },{ filters: { topic: 'x' } },{ exclude_repo_ids: ['owner/repo'] },{ cursor: 'a'.repeat(101) }]) assert.throws(() => request(value));
  assert.equal(request({ query: '  hi  ' }).query,'hi');
  for (const group of [['all'], [], {}, { toString: 'all' }, { toString: null }, 1, true, null]) {
    assert.throws(() => request({ group }), error => error instanceof Error && 'statusCode' in error && error.statusCode === 400);
  }
});

test('semantic response rejects envelope mismatches and discards malformed IDs, scores and duplicates', () => {
  const req = request();
  assert.throws(() => parseSemanticResponse({ ...body(req), search_id: 'wrong' },req.search_id));
  const items = [{ repo_id: 'owner/repo', score: 1 },{ repo_id: ids[0], score: NaN },{ repo_id: ids[1], score: Infinity },{ repo_id: ids[2], score: 1.5 },{ repo_id: ids[3], score: 0.6 },{ repo_id: ids[3], score: 0.9 }];
  assert.deepEqual(parseSemanticResponse(body(req,items),req.search_id),[{ repo_id: ids[3], score: 0.9 }]);
});

test('hybrid RRF finds semantic-only matches and pins exact names above consensus', () => {
  const ranked = hybridRank([{ id: ids[0], exact: true },{ id: ids[1], exact: false }],[{ repo_id: ids[1], score: 0.9 },{ repo_id: ids[2], score: 0.8 }]);
  assert.deepEqual(ranked,[ids[0],ids[1],ids[2]]);
});

test('hydration restores ranking and drops unknown/deleted repositories', () => {
  const refs: SearchRef[] = ids.map(id => ({ type: 'repository',id }));
  assert.deepEqual(preserveHydrationOrder(refs,[{ ...refs[2],data:{} },{ ...refs[0],data:{} }]).map(v=>v.id),[ids[0],ids[2]]);
});

test('ML timeouts and unavailable/invalid responses return lexical fallback', async () => {
  for (const failure of [async () => { throw new DOMException('timeout','TimeoutError'); }, async () => ({ schema_version: 1 })]) {
    const service = new SearchService(persistence(),failure);
    const result = await service.search('viewer',request());
    assert.equal(result.mode,'lexical'); assert.deepEqual(result.items.map(v=>v.id),[ids[0]]);
  }
});

test('pagination freezes hybrid ranking, revalidates hydrated records and binds cursor to viewer/query', async () => {
  let calls = 0;
  const service = new SearchService(persistence({ lexical: async () => ids.map(id => ({ id,exact:false })),
    hydrate: async (_v,refs) => refs.filter(ref => ref.id !== ids[1]).reverse().map(ref => ({ ...ref,data:{} })) }),async req => { calls++; return body(req); });
  const req = request({ group:'repositories',limit:1 });
  const first = await service.search('viewer',req);
  assert.equal(first.items[0].id,ids[0]);
  const second = await service.search('viewer',{ ...req,cursor:first.next_cursor });
  assert.equal(second.items[0].id,ids[2]); assert.equal(calls,1);
  await assert.rejects(service.search('other',{ ...req,cursor:first.next_cursor }),/expired/);
  await assert.rejects(service.search('viewer',{ ...req,query:'different',cursor:first.next_cursor }),/expired/);
});

test('All interleaves supported groups without inferring query intent and honors exclusions', async () => {
  const service = new SearchService(persistence({ people:async()=>[{type:'person',id:'person'}],lists:async()=>[{type:'list',id:'list'}] }),async req=>body(req));
  const response = await service.search('viewer',request({ exclude_repo_ids:[ids[1]] }));
  assert.deepEqual(response.items.map(v=>v.type),['repository','person','list']);
});

test('expired cursors and cancelled requests do not reuse or return stale snapshots', async () => {
  let clock = 0; const service = new SearchService(persistence(),async req=>body(req),()=>clock);
  const req = request({ limit:1 });const first = await service.search('viewer',req);clock=120001;
  await assert.rejects(service.search('viewer',{...req,cursor:first.next_cursor}),/expired/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(service.search('viewer',request(),abort.signal));
});

test('cancelled shared snapshot waiters stop polling immediately', async () => {
  const redis = {
    async get() { return null; },
    async setex() {},
    async set() { return null; },
    async eval() { return 0; },
  };
  const store = new RedisSearchSnapshotStore(redis);
  const abort = new AbortController();
  const waiting = store.getOrCreate('same-search', 'viewer', async () => {
    throw new Error('the cancelled waiter must never build');
  }, abort.signal);
  setTimeout(() => abort.abort(), 10);
  await assert.rejects(waiting, error => error instanceof Error && error.name === 'AbortError');
});
