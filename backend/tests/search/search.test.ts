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

const fixtureIds = (count: number) => Array.from({ length: count }, (_, index) =>
  `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);

test('bounded overfetch fills a page at 90% rejection without serial missing-slot hydration', async () => {
  const candidates = fixtureIds(100);
  const accepted = candidates.filter((_, index) => index % 10 === 9);
  const windows: SearchRef[][] = [];
  const service = new SearchService(persistence({
    lexical: async () => candidates.map(id => ({ id, exact: false })),
    hydrate: async (_viewer, refs) => {
      windows.push(refs);
      return refs.filter(ref => accepted.includes(ref.id)).reverse().map(ref => ({ ...ref, data: {} }));
    },
  }), async req => body(req, []));
  const result = await service.search('viewer', request({ group: 'repositories', limit: 10 }));
  assert.deepEqual(result.items.map(item => item.id), accepted);
  assert.equal(result.next_cursor, null);
  assert.ok(windows.length <= 5, `expected at most 5 hydration rounds, got ${windows.length}`);
  assert.equal(windows.flat().length, 100);
  assert.ok(windows.every(refs => refs.length <= 100));
});

test('overfetch leaves every surplus accepted reference reachable across exact-full and final pages', async () => {
  const candidates = fixtureIds(6);
  const windows: SearchRef[][] = [];
  const service = new SearchService(persistence({
    lexical: async () => candidates.map(id => ({ id, exact: false })),
    hydrate: async (_viewer, refs) => {
      windows.push(refs);
      // Hydration can return duplicates, unexpected rows and arbitrary order.
      return [...refs, refs[0], { type: 'repository' as const, id: 'unknown' }].reverse()
        .map(ref => ({ ...ref, data: {} }));
    },
  }), async req => body(req, []));
  const req = request({ group: 'repositories', limit: 2 });
  const first = await service.search('viewer', req);
  assert.ok(windows[0].length > req.limit, 'the fixture must exercise surplus hydrated rows');
  assert.equal(first.next_cursor?.split(':')[1], '2', 'cursor consumes only the returned prefix');
  const second = await service.search('viewer', { ...req, cursor: first.next_cursor });
  assert.equal(second.next_cursor?.split(':')[1], '4');
  const third = await service.search('viewer', { ...req, cursor: second.next_cursor });
  assert.equal(third.next_cursor, null, 'an exactly full final page needs no empty follow-up');
  assert.deepEqual([...first.items, ...second.items, ...third.items].map(item => item.id), candidates);
  assert.ok([first, second, third].every(page => page.items.length === req.limit));
});

test('surplus references are rehydrated after permission and active-state changes between pages', async () => {
  const candidates = fixtureIds(4);
  const hidden = new Set<string>();
  const windows: SearchRef[][] = [];
  const service = new SearchService(persistence({
    lexical: async () => candidates.map(id => ({ id, exact: false })),
    hydrate: async (_viewer, refs) => {
      windows.push(refs);
      return refs.filter(ref => !hidden.has(ref.id)).map(ref => ({ ...ref, data: {} }));
    },
  }), async req => body(req, []));
  const req = request({ group: 'repositories', limit: 1 });
  const first = await service.search('viewer', req);
  assert.deepEqual(windows[0].map(ref => ref.id), candidates);
  hidden.add(candidates[1]); // Now private.
  hidden.add(candidates[2]); // Now inactive/deleted or no longer matches filters.
  const second = await service.search('viewer', { ...req, cursor: first.next_cursor });
  assert.deepEqual(second.items.map(item => item.id), [candidates[3]]);
  assert.deepEqual(windows[1].map(ref => ref.id), candidates.slice(1));
  assert.equal(second.next_cursor, null);
});

test('all-rejected windows have fixed work bounds and leave an oversized snapshot suffix reachable', async () => {
  const candidates: SearchRef[] = fixtureIds(405).map(id => ({ type: 'repository', id }));
  for (const [limit, rounds] of [[1, 17], [24, 6], [50, 4]]) {
    const req = request({ group: 'repositories', limit });
    const key = crypto.randomUUID();
    const binding = JSON.stringify(['viewer', req.query, req.group, [], [], []]);
    const windows: SearchRef[][] = [];
    const service = new SearchService(persistence({ hydrate: async (_viewer, refs) => {
      windows.push(refs);
      return refs.filter(ref => ref.id === candidates.at(-1)!.id).map(ref => ({ ...ref, data: {} }));
    } }), async () => { throw new Error('cursor must reuse its snapshot'); }, Date.now, {
      get: async () => ({ binding, refs: candidates, mode: 'lexical', expires: Date.now() + 120_000 }),
      set: async () => { throw new Error('cursor must not replace its snapshot'); },
    });
    const first = await service.search('viewer', { ...req, cursor: `${key}:0` });
    assert.deepEqual(first.items, []);
    assert.equal(first.next_cursor, `${key}:400`, 'budget exhaustion is not snapshot exhaustion');
    assert.equal(windows.length, rounds);
    assert.equal(windows.flat().length, 400);
    assert.ok(windows.every(refs => refs.length <= 100));
    const second = await service.search('viewer', { ...req, cursor: first.next_cursor });
    assert.deepEqual(second.items.map(item => item.id), [candidates.at(-1)!.id]);
    assert.equal(second.next_cursor, null);
    assert.equal(windows.flat().length, candidates.length);
  }
});

test('search snapshot deduplication prevents repeated typed references on later pages', async () => {
  const person = (id: string): SearchRef => ({ type: 'person', id: `user:${id}` });
  const list = (id: string): SearchRef => ({ type: 'list', id: `collection:${id}` });
  const service = new SearchService(persistence({
    lexical: async () => [],
    people: async () => [person(ids[0]), person(ids[0]), person(ids[1]), person(ids[0])],
    lists: async () => [list(ids[0]), list(ids[0])],
  }), async req => body(req, []));
  const req = request({ limit: 1 });
  const all: SearchRef[] = [];
  let cursor: string | null = null;
  do {
    const page = await service.search('viewer', { ...req, cursor });
    all.push(...page.items);
    cursor = page.next_cursor;
    assert.ok(all.length <= 3, 'duplicate candidates must not reappear on later pages');
  } while (cursor);
  assert.deepEqual(all.map(({ type, id }) => ({ type, id })), [person(ids[0]), list(ids[0]), person(ids[1])]);
});

test('empty snapshots do not hydrate, and rejected final windows end without a cursor', async () => {
  let calls = 0;
  const empty = new SearchService(persistence({ lexical: async () => [], hydrate: async () => {
    calls++; throw new Error('an empty snapshot needs no hydration');
  } }), async req => body(req, []));
  const result = await empty.search('viewer', request({ group: 'repositories' }));
  assert.deepEqual(result.items, []);
  assert.equal(result.next_cursor, null);
  assert.equal(calls, 0);
  const rejected = new SearchService(persistence({ hydrate: async () => [] }), async req => body(req, []));
  const final = await rejected.search('viewer', request());
  assert.deepEqual(final.items, []);
  assert.equal(final.next_cursor, null);
});
