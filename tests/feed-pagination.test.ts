import { FeedIntentLifecycle, type FeedSessionResult } from '../src/services/feedIntentLifecycle';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InfiniteQueryObserver, QueryClient, type InfiniteData } from '@tanstack/react-query';
import { FeedPaginationController, type FeedPage } from '../src/services/feedPagination';
import { requestFeedWithRetry, waitForFeedRetry } from '../src/services/feedTransport';

const page = (ids: string[], version = '1', cursor: string | null = 'next'): FeedPage => ({
  items: ids.map((id, position) => ({ repo_id: id, serve_id: `serve-${version}`, position })),
  nextCursor: cursor, feedVersion: version, sessionId: 'cached-session',
});
const stale = () => Object.assign(new Error('stale'), { status: 400, code: 'FEED_CURSOR_STALE' });
const request = { feed_request_id: 'request', session_id: 'session', limit: 10, cursor: 'cursor' };

test('feed retries preserve request identity, respect Retry-After and stop after three attempts', async () => {
  const bodies: unknown[] = [];
  const waits: number[] = [];
  await assert.rejects(requestFeedWithRetry(request, async (body) => {
    bodies.push(body);
    throw Object.assign(new Error('preparing'), { status: 409, retryAfter: '2' });
  }, undefined, async (ms) => { waits.push(ms); }), /preparing/);
  assert.deepEqual(bodies, [request, request, request]);
  assert.deepEqual(waits, [2000, 2000]);
});

test('deferred feed retries inline only after an explicit pre-commit compatibility rejection', async () => {
  const body = { ...request, readme_mode: 'deferred' as const };
  for (const failure of [
    Object.assign(new Error('media manifest is incomplete'), { status: 409, code: 'FEED_README_MEDIA_UNAVAILABLE' }),
    Object.assign(new Error('deferred mode is unsupported'), { status: 400, code: 'INVALID_FEED_README_MODE' }),
  ]) {
    const bodies: unknown[] = [];
    let calls = 0;
    const result = await requestFeedWithRetry(body, async (sent) => {
      bodies.push(sent);
      if (calls++ === 0) throw failure;
      return 'served';
    }, undefined, async () => { throw new Error('Explicit compatibility fallback does not wait'); });

    assert.equal(result, 'served');
    assert.deepEqual(bodies, [body, { ...body, readme_mode: 'inline' }]);
  }
});

test('transient network and server failures recover, validation and expired sessions do not retry', async () => {
  let calls = 0;
  const bodies: { readme_mode?: string }[] = [];
  const result = await requestFeedWithRetry({ ...request, readme_mode: 'deferred' }, async (body) => {
    bodies.push(body);
    calls++;
    if (calls === 1) throw new TypeError('Network request failed');
    if (calls === 2) throw Object.assign(new Error('unavailable'), { status: 503 });
    return 'ready';
  }, undefined, async () => {});
  assert.equal(result, 'ready');
  assert.deepEqual(bodies.map(body => body.readme_mode), ['deferred','deferred','deferred']);
  const conflictBodies: { readme_mode?: string }[] = [];
  let conflictCalls = 0;
  await requestFeedWithRetry({ ...request, readme_mode: 'deferred' }, async (body) => {
    conflictBodies.push(body);
    if (conflictCalls++ === 0) throw Object.assign(new Error('unrelated conflict'), { status: 409, code: 'OTHER_CONFLICT' });
    return 'ready';
  }, undefined, async () => {});
  assert.deepEqual(conflictBodies.map(body => body.readme_mode), ['deferred','deferred']);
  for (const failure of [stale(), Object.assign(new Error('unauthorized'), { status: 401 }),
    Object.assign(new Error('account changed'), { code: 'SESSION_CHANGED' })]) {
    let attempts = 0;
    await assert.rejects(requestFeedWithRetry(request, async () => { attempts++; throw failure; }));
    assert.equal(attempts, 1);
  }
});

test('cancellation interrupts a Retry-After wait and prevents late responses', async () => {
  const abort = new AbortController();
  const waiting = waitForFeedRetry(60_000, abort.signal);
  abort.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  const late = new AbortController();
  await assert.rejects(requestFeedWithRetry(request, async () => {
    late.abort(); return 'too late';
  }, late.signal), { name: 'AbortError' });
});

test('concurrent end triggers share one pagination operation without waiting for telemetry', async () => {
  let release!: (value: FeedPage) => void;
  let requests = 0;
  const coordinator = new FeedPaginationController(async () => {
    requests++;
    return new Promise<FeedPage>((resolve) => { release = resolve; });
  });
  const first = coordinator.load('next');
  const second = coordinator.load('next');
  assert.equal(requests, 1);
  release(page(['a']));
  assert.strictEqual(await first, await second);
});

test('acknowledged invalidation retains loaded serves and restarts once with unseen recovery rows', async () => {
  const calls: { cursor: string | null; id: string }[] = [];
  const coordinator = new FeedPaginationController(async (cursor, _signal, id) => {
    calls.push({ cursor, id });
    return page(['a', 'b'], '2', 'after-recovery');
  }, [page(['a'])]);
  coordinator.markStale('2');
  const recovered = await coordinator.load('old-cursor');
  assert.deepEqual(calls.map((call) => call.cursor), [null]);
  assert.deepEqual(recovered.items.map((item) => item.repo_id), ['b']);
  assert.equal(recovered.nextCursor, 'after-recovery');
});

test('a version race restarts once and automatically crosses duplicate-only recovery pages', async () => {
  const calls: { cursor: string | null; id: string }[] = [];
  const coordinator = new FeedPaginationController(async (cursor, _signal, id) => {
    calls.push({ cursor, id });
    if (calls.length === 1) { coordinator.markStale('2'); return page(['b']); }
    return calls.length === 2 ? page(['a'], '2', 'continue') : page(['c'], '2', 'after-duplicates');
  }, [page(['a'])]);
  const recovered = await coordinator.load('old-cursor');
  assert.deepEqual(calls.map((call) => call.cursor), ['old-cursor', null, 'continue']);
  assert.notEqual(calls[0].id, calls[1].id);
  assert.deepEqual(recovered.items.map(item => item.repo_id), ['c']);
  assert.equal(recovered.nextCursor, 'after-duplicates');
  assert.equal(calls.length, 3);
});

test('typed stale cursor restarts once; malformed cursor is never silently restarted', async () => {
  for (const typed of [true, false]) {
    let calls = 0;
    const coordinator = new FeedPaginationController(async () => {
      calls++; throw typed ? stale() : Object.assign(new Error('invalid cursor'), { status: 400 });
    }, [page(['a'])]);
    await assert.rejects(coordinator.load('old-cursor'));
    assert.equal(calls, typed ? 2 : 1);
  }
});

test('ambiguous failures retain request identity and repeated repositories are removed from ordinary pages', async () => {
  const ids: string[] = [];
  const coordinator = new FeedPaginationController(async (_cursor, _signal, id) => {
    ids.push(id);
    if (ids.length === 1) throw new TypeError('offline');
    return page(['a', 'b']);
  }, [page(['a'])]);
  await assert.rejects(coordinator.load('next'));
  assert.deepEqual((await coordinator.load('next')).items.map((item) => item.repo_id), ['b']);
  assert.equal(ids[0], ids[1]);
});

test('reset isolates a new browsing session from a cancelled late page', async () => {
  let release!: (value: FeedPage) => void;
  const coordinator = new FeedPaginationController(async () => new Promise<FeedPage>((resolve) => { release = resolve; }));
  const pending = coordinator.load('old-cursor');
  coordinator.reset();
  release(page(['old-account']));
  await assert.rejects(pending, { name: 'AbortError' });
});


test('a remounted Home reuses the session bound to cached cursors; refresh creates a new session', async () => {
  const sessions: string[] = [];
  const coordinator = new FeedPaginationController(async (cursor, _signal, _id, session) => {
    sessions.push(session);
    if (cursor && session !== 'cached-session') throw Object.assign(new Error('wrong session'), { status: 400 });
    return { ...page(['b']), sessionId: session };
  }, [page(['a'])]);
  await coordinator.load('cached-cursor');
  assert.equal(sessions[0], 'cached-session');
  coordinator.reset();
  await coordinator.load(null);
  assert.notEqual(sessions[1], 'cached-session');
});


test('ordinary duplicate-only pages continue automatically until new repos arrive', async () => {
  const cursors: (string | null)[] = [];
  const coordinator = new FeedPaginationController(async cursor => {
    cursors.push(cursor);
    return cursors.length === 1 ? page(['a'], '1', 'continue') : page(['a','b'], '1', null);
  }, [page(['a'])]);
  const result = await coordinator.load('next');
  assert.deepEqual(cursors, ['next','continue']);
  assert.deepEqual(result.items.map(item => item.repo_id), ['b']);
  assert.equal(result.nextCursor, null);
});

test('a failed duplicate scan resumes its current request without dropping newly returned repos', async () => {
  const calls: {cursor: string | null; id: string}[] = [];
  const coordinator = new FeedPaginationController(async (cursor,_signal,id) => {
    calls.push({cursor,id});
    if (calls.length === 1) return page(['a'],'1','unseen-page');
    if (calls.length === 2) throw new TypeError('offline');
    return page(['b'],'1',null);
  }, [page(['a'])]);
  await assert.rejects(coordinator.load('next'), /offline/);
  const result = await coordinator.load('next');
  assert.equal(calls[1].cursor, 'unseen-page');
  assert.deepEqual(calls[2], calls[1]);
  assert.deepEqual(result.items.map(item => item.repo_id), ['b']);
});

test('duplicate-only loops fail visibly within a finite scan budget instead of spinning forever', async () => {
  let requests = 0;
  const coordinator = new FeedPaginationController(async () => {
    requests++;
    if (requests > 5) throw new Error('unbounded duplicate fetch');
    return page(['a'],'1',`cursor-${requests}`);
  }, [page(['a'])]);
  await assert.rejects(coordinator.load('next'), /No new repositories/);
  assert.ok(requests > 0 && requests <= 5);
});

test('a cancellation during duplicate scanning stops further page fetches', async () => {
  const abort = new AbortController(); let calls = 0;
  const coordinator = new FeedPaginationController(async () => {
    calls++; abort.abort(); return page(['a'],'1','continue');
  }, [page(['a'])]);
  await assert.rejects(coordinator.load('next',abort.signal), {name:'AbortError'});
  assert.equal(calls,1);
});

test('an acknowledgement does not discard a page already generated at the acknowledged version', async () => {
  let calls = 0;
  const coordinator = new FeedPaginationController(async () => {
    calls++; coordinator.markStale('2'); return page(['b'],'2','after');
  }, [page(['a'])]);
  assert.deepEqual((await coordinator.load('next')).items.map(item => item.repo_id), ['b']);
  assert.equal(calls,1);
});

const feedKey = ['feed', 'synthetic-user'] as const;
const cachedPages = () => ({ pages: [page(['a'], '1', 'page-2'), page(['b'], '1', 'page-3')], pageParams: [null, 'page-2'] });
const committedIds = (client: QueryClient) => client.getQueryData<InfiniteData<FeedPage>>(feedKey)!.pages
  .flatMap(result => result.items.map(item => item.repo_id));

function observeFeed(client: QueryClient, controller: FeedPaginationController) {
  return new InfiniteQueryObserver(client, {
    queryKey: feedKey,
    queryFn: ({ pageParam, signal }) => controller.load(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: FeedPage) => lastPage.nextCursor ?? undefined,
    retry: false, staleTime: Infinity, refetchOnMount: false,
  });
}

test('failed multi-page query refetch does not hide a repository that never committed', async () => {
  const client = new QueryClient();
  client.setQueryData(feedKey, cachedPages());
  const calls: (string | null)[] = [];
  const controller = new FeedPaginationController(async cursor => {
    calls.push(cursor);
    if (cursor === null) return page(['c'], '1', 'replacement-2');
    if (cursor === 'replacement-2') throw new TypeError('offline on page 2');
    return page(['c'], '1', null);
  }, cachedPages().pages, () => client.getQueryData<InfiniteData<FeedPage>>(feedKey)?.pages ?? []);
  const observer = observeFeed(client, controller);
  const unsubscribe = observer.subscribe(() => {});
  try {
    assert.equal((await observer.refetch()).isRefetchError, true);
    assert.deepEqual(committedIds(client), ['a', 'b']);
    await observer.fetchNextPage({ cancelRefetch: false });
    assert.deepEqual(committedIds(client), ['a', 'b', 'c']);
    assert.deepEqual(calls, [null, 'replacement-2', 'page-3']);
  } finally { unsubscribe(); client.clear(); }
});

test('successful invalidation preserves replacement cards and deduplicates within the new pages', async () => {
  const client = new QueryClient();
  client.setQueryData(feedKey, cachedPages());
  const controller = new FeedPaginationController(async cursor => cursor === null
    ? page(['a'], '1', 'page-2') : page(['a', 'b'], '1', null),
  cachedPages().pages, () => client.getQueryData<InfiniteData<FeedPage>>(feedKey)?.pages ?? []);
  const observer = observeFeed(client, controller);
  const unsubscribe = observer.subscribe(() => {});
  try {
    await client.invalidateQueries({ queryKey: feedKey });
    assert.deepEqual(committedIds(client), ['a', 'b']);
  } finally { unsubscribe(); client.clear(); }
});

test('cancelled replacement pages do not become committed deduplication history', async () => {
  const client = new QueryClient();
  client.setQueryData(feedKey, cachedPages());
  let pageTwoStarted!: () => void;
  const started = new Promise<void>(resolve => { pageTwoStarted = resolve; });
  const controller = new FeedPaginationController(async (cursor, signal) => {
    if (cursor === null) return page(['c'], '1', 'replacement-2');
    if (cursor === 'replacement-2') {
      pageTwoStarted();
      return new Promise<FeedPage>((_resolve, reject) => signal!.addEventListener('abort',
        () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
    }
    return page(['c'], '1', null);
  }, cachedPages().pages, () => client.getQueryData<InfiniteData<FeedPage>>(feedKey)?.pages ?? []);
  const observer = observeFeed(client, controller);
  const unsubscribe = observer.subscribe(() => {});
  try {
    const refetch = observer.refetch();
    await started;
    await client.cancelQueries({ queryKey: feedKey });
    await refetch;
    assert.deepEqual(committedIds(client), ['a', 'b']);
    await observer.fetchNextPage();
    assert.deepEqual(committedIds(client), ['a', 'b', 'c']);
  } finally { unsubscribe(); client.clear(); }
});

test('query-cache replacement and reset discard removed committed history before appending', async () => {
  const client = new QueryClient();
  client.setQueryData(feedKey, cachedPages());
  let reset = false;
  const controller = new FeedPaginationController(async cursor => reset && cursor === null
    ? page(['b'], '1', 'reset-next') : page(['b', 'a'], '1', null),
  client.getQueryData<InfiniteData<FeedPage>>(feedKey)!.pages,
  () => client.getQueryData<InfiniteData<FeedPage>>(feedKey)?.pages ?? []);
  const observer = observeFeed(client, controller);
  const unsubscribe = observer.subscribe(() => {});
  try {
    client.setQueryData(feedKey, { pages: [page(['b'], '1', 'replacement-next')], pageParams: [null] });
    await observer.fetchNextPage();
    assert.deepEqual(committedIds(client), ['b', 'a']);
    reset = true;
    await client.resetQueries({ queryKey: feedKey, exact: true });
    assert.deepEqual(committedIds(client), ['b']);
    await observer.fetchNextPage();
    assert.deepEqual(committedIds(client), ['b', 'a']);
  } finally { unsubscribe(); client.clear(); }
});

test('append history reads each newly committed card once instead of rescanning old pages', async () => {
  let reads = 0;
  const measuredPage = (id: string, cursor: string | null) => ({
    ...page([], '1', cursor), items: [{ get repo_id() { reads++; return id; } }],
  });
  let committed = [measuredPage('initial', 'next')];
  let count = 0;
  const controller = new FeedPaginationController(async () => measuredPage(`new-${++count}`, 'next'),
    committed, () => committed);
  reads = 0;
  for (let index = 0; index < 100; index++) {
    const result = await controller.load('next', new AbortController().signal);
    assert.equal(result.items[0].repo_id, `new-${index + 1}`);
    committed = [...committed, result];
  }
  console.log(`APPEND_HISTORY_MEASURE ${JSON.stringify({ pages: count, idReads: reads })}`);
  assert.ok(reads <= count * 5, `100 appends reread history ${reads} times`);
});

test('replacement pagination does not copy its growing staged ID history', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Set.prototype, Symbol.iterator)!;
  const iterate = Set.prototype[Symbol.iterator];
  let copiedIds = 0;
  // Count actual historical IDs traversed by Set copies, not elapsed time or
  // private controller state. Restore the native iterator before leaving.
  Object.defineProperty(Set.prototype, Symbol.iterator, { ...descriptor, value: function* (this: Set<unknown>) {
    for (const value of iterate.call(this)) {
      if (typeof value === 'string' && value.startsWith('replacement-')) copiedIds++;
      yield value;
    }
  } });
  try {
    let count = 0;
    const controller = new FeedPaginationController(async () => {
      count++;
      return page([`replacement-${count}`], '1', count < 60 ? `cursor-${count}` : null);
    }, [], () => []);
    const signal = new AbortController().signal;
    let cursor: string | null = null;
    for (let index = 0; index < 60; index++) {
      const result = await controller.load(cursor, signal);
      assert.equal(result.items.length, 1);
      cursor = result.nextCursor;
    }
    console.log(`REPLACEMENT_HISTORY_MEASURE ${JSON.stringify({ pages: count, copiedIds })}`);
    assert.ok(copiedIds <= count, `60 replacement pages recopied ${copiedIds} prior IDs`);
  } finally { Object.defineProperty(Set.prototype, Symbol.iterator, descriptor); }
});

for (const duringRequest of [false, true]) {
  test(`catalogue continuation keeps its cursor after interaction invalidation (${duringRequest ? 'in flight' : 'before request'})`, async () => {
    const loaded = Array.from({ length: 6 }, (_, index) => ({
      ...page(Array.from({ length: 10 }, (_, n) => `catalogue-${index * 10 + n}`), '0', `discovery:${(index + 1) * 10}`),
      mode: 'discovery' as const,
    }));
    const calls: (string | null)[] = [];
    const controller = new FeedPaginationController(async cursor => {
      calls.push(cursor);
      if (duringRequest) { controller.markStale(); controller.markStale('8'); }
      if (cursor === null) return { ...page(['personalized-card'], '8'), mode: 'personalized' };
      return { ...page(['catalogue-60'], '0', 'discovery:70'), mode: 'discovery' };
    }, loaded);
    if (!duringRequest) { controller.markStale(); controller.markStale('8'); }
    const next = await controller.load('discovery:60');
    assert.deepEqual(calls, ['discovery:60']);
    assert.equal(next.mode, 'discovery');
    assert.deepEqual(next.items.map(item => item.repo_id), ['catalogue-60']);
    assert.equal(next.nextCursor, 'discovery:70');
  });
}

test('catalogue errors never enter personalized stale-cursor recovery', async () => {
  const calls: (string | null)[] = [];
  const controller = new FeedPaginationController(async cursor => {
    calls.push(cursor); throw stale();
  }, [{ ...page(['catalogue-0'], '0', 'discovery:10'), mode: 'discovery' }]);
  await assert.rejects(controller.load('discovery:10'));
  assert.deepEqual(calls, ['discovery:10']);
});

for (const invalidation of ['acknowledged', 'cursor-rejected'] as const) {
  test(`personalized ${invalidation} continuation cannot append catalogue cards`, async () => {
    const loaded=[{...page(['personalized-1']),mode:'personalized' as const}];
    let available=false;
    const calls:(string|null)[]=[];
    const controller=new FeedPaginationController(async cursor=>{
      calls.push(cursor);
      if (cursor!==null) throw stale();
      return available ? {...page(['personalized-2'],'2'),mode:'personalized'}
        : {...page(['catalogue-1'],'0','discovery:10'),mode:'discovery'};
    },loaded,()=>loaded);
    if(invalidation==='acknowledged') controller.markStale('2');
    await assert.rejects(controller.load('personalized-next'),{code:'PERSONALIZED_FEED_UNAVAILABLE'});
    assert.deepEqual(loaded[0].items.map(item=>item.repo_id),['personalized-1']);
    available=true;
    assert.equal((await controller.load('personalized-next')).mode,'personalized');
    controller.reset(); available=false;
    assert.equal((await controller.load(null)).mode,'discovery','Deliberate refresh may change the source');
  });
}

test('an explicit multi-page refresh may replace catalogue pages with personalized pages',async()=>{
  const loaded=[{...page(['catalogue-old'],'0','discovery:10'),mode:'discovery' as const}];
  const signal=new AbortController().signal;
  const controller=new FeedPaginationController(async cursor=>({...page([cursor?'personalized-2':'personalized-1'],'2',cursor?null:'next'),mode:'personalized'}),loaded,()=>loaded);
  assert.equal((await controller.load(null,signal)).mode,'personalized');
  assert.equal((await controller.load('next',signal)).mode,'personalized');
});


{
const owner='00000000-0000-4000-8000-000000000035',session='00000000-0000-4000-8000-000000000036';

test('preparation reuses only this call inspection and writes only changed durable intent', async t => {
 let stored:string|null=null, inspections=0, writes=0, epoch='1', active=false;
 const deps={read:async()=>stored,write:async(value:string)=>{writes++;stored=value;},assertCurrent:()=>{},
  inspect:async(id:string):Promise<FeedSessionResult|null>=>{inspections++;return active?{mode:'ordered',session:{session_id:id,epoch,status:'active'}}:null;},
  send:async(control:FeedSessionControl):Promise<FeedSessionResult>=>{
   assert.ok(stored?.includes(control.request_id),'a control is durable before I/O');active=true;
   if(control.kind==='reset')epoch=(BigInt(control.expected_epoch)+1n).toString();
   return {mode:'ordered',session:{session_id:control.session_id,epoch,status:'active'}};
  }};
 const client=new FeedIntentLifecycle(owner,deps);
 await client.prepare(session);
 t.diagnostic(`new ordered session: ${inspections} inspections, ${writes} writes (fixture boundaries, not production timing)`);
 assert.deepEqual([inspections,writes],[1,2],'one authoritative lookup, then durable Begin and acknowledgement');
 const original=stored;inspections=0;writes=0;
 await client.prepare(session);
 assert.deepEqual([inspections,writes],[1,0],'each next page still inspects, without rewriting unchanged state');
 assert.equal(stored,original);
 inspections=0;writes=0;
 await new FeedIntentLifecycle(owner,deps).prepare(session);
 assert.deepEqual([inspections,writes],[1,0],'restart validates the stored canonical session once');
 epoch='2';inspections=0;writes=0;
 await client.prepare(session);
 assert.deepEqual([inspections,writes],[1,1],'another client epoch is inspected and persisted, never cached away');
 assert.equal(JSON.parse(stored!).entries[0].epoch,'2');
});

test('failed acknowledgement persistence retries changed state without reissuing accepted Begin', async()=>{
 let stored:string|null=null, failAck=true, active=false, sends=0;
 const client=new FeedIntentLifecycle(owner,{read:async()=>stored,assertCurrent:()=>{},
  write:async value=>{if(active&&failAck)throw new Error('quota');stored=value;},
  inspect:async():Promise<FeedSessionResult|null>=>active?{mode:'ordered',session:{session_id:session,epoch:'1',status:'active'}}:null,
  send:async():Promise<FeedSessionResult>=>{sends++;active=true;return {mode:'ordered',session:{session_id:session,epoch:'1',status:'active'}};}});
 await assert.rejects(client.prepare(session),/quota/);
 assert.equal(JSON.parse(stored!).entries[0].pending.length,1);
 failAck=false;await client.prepare(session);
 assert.equal(sends,1);assert.equal(JSON.parse(stored!).entries[0].pending.length,0);
});
}

test('page prefetch starts with six remaining cards and stops for background, offline, failure or outstanding work', async () => {
  const {shouldPrefetchFeedPage}=await import('../src/services/feedPagination');
  const ready={remaining:6,hasNextPage:true,fetching:false,failed:false,active:true,online:true};
  assert.equal(shouldPrefetchFeedPage(ready),true);
  for(const changed of [{remaining:7},{remaining:-1},{hasNextPage:false},{fetching:true},{failed:true},{active:false},{online:false}]) {
    assert.equal(shouldPrefetchFeedPage({...ready,...changed}),false);
  }
});

test('consuming navigation attribution preserves the live Home controller and pending page', async () => {
  const {loadSource}=await import('./support/startup-harness');
  const {SessionLifecycle}=await import('../src/api/session-lifecycle');
  const {takeFeedNavigation}=await import('../src/services/feedImpressionAttribution');
  const lifecycle=new SessionLifecycle();
  let finish!: (value:FeedPage)=>void;
  const pending=new Promise<FeedPage>(resolve=>{finish=resolve;});
  const token=`header.${Buffer.from(JSON.stringify({userId:'alice'})).toString('base64url')}.signature`;
  const source=loadSource('src/services/homeFeedQuery.ts',{
    '../utils/storage':{getStorageItem:async()=>token},
    '../api/session-lifecycle':{authSessionLifecycle:lifecycle},
    '../api/feed-sessions':{feedSessions:()=>({prepare:async(session:string)=>session})},
    '../api/home-feed':{fetchHomeFeed:()=>pending},
  });
  const client=new QueryClient();
  client.setQueryData(['feed','alice'],{pages:[page(['loaded'])],pageParams:[null]});
  const controller=source.homeFeedController(client,'alice');
  const loading=controller.load('next');
  await new Promise(resolve=>setTimeout(resolve,0));
  const navigationKey=['feed','alice','navigation','00000000-0000-4000-8000-000000000010'];
  client.setQueryData(navigationKey,{ownerId:'alice',repoId:'loaded',generation:lifecycle.currentGeneration()});
  takeFeedNavigation(client,'alice','loaded','00000000-0000-4000-8000-000000000010',lifecycle.currentGeneration());
  assert.strictEqual(source.homeFeedController(client,'alice'),controller);
  finish(page(['next']));
  assert.equal((await loading).items[0].repo_id,'next');
  client.removeQueries({queryKey:['feed','alice'],exact:true});
  assert.notStrictEqual(source.homeFeedController(client,'alice'),controller,'Removing Home itself releases the controller');
  source.releaseHomeFeedController(client);client.clear();
});


test('Home follows up preparation once with the same request and stops on persistent failure',async()=>{
 const {loadSource}=await import('./support/startup-harness');
 const error=Object.assign(new Error('Recommendations are still being prepared'),{status:503,code:'PERSONALIZED_FEED_UNAVAILABLE',retryAfter:'3'});
 for(const recovers of [true,false]) {
  const bodies:unknown[]=[];const waits:number[]=[];
  const source=loadSource('src/api/home-feed.ts',{
   './feed':{fetchFeed:async(_token:string,_cursor:unknown,options:any)=>requestFeedWithRetry(request,async body=>{
     bodies.push(body);if(recovers&&bodies.length===2)return page(['ready']);throw error;
   },options.signal,async ms=>{waits.push(ms);},options.retryUnavailable,options.preparationRetryLimit)},
  });
  if(recovers)assert.equal((await source.fetchHomeFeed('token',null)).items[0].repo_id,'ready');
  else await assert.rejects(source.fetchHomeFeed('token',null),failure=>failure===error);
  assert.deepEqual(bodies,[request,request]);assert.deepEqual(waits,[3000]);
 }
});


test('Home loads with React Native AbortSignal and cancels before sending after token storage', async () => {
  const { AbortController: NativeAbortController } = await import('abort-controller');
  const { loadSource } = await import('./support/startup-harness');
  const { SessionLifecycle } = await import('../src/api/session-lifecycle');
  const lifecycle = new SessionLifecycle();
  const token = `header.${Buffer.from(JSON.stringify({userId:'alice'})).toString('base64url')}.signature`;
  let cancelDuringRead = false;
  let signalController = new NativeAbortController();
  let sends = 0;
  const source = loadSource('src/services/homeFeedQuery.ts', {
    '../utils/storage': {getStorageItem: async () => {
      if (cancelDuringRead) signalController.abort();
      return token;
    }},
    '../api/session-lifecycle': {authSessionLifecycle:lifecycle},
    '../api/feed-sessions': {feedSessions: () => ({prepare: async (session:string) => session})},
    '../api/home-feed': {fetchHomeFeed: async () => {sends++; return page(['android-repo'], '1', null);}},
  });
  const client = new QueryClient();
  try {
    const result = await source.homeFeedController(client, 'alice').load(null, signalController.signal as AbortSignal);
    assert.equal(result.items[0].repo_id, 'android-repo');
    assert.equal(sends, 1);
    source.releaseHomeFeedController(client);
    cancelDuringRead = true;
    signalController = new NativeAbortController();
    await assert.rejects(source.homeFeedController(client, 'alice').load(null, signalController.signal as AbortSignal), {name:'AbortError'});
    assert.equal(sends, 1, 'cancelled storage completion must never send another request');
  } finally {source.releaseHomeFeedController(client); client.clear();}
});
