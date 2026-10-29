import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript';
import type { fetchExploreRepos } from '../src/api/explore';
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { isSearchExpired, runSearchRequest, searchQueryOptions, SearchSessions, SearchRequestTiming, SEARCH_DEBOUNCE_MS } from "../src/api/search-query";
import { mapTrendingRepository } from "../src/api/explore-data";
import { mapRepositoryDetail } from "../src/utils/repository-mapper";
import { searchResultHref, SEARCH_GROUPS, type SearchPage } from "../src/models/search";
import { mapCollectionList, mapLegacyBoardList } from "../src/models/list";

describe("search", () => {
  const projection = {
    repo_id: 'canonical-id', name: 'vision', owner: 'owner', full_name: 'owner/vision',
    url: 'https://github.com/owner/vision', description: 'Useful image models.',
    primary_language: 'Python', star_count: 120, fork_count: 20,
  };

  const page = (cursor: string | null = null): SearchPage => ({
    items: [{ type: 'repository', id: projection.repo_id, data: mapRepositoryDetail(projection)! }],
    next_cursor: cursor, mode: 'hybrid',
  });

  const tick = () => new Promise(resolve => setTimeout(resolve, 0));

  test('returning to a search group offline reuses cached pages until explicitly restarted', () => {
    let sequence = 0;
    const sessions = new SearchSessions(() => `session-${++sequence}`);
    const client = new QueryClient();
    const input = { viewer: 'viewer', query: 'vision', group: 'all' as const,
      searchId: sessions.get('viewer', 'vision', 'all'), composing: false, offline: true, send: async () => page() };
    const options = searchQueryOptions(input);
    client.setQueryData(options.queryKey, { pages: [page()], pageParams: [null] });
    sessions.get('viewer', 'vision', 'people');
    const returned = searchQueryOptions({ ...input, searchId: sessions.get('viewer', ' vision ', 'all') });
    assert.deepEqual(client.getQueryData(returned.queryKey), { pages: [page()], pageParams: [null] });
    assert.notEqual(sessions.get('other-viewer', 'vision', 'all'), input.searchId);
    assert.notEqual(sessions.get('viewer', 'different', 'all'), input.searchId);
    const restarted = sessions.get('viewer', 'vision', 'all', true);
    assert.notEqual(restarted, input.searchId);
    assert.equal(sessions.get('viewer', 'vision', 'all'), restarted);
    client.clear();
  });

  test('Trending preserves backend ranking and rejects absent or malformed positions', () => {
    const repo = mapTrendingRepository({ ...projection, position: 1, score: 0.8, features: { trend_velocity: 12 } }, 'daily', null)!;
    assert.equal(repo.trend?.rank, 2);
    assert.equal(repo.trend?.score, 0.8);
    assert.equal(repo.trend?.features.trend_velocity, 12);
    assert.equal(repo.stats.stars, 120);
    assert.equal(repo.stats.forks, 20);
    assert.equal(repo.primaryLanguage, 'Python');
    assert.equal(mapTrendingRepository(projection, 'daily', null), null);
    assert.equal(mapTrendingRepository({ ...projection, position: 'bad' }, 'daily', null), null);
    assert.equal(mapTrendingRepository({ ...projection, position: null }, 'daily', null), null);
  });

  test('all result types route to existing internal entity routes', () => {
    assert.deepEqual(searchResultHref(page().items[0]), {
      pathname: '/repository/[repoId]', params: { repoId: 'canonical-id' },
    });
    for (const [user_id, profile_id] of [['user-id', null], [null, 'profile-id']]) {
      assert.deepEqual(searchResultHref({ type: 'person', id: 'person', data: {
        user_id, profile_id, username: 'dev', display_name: null, bio: null, github_handle: null, avatar_url: null,
      } }), { pathname: '/user/[username]', params: {
        username: 'dev', ...(user_id ? { userId: user_id } : { profileId: profile_id }),
      } });
    }
    for (const source of ['collection', 'legacy-board'] as const) {
      assert.deepEqual(searchResultHref({ type: 'list', id: 'list', data: {
        id: 'list', name: 'Vision', description: null, repositoryCount: 2, source, icon: null, color: null, nestedListCount: 0, selected: false, createdAt: null, updatedAt: null, lastUpdatedAt: null,
      } }), { pathname: '/board', params: {
        boardName: 'Vision', boardDescription: '',
        ...(source === 'collection' ? { collectionId: 'list', collectionType: 'collection' } : { boardId: 'list' }),
      } });
    }
    assert.deepEqual(SEARCH_GROUPS.map(group => group.id), ['all', 'repositories', 'people', 'lists']);
  });

  test('cancellation prevents a superseded debounce from reaching transport', async () => {
    const controller = new AbortController();
    let called = false;
    const request = runSearchRequest(controller.signal, 300, async () => { called = true; return page(); });
    controller.abort();
    await assert.rejects(request);
    assert.equal(called, false);
  });

  test('production query options preserve cached pages offline and separate viewers', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
    const input = {
      viewer: 'viewer-a', query: 'vision', group: 'all' as const, searchId: 'session',
      composing: false, offline: false, send: async () => page('cursor-2'),
    };
    const options = searchQueryOptions(input);
    client.setQueryData(options.queryKey, { pages: [page('cursor-2')], pageParams: [null] });
    const observer = new InfiniteQueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => {});
    observer.setOptions(searchQueryOptions({ ...input, offline: true }));
    assert.deepEqual(observer.getCurrentResult().data?.pages, [page('cursor-2')]);
    assert.deepEqual(searchQueryOptions({ ...input, offline: true }).queryKey, options.queryKey);
    assert.notDeepEqual(searchQueryOptions({ ...input, viewer: 'viewer-b' }).queryKey, options.queryKey);
    assert.equal(searchQueryOptions({ ...input, viewer: undefined }).enabled, false);
    assert.equal(searchQueryOptions({ ...input, query: 'v' }).enabled, false);
    assert.equal(searchQueryOptions({ ...input, composing: true }).enabled, false);
    unsubscribe(); client.clear();
  });

  test('superseding a production query aborts transport and ignores late results', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
    let signal: AbortSignal | undefined;
    let release!: (value: SearchPage) => void;
    const input = {
      viewer: 'viewer', query: 'old', group: 'all' as const, searchId: 'old-session', composing: false, offline: false,
      send: async (_cursor: string | null, active: AbortSignal) => {
        signal = active;
        return new Promise<SearchPage>(resolve => { release = resolve; });
      },
    };
    // Seed a cursor so the first transport starts without the initial debounce.
    const observer = new InfiniteQueryObserver(client, {
      ...searchQueryOptions(input), initialPageParam: 'cursor',
    });
    const unsubscribe = observer.subscribe(() => {});
    await tick();
    observer.setOptions({
      ...searchQueryOptions({ ...input, query: 'new', searchId: 'new-session', send: async () => page() }),
      initialPageParam: 'cursor',
    });
    await tick();
    assert.equal(signal?.aborted, true);
    release({ items: [], next_cursor: null, mode: 'lexical' });
    await tick();
    assert.deepEqual(observer.getCurrentResult().data?.pages, [page()]);
    unsubscribe(); client.clear();
  });

  test('expired pagination retains results and a fresh session restarts from page one', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
    const cursors: (string | null)[] = [];
    const input = {
      viewer: 'viewer', query: 'vision', group: 'all' as const, searchId: 'expired', composing: false, offline: false,
      send: async (cursor: string | null) => {
        cursors.push(cursor);
        if (cursor) throw Object.assign(new Error('Search expired'), { status: 410 });
        return page('next');
      },
    };
    const options = searchQueryOptions(input);
    client.setQueryData(options.queryKey, { pages: [page('next')], pageParams: [null] });
    const observer = new InfiniteQueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => {});
    await observer.fetchNextPage();
    assert.equal(isSearchExpired(observer.getCurrentResult().error), true);
    assert.equal(observer.getCurrentResult().isFetchNextPageError, true);
    assert.deepEqual(observer.getCurrentResult().data?.pages, [page('next')]);
    observer.setOptions(searchQueryOptions({ ...input, searchId: 'fresh' }));
    await new Promise(resolve => setTimeout(resolve, 330));
    assert.deepEqual(cursors, ['next', null]);
    assert.deepEqual(observer.getCurrentResult().data?.pageParams, [null]);
    assert.equal(observer.getCurrentResult().error, null);
    unsubscribe(); client.clear();
  });

  test('typing waits only for its remaining deadline while filter, restart and retry are immediate', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const timing = new SearchRequestTiming();
    const controller = new AbortController();
    let sends = 0;
    const send = async () => { sends += 1; return page(); };
    const input = { viewer: 'viewer', query: 'vision', group: 'all' as const,
      searchId: 'session', composing: false, offline: false, timing, send };
    const request = () => searchQueryOptions(input).queryFn!({
      signal: controller.signal, pageParam: null, queryKey: searchQueryOptions(input).queryKey,
      client: new QueryClient(), direction: 'forward', meta: undefined,
    });
    timing.typed();
    const typing = request();
    assert.equal(sends, 0);
    t.mock.timers.tick(299);
    await Promise.resolve();
    assert.equal(sends, 0);
    t.mock.timers.tick(1);
    await typing;
    assert.equal(sends, 1);
    for (const _intent of ['filter', 'restart', 'retry']) {
      timing.typed();
      timing.explicit();
      const explicit = request();
      assert.equal(sends, ['filter', 'restart', 'retry'].indexOf(_intent) + 2);
      await explicit;
    }
  });
});

describe("search repository model", () => {
  const repo = mapTrendingRepository({ repo_id:'canonical-id',full_name:'owner/vision',position:1,score:0.8,
    features:{ trend_velocity:12 },star_count:120,fork_count:20,primary_language:'Python',summary:'Useful image models.' },'daily','2026-10-19T00:00:00Z')!;

  test('Trending mapper preserves rank, features, score, language and canonical card fields', () => {
    assert.equal(repo.trend?.rank,2);assert.equal(repo.trend?.score,0.8);assert.equal(repo.trend?.features.trend_velocity,12);
    assert.equal(repo.stats.stars,120);assert.equal(repo.stats.forks,20);assert.equal(repo.primaryLanguage,'Python');
    assert.equal(repo.trend?.period,'daily');
    assert.equal(mapTrendingRepository({ repo_id:'x', full_name:'owner/repo', position:0 },'daily',null)?.trend?.rank,1);assert.equal(mapTrendingRepository({ repo_id:'x',full_name:'owner/repo',position:'bad' },'daily',null),null);
  });

  test('every search and Trending result routes internally to the correct Phase 2 entity', () => {
    const href = searchResultHref({type:'repository',id:repo.id,data:repo});
    assert.deepEqual(href,{pathname:'/repository/[repoId]',params:{repoId:'canonical-id'}});
    for (const [user_id,profile_id] of [['user-id',null],[null,'profile-id']]) {
      const person = searchResultHref({type:'person',id:'person',data:{user_id,profile_id,username:'medhansh',display_name:'Medhansh',bio:null,github_handle:null,avatar_url:null}});
      assert.equal(typeof person==='object' && person.pathname,'/user/[username]');
      assert.ok(typeof person==='object' && person.params && (user_id ? person.params.userId : person.params.profileId));
    }
    const collection = searchResultHref({type:'list',id:'list',data:mapCollectionList({collection_id:'c',name:'Vision'})});
    assert.deepEqual(collection,{pathname:'/board',params:{boardName:'Vision',boardDescription:'',collectionId:'c',collectionType:'collection'}});
    const board = searchResultHref({type:'list',id:'list',data:mapLegacyBoardList({board_id:'b',name:'Vision'})});
    assert.deepEqual(board,{pathname:'/board',params:{boardName:'Vision',boardDescription:'',boardId:'b'}});
    assert.deepEqual(SEARCH_GROUPS.map(v=>v.id),['all','repositories','people','lists']);
  });

  test('query cancellation aborts superseded debounce before transport starts', async () => {
    const controller = new AbortController(); let called=false;
    const pending = runSearchRequest(controller.signal,SEARCH_DEBOUNCE_MS,async()=>{called=true;return 'old';});
    controller.abort(); await assert.rejects(pending);assert.equal(called,false);
  });

  test('React Query key changes abort stale transport and cannot replace current results', async () => {
    const client = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
    let oldSignal: AbortSignal | undefined; let release: (value:string)=>void=()=>{};
    const observer = new InfiniteQueryObserver(client,{
      queryKey:['search','old'], initialPageParam:null, getNextPageParam:()=>undefined,
      queryFn:({signal})=>runSearchRequest(signal,0,async active=>{oldSignal=active;return new Promise<string>(resolve=>{release=resolve;});}),
    });
    const unsubscribe=observer.subscribe(()=>{});
    await new Promise(resolve=>setTimeout(resolve,10));
    observer.setOptions({queryKey:['search','new'],initialPageParam:null,getNextPageParam:()=>undefined,queryFn:({signal})=>runSearchRequest(signal,0,async()=> 'new')});
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(oldSignal?.aborted,true);release('old');
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.deepEqual(observer.getCurrentResult().data?.pages,['new']);
    unsubscribe();client.clear();
  });
});


function exploreTransport(send: (path: string, options: RequestInit, token: string) => Promise<unknown>) {
  const filename = resolve('src/api/explore.ts');
  const nativeRequire = createRequire(filename);
  const module = { exports: {} as { fetchExploreRepos: typeof fetchExploreRepos } };
  const javascript = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function('require', 'module', 'exports', javascript)((name: string) => {
    if (name === './client') return { apiV2: send };
    if (name === '../utils/storage') return { getStorageItem: async () => 'fixture-viewer-token' };
    return nativeRequire(name);
  }, module, module.exports);
  return module.exports.fetchExploreRepos;
}

test('Latest continues from the raw page when a malformed repository cannot render', async () => {
  const paths: string[] = [];
  const signal = new AbortController().signal;
  const fetchExplore = exploreTransport(async (path, options, token) => {
    paths.push(path);
    assert.equal(options.signal, signal);
    assert.equal(token, 'fixture-viewer-token');
    const offset = new URL(path, 'https://fixture.invalid').searchParams.get('offset');
    return { items: offset === '0'
      ? Array.from({ length: 24 }, (_, index) => index === 7 ? {} : {
        repo_id: `repo-${index}`, full_name: `fixture/repo-${index}`,
      })
      : [{ repo_id: 'repo-24', full_name: 'fixture/repo-24' }], limit: 24, offset: Number(offset) };
  });
  const first = await fetchExplore('Latest', '  private & query  ', 0, signal);
  assert.equal(first.items.length, 23);
  assert.deepEqual(first.items.slice(6, 9).map(repo => repo.id), ['repo-6', 'repo-8', 'repo-9']);
  assert.equal(first.nextOffset, 24, 'normalization cannot shorten the raw offset page');
  const second = await fetchExplore('Latest', '  private & query  ', first.nextOffset, signal);
  assert.deepEqual(second.items.map(repo => repo.id), ['repo-24']);
  assert.equal(second.nextOffset, undefined, 'a short raw page is exhausted');
  assert.deepEqual(paths, [
    '/repositories?limit=24&offset=0&q=private%20%26%20query',
    '/repositories?limit=24&offset=24&q=private%20%26%20query',
  ]);
});

test('Latest empty pages terminate and Trending keeps its ranked non-offset response', async () => {
  const paths: string[] = [];
  const fetchExplore = exploreTransport(async path => {
    paths.push(path);
    if (!path.startsWith('/repositories/trending')) return { items: [], limit: 24, offset: 24 };
    return { items: Array.from({ length: 24 }, (_, position) => ({
      repo_id: `trend-${position}`, full_name: `fixture/trend-${position}`, position,
    })), period: 'weekly', available_periods: ['daily', 'weekly'], captured_at: '2026-10-24T00:00:00Z' };
  });
  const empty = await fetchExplore('Latest', '', 24);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.nextOffset, undefined);
  const trending = await fetchExplore('Trending', '', 0, undefined, 'weekly');
  assert.equal(trending.items.length, 24);
  assert.deepEqual(trending.items.slice(0, 3).map(repo => repo.trend?.rank), [1, 2, 3]);
  assert.equal(trending.nextOffset, undefined);
  assert.equal(trending.period, 'weekly');
  assert.deepEqual(trending.availablePeriods, ['daily', 'weekly']);
  assert.deepEqual(paths, ['/repositories?limit=24&offset=24', '/repositories/trending?period=weekly']);
});

test('canceling an Explore request preserves the transport AbortError', async () => {
  const controller = new AbortController();
  const abort = new DOMException('Explore request canceled', 'AbortError');
  const fetchExplore = exploreTransport(async (_path, options) => new Promise((_resolve, reject) => {
    assert.equal(options.signal, controller.signal);
    options.signal!.addEventListener('abort', () => reject(abort), { once: true });
  }));
  const request = fetchExplore('Latest', '', 24, controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(request, error => error === abort);
});

test('idle browse warmup preserves populated stale infinite pages and fetches only the missing tab',async t=>{
  const {loadSource}=await import('./support/startup-harness');
  const {exploreBrowseQueryOptions}=loadSource('src/api/explore.ts',{
    '../utils/storage':{},'./client':{},'@/utils/repository-mapper':{},
  });
  const client=new QueryClient();
  const latest=exploreBrowseQueryOptions('alice','Latest');
  const key=latest.queryKey;
  const cached={pages:[{items:['one'],nextOffset:20},{items:['two'],nextOffset:40},{items:['three'],nextOffset:60}],pageParams:[0,20,40]};
  client.setQueryData(key,cached,{updatedAt:1});
  let effect:()=>void|(()=>void)=()=>{};
  const requests:string[]=[];
  const source=loadSource('src/hooks/use-browse-prefetch.ts',{
    react:{useCallback:(callback:unknown)=>callback},
    'react-native':{AppState:{currentState:'active',addEventListener:()=>({remove(){}})}},
    '@react-native-community/netinfo':{__esModule:true,default:{addEventListener:(callback:(state:unknown)=>void)=>{callback({isConnected:true});return()=>{};}}},
    'expo-router':{useFocusEffect:(callback:()=>void)=>{effect=callback;}},
    '@tanstack/react-query':{useQueryClient:()=>client},
    '../api/explore':{exploreBrowseQueryOptions:(viewer:string,tab:string)=>({...exploreBrowseQueryOptions(viewer,tab),queryFn:async({pageParam}:{pageParam:number})=>{requests.push(`${tab}:${pageParam}`);return {items:[],nextOffset:tab==='Latest'?pageParam+20:undefined};}})},
  });
  t.mock.timers.enable({apis:['setTimeout']});
  source.useBrowsePrefetch('alice',true);const cleanup=effect();
  try {
    for(let stage=0;stage<3;stage++){t.mock.timers.tick(1000);await new Promise(resolve=>setImmediate(resolve));}
    assert.deepEqual(requests,['Trending:0'],'Home must not refetch every stale page already loaded by Explore');
    assert.deepEqual(client.getQueryData(key),cached,'Warmup retains every loaded page and pagination offset');
  }finally{cleanup?.();client.clear();}
});
