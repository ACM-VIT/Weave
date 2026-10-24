import assert from 'node:assert/strict';
import test from 'node:test';
import { markFeedFirstVisible, measureFeedLoad, snapshotFeedTiming } from '../src/services/feedTiming';
import { FeedPaginationController, type FeedPage } from '../src/services/feedPagination';
import { loadHomeFeedPage } from '../src/utils/home-feed';

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
