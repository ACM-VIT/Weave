import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { retainOriginalFeedImpressions, rememberOriginalFeedImpression, rememberFeedNavigation, takeFeedNavigation, type FeedAttribution } from "../src/services/feedImpressionAttribution";
import { markFeedFirstVisible, measureFeedLoad, snapshotFeedTiming } from "../src/services/feedTiming";
import { FeedPaginationController, type FeedPage } from "../src/services/feedPagination";
import { loadHomeFeedPage } from "../src/utils/home-feed";

describe("feed impression attribution", () => {
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
});

describe("feed timing", () => {
  const traceparent = '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01';

  const page = (): FeedPage => ({ items: [{ repo_id: 'private-repository' }], nextCursor: null,
    feedVersion: '1', mode: 'personalized', serverTraceparent: traceparent });

  const family = (stage: string, mode = 'personalized', outcome = 'success') =>
    JSON.stringify({ stage, mode, outcome });

  const count = (stage: string, mode?: string, outcome?: string) =>
    snapshotFeedTiming().histograms[family(stage, mode, outcome)]?.count ?? 0;

  test('ready and first-visible have distinct clocks through actual pagination and only count once', async () => {
    let clock = 100;
    const before = count('first_visible');
    const pagination = new FeedPaginationController(async () => measureFeedLoad(async () => {
      clock = 160; return page();
    }, true, () => clock));
    const loaded = await pagination.load(null);
    assert.equal(count('first_visible'), before);
    assert.equal(loaded.serverTraceparent, undefined);
    markFeedFirstVisible(loaded.timing, () => 200);
    markFeedFirstVisible(loaded.timing, () => 500);
    assert.equal(count('first_visible'), before + 1);
    const spans = snapshotFeedTiming().spans.slice(-3);
    assert.deepEqual(spans.map(span => [span.stage, span.duration_ms]),
      [['feed_ready', 60], ['first_visible', 100], ['ready_to_visible', 40]]);
    assert.ok(spans.every(span => span.traceparent === traceparent));
    assert.ok(!JSON.stringify(snapshotFeedTiming()).includes('private-repository'));
  });

  test('unavailable recommendations record failure; cancellation is separate from success', async () => {
    let clock = 0;
    const before = count('feed_ready', 'unknown', 'failure');
    const unavailable = { status: 503, code: 'PERSONALIZED_FEED_UNAVAILABLE' };
    await assert.rejects(measureFeedLoad(() => loadHomeFeedPage(null, {
      personalized: async () => { clock = 40; throw unavailable; },
    }), true, () => clock), error => error === unavailable);
    assert.equal(count('feed_ready', 'unknown', 'failure'), before + 1);
    const failed = count('feed_ready', 'unknown', 'cancelled');
    const error = Object.assign(new Error('cancelled private token'), { name: 'AbortError' });
    await assert.rejects(measureFeedLoad(async () => { throw error; }, true), error);
    assert.equal(count('feed_ready', 'unknown', 'cancelled'), failed + 1);
    assert.ok(!JSON.stringify(snapshotFeedTiming()).includes(error.message));
  });

  test('sampling, ring capacity and finite histogram bounds hold across repeated loads', async () => {
    const before = count('first_visible');
    for (const header of ['00-' + '0'.repeat(32) + '-1234567890abcdef-01',
      traceparent.replace(/01$/, '00'), 'private query', undefined]) {
      const loaded = await measureFeedLoad(async () => ({ ...page(), serverTraceparent: header }), false);
      assert.equal(loaded.timing?.sampledTraceparent, undefined);
      markFeedFirstVisible(loaded.timing);
    }
    assert.equal(count('first_visible'), before);
    for (let i = 0; i < 140; i++) await measureFeedLoad(async () => page(), false);
    const snapshot = snapshotFeedTiming();
    assert.equal(snapshot.spans.length, 128);
    assert.ok(Object.keys(snapshot.histograms).length <= 45);
    for (const histogram of Object.values(snapshot.histograms)) {
      assert.equal(histogram.buckets.at(-1), histogram.count);
      assert.ok(histogram.buckets.every((value, i) => i === 0 || value >= histogram.buckets[i - 1]));
    }
    snapshot.spans[0].duration_ms = -999;
    assert.notEqual(snapshotFeedTiming().spans[0].duration_ms, -999);
  });

  for (const recovery of ['feed-change', 'stale-cursor'] as const) {
    test(`later-page ${recovery} recovery never becomes first-visible timing`, async () => {
      const loaded: FeedPage[] = [{ ...page(), nextCursor: 'later', sessionId: 'cached-session' }];
      const calls: Array<{ cursor: string | null; initialPage: boolean }> = [];
      let stale = recovery === 'stale-cursor';
      const pagination = new FeedPaginationController(async (cursor, _signal, _id, _session, initialPage) => {
        calls.push({ cursor, initialPage });
        if (stale) {
          stale = false;
          throw Object.assign(new Error('stale'), { status: 400, code: 'FEED_CURSOR_STALE' });
        }
        return measureFeedLoad(async () => ({ ...page(), feedVersion: '2',
          items: [{ repo_id: 'new-repository' }] }), initialPage);
      }, loaded, () => loaded);
      if (recovery === 'feed-change') pagination.markStale('2');
      const beforeVisible = count('first_visible');
      const beforeReadyGap = count('ready_to_visible');
      const recovered = await pagination.load('later');
      assert.equal(calls.at(-1)?.cursor, null);
      assert.ok(calls.every(call => call.initialPage === false));
      assert.equal(recovered.timing?.initialPage, false);
      markFeedFirstVisible(recovered.timing);
      assert.equal(count('first_visible'), beforeVisible);
      assert.equal(count('ready_to_visible'), beforeReadyGap);
    });
  }
});
