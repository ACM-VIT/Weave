import assert from 'node:assert/strict';
import test from 'node:test';
import {InfiniteQueryObserver, QueryClient} from '@tanstack/react-query';
import {retainOriginalFeedImpressions,rememberOriginalFeedImpression,rememberFeedNavigation,takeFeedNavigation,type FeedAttribution}from '../src/services/feedImpressionAttribution';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const target:FeedAttribution={ownerId:id(1),repoId:id(2),serveId:id(3),sessionId:id(4),position:0};
const first={eventId:id(5),occurredAt:'2026-10-24T00:00:01.000Z'},later={eventId:id(6),occurredAt:'2026-10-24T00:00:03.000Z'};
const item=(fields:Record<string,unknown>={})=>({repo_id:target.repoId,serve_id:target.serveId,feed_session_id:target.sessionId,position:0,...fields});
test('first actual qualified UUID survives remapping, append, reactions and repeated visibility',()=>{
 const client=new QueryClient();try{
  client.setQueryData(['feed',target.ownerId],{pages:[{items:[item(),item({position:1})]}],pageParams:[null]});
  assert.deepEqual(rememberOriginalFeedImpression(client,target,first),first);
  const current=client.getQueryData<any>(['feed',target.ownerId]);
  client.setQueryData(['feed',target.ownerId],{...current,pages:[{...current.pages[0],items:current.pages[0].items.map((row:any)=>({...row,viewer_reaction:'like'}))},{items:[item({serve_id:id(7)})]}]});
  assert.deepEqual(rememberOriginalFeedImpression(client,target,later),first);
  const rows=client.getQueryData<any>(['feed',target.ownerId]).pages.flatMap((page:any)=>page.items);
  assert.equal(rows[0].client_original_impression.eventId,first.eventId);assert.equal(rows[1].client_original_impression,undefined);assert.equal(rows[2].client_original_impression,undefined);
  assert.deepEqual(rememberOriginalFeedImpression(client,{...target,ownerId:id(8)},later),later);
  assert.equal(client.getQueryData(['feed',id(8)]),undefined,'an absent owner cache is not created from another account');
 }finally{client.clear();}
});
test('navigation carries only an opaque one-use owner/repository/generation-bound token',()=>{
 const client=new QueryClient();try{
  const context={...target,generation:1,original:first};const token=rememberFeedNavigation(client,context);
  assert.notEqual(token,first.eventId);assert.equal(takeFeedNavigation(client,id(8),target.repoId,token,1),null);
  assert.equal(takeFeedNavigation(client,target.ownerId,id(9),token,1),null);
  const good=rememberFeedNavigation(client,context);assert.deepEqual(takeFeedNavigation(client,target.ownerId,target.repoId,good,1),context);assert.equal(takeFeedNavigation(client,target.ownerId,target.repoId,good,1),null);
  const old=rememberFeedNavigation(client,context);assert.equal(takeFeedNavigation(client,target.ownerId,target.repoId,old,2),null);
 }finally{client.clear();}
});

test('an in-flight next page preserves the first impression across row remount and later actions', async () => {
 const client = new QueryClient(); let finish!: () => void, started!: () => void;
 const pending = new Promise<void>(resolve => { finish = resolve; });
 const entered = new Promise<void>(resolve => { started = resolve; });
 const key = ['feed', target.ownerId] as const;
 client.setQueryData(key, { pages: [{ items: [item()], nextCursor: 'next' }], pageParams: [null] });
 const observer = new InfiniteQueryObserver(client, {
  queryKey: key, structuralSharing: retainOriginalFeedImpressions, enabled: false, initialPageParam: null as string | null,
  queryFn: async () => { started(); await pending; return { items: [item({ serve_id: id(7) })], nextCursor: null as string | null }; },
  getNextPageParam: page => page.nextCursor ?? undefined,
 });
 const unsubscribe = observer.subscribe(() => undefined);
 try {
  const append = observer.fetchNextPage(); await entered;
  assert.deepEqual(rememberOriginalFeedImpression(client, target, first), first);
  finish(); await append;
  const remounted = client.getQueryData<any>(key).pages[0].items[0];
  assert.deepEqual(remounted.client_original_impression, first);
  assert.deepEqual(rememberOriginalFeedImpression(client, target, later), first, 'later actions retain the original UUID');
 } finally { finish(); unsubscribe(); observer.destroy(); client.clear(); }
});

test('async metadata merge preserves incoming membership, overlays and row attribution boundaries', () => {
 const before={pages:[{items:[item({client_original_impression:first})]}],pageParams:[null]};
 const after={pages:[{items:[item({viewer_reaction:'like'}),item({serve_id:id(9)}),item({feed_session_id:id(8)}),item({position:1})]}],pageParams:[null]};
 const merged=retainOriginalFeedImpressions(before,after) as typeof after & typeof before;
 assert.deepEqual(merged.pages[0].items[0].client_original_impression,first);
 assert.equal(merged.pages[0].items[0].viewer_reaction,'like');
 for(const row of merged.pages[0].items.slice(1))assert.equal(row.client_original_impression,undefined);
 assert.equal(retainOriginalFeedImpressions(before,before),before,'unchanged caches preserve reference equality');
 assert.deepEqual(retainOriginalFeedImpressions(before,{pages:[],pageParams:[]}),{pages:[],pageParams:[]},'discarded pages are not resurrected');
});
