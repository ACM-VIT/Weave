import assert from 'node:assert/strict';
import test from 'node:test';
import { loadHomeFeedPage, homeFeedItems, canContinueHomeFeed } from '../src/utils/home-feed';
import { mapFeedRepository, patchFeedReaction, getFeedItemIdentity } from '../src/utils/feed-repository';

const unavailable = Object.assign(new Error('Preparing recommendations'), { status:503,code:'PERSONALIZED_FEED_UNAVAILABLE' });
const repository = { repo_id:'10000000-0000-4000-8000-000000000001', full_name:'team/project', likes_count:7,
  viewer_reaction:null, description:'Source description', readme_md:'# Source README' };

test('Home propagates an unavailable personalized feed instead of showing recently imported repositories',async()=>{
  let catalogueCalls=0;
  await assert.rejects(loadHomeFeedPage(null,{
    personalized:async()=>{throw unavailable;},
    discovery:async()=>{catalogueCalls++;return [repository];},
  }),error=>error===unavailable);
  assert.equal(catalogueCalls,0);
});

test('old catalogue cursors expire rather than continuing a nonpersonalized Home feed',async()=>{
  let calls=0;
  await assert.rejects(loadHomeFeedPage('discovery:10',{
    personalized:async()=>{calls++;throw unavailable;},discovery:async()=>{calls++;return [];},
  }),error=>(error as {code?:string}).code==='FEED_CURSOR_STALE');
  assert.equal(calls,0);
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
  const page={mode:'discovery' as const,feedVersion:'0',items:[repository],nextCursor:null};
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


test('a slow first generation retries the same request and keeps personalized attribution',async()=>{
  const { requestFeedWithRetry }=await import('../src/services/feedTransport');
  const request={feed_request_id:'request',session_id:'session',limit:10,cursor:null};
  const sent:unknown[]=[];let catalogueCalls=0;
  const expected={items:[{...repository,serve_id:'durable-serve',position:0}],nextCursor:null,feedVersion:'1'};
  const page=await loadHomeFeedPage(null,{
    personalized:()=>requestFeedWithRetry(request,async body=>{
      sent.push(body);if(sent.length===1)throw unavailable;return expected;
    },undefined,async()=>undefined,true),
    discovery:async()=>{catalogueCalls++;return [repository];},
  });
  assert.equal(sent.length,2);assert.equal(sent[0],sent[1]);
  assert.equal(page.mode,'personalized');assert.equal(page.items[0].serve_id,'durable-serve');
  assert.equal(catalogueCalls,0);
});
