import assert from 'node:assert/strict';
import test from 'node:test';
import { loadHomeFeedPage, homeFeedItems, canContinueHomeFeed } from '../src/utils/home-feed';
import { mapFeedRepository, patchFeedReaction, getFeedItemIdentity } from '../src/utils/feed-repository';

const unavailable = Object.assign(new Error('Preparing recommendations'), { status:503,code:'PERSONALIZED_FEED_UNAVAILABLE' });
const repository = { repo_id:'10000000-0000-4000-8000-000000000001', full_name:'team/project', likes_count:7,
  viewer_reaction:null, description:'Source description', readme_md:'# Source README' };

test('Home browses canonical repositories after first-page ML unavailability and preserves real counters',async()=>{
  const calls:string[]=[];
  const page=await loadHomeFeedPage(null,{
    personalized:async()=>{calls.push('personalized');throw unavailable;},
    discovery:async(offset,limit)=>{calls.push(`catalogue:${offset}:${limit}`);return [{...repository,serve_id:'unexpected-attribution',position:99}];},
  });
  assert.deepEqual(calls,['personalized','catalogue:0:10']);
  assert.equal(page.mode,'discovery');assert.equal(page.nextCursor,null);
  const mapped=mapFeedRepository(page.items[0]);assert.ok(mapped);
  assert.equal(mapped.stats.likes,7);assert.equal(mapped.description,'Source description');
  assert.equal(mapped.serveId,null);assert.equal(mapped.feedPosition,null);
  assert.equal(canContinueHomeFeed(page.mode,1),true,'Product reactions do not invalidate catalogue pagination');
  assert.equal(canContinueHomeFeed('personalized',1),false,'Personalized cursors still respect feed-version invalidation');
});

test('discovery pagination stays in catalogue mode without repeatedly calling unavailable ML',async()=>{
  let personalizedCalls=0;
  const readers={personalized:async()=>{personalizedCalls++;throw unavailable;},discovery:async(offset:number,limit:number)=>{
    assert.equal(limit,10);return Array.from({length:10},(_,index)=>({...repository,repo_id:`repo-${offset+index}`}));
  }};
  const first=await loadHomeFeedPage(null,readers);
  const second=await loadHomeFeedPage(first.nextCursor,readers);
  assert.equal(first.nextCursor,'discovery:10');assert.equal(second.nextCursor,'discovery:20');
  assert.equal(personalizedCalls,1);assert.equal(second.items[0].repo_id,'repo-10');
  const overlap={...second,items:[first.items[9],...second.items]};
  assert.equal(homeFeedItems([first,overlap]).length,20);
});

test('authentication, offline, generic API failures and later personalized-page errors do not trigger discovery',async()=>{
  for(const [cursor,error] of [[null,{status:401}],[null,{status:403}],[null,new TypeError('Offline')],
    [null,{status:503,code:'OTHER_FAILURE'}],['personalized-cursor',unavailable]] as const){
    let calls=0;
    await assert.rejects(loadHomeFeedPage(cursor,{personalized:async()=>{throw error;},discovery:async()=>{calls++;return [];}}));
    assert.equal(calls,0);
  }
  await assert.rejects(loadHomeFeedPage('discovery:invalid',{personalized:async()=>{throw new Error();},discovery:async()=>[]}),/expired/);
});

test('available personalized feed stays intact; deliberate first-page refresh can recover from browsing',async()=>{
  const expected={items:[{...repository,serve_id:'real-serve',position:2}],nextCursor:'real-cursor'};
  let browseCalls=0;
  const page=await loadHomeFeedPage(null,{personalized:async()=>expected,discovery:async()=>{browseCalls++;return [];}});
  assert.equal(page.mode,'personalized');assert.equal(page.items,expected.items);assert.equal(page.nextCursor,'real-cursor');
  assert.equal(browseCalls,0);
});

test('catalogue reaction patches preserve item identity, counts and source mode',async()=>{
  const page=await loadHomeFeedPage(null,{personalized:async()=>{throw unavailable;},discovery:async()=>[repository]});
  const before=mapFeedRepository(page.items[0]);assert.ok(before);
  const patched=patchFeedReaction({pages:[page],pageParams:[null]},{repoId:repository.repo_id},'like');assert.ok(patched);
  const after=mapFeedRepository(patched.pages[0].items[0]);assert.ok(after);
  assert.equal(after.stats.likes,8);assert.equal(after.viewerReaction,'like');
  assert.equal(getFeedItemIdentity(before,0),getFeedItemIdentity(after,0));assert.equal(patched.pages[0].mode,'discovery');
});

test('direct follow invalidation blocks old personalized cursors without dropping loaded cards',async()=>{
  const {QueryClient}=await import('@tanstack/react-query');
  const {subscribeToHomeFeedInvalidations}=await import('../src/utils/home-feed');
  const client=new QueryClient();const key=['feed','viewer'] as const;
  const loaded={pages:[{mode:'personalized',items:[repository],nextCursor:'old-version'}],pageParams:[null]};
  client.setQueryData(key,loaded);let invalidations=0;
  const stop=subscribeToHomeFeedInvalidations(client,key,()=>invalidations++);
  await client.invalidateQueries({queryKey:['feed','other'],refetchType:'none'});
  assert.equal(invalidations,0);
  await client.invalidateQueries({queryKey:key,exact:true,refetchType:'none'});
  assert.equal(invalidations,1);assert.equal(canContinueHomeFeed('personalized',invalidations),false);
  assert.equal(client.getQueryData(key),loaded,'Cards stay mounted with their original query data');
  assert.equal(canContinueHomeFeed('discovery',invalidations),true);
  stop();client.clear();
});
