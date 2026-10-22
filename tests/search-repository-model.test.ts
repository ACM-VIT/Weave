import assert from 'node:assert/strict';
import test from 'node:test';
import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { runSearchRequest, SEARCH_DEBOUNCE_MS } from '../src/api/search-query';
import { searchResultHref, SEARCH_GROUPS } from '../src/models/search';
import { mapTrendingRepository } from '../src/api/explore-data';
import { mapCollectionList, mapLegacyBoardList } from '../src/models/list';

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
