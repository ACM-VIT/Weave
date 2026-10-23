import assert from 'node:assert/strict';
import test from 'node:test';
import { InfiniteQueryObserver, QueryClient, type InfiniteData } from '@tanstack/react-query';
import { FeedPaginationController, type FeedPage } from '../src/services/feedPagination';
import { HOME_FEED_HISTORY_LIMIT, retainHomeFeedHistory, retainedFeedScrollOffset, shareHomeFeedHistory } from '../src/services/feedHistory';
import { createFeedItemMapper } from '../src/utils/feed-items';

const row = (id: number, discovery = false) => ({ repo_id: String(id), full_name: `owner/repo-${id}`,
  readme_md: '# README\n' + 'synthetic content '.repeat(100),
  ...(discovery ? {} : { serve_id: `serve-${Math.floor(id / 10)}`, position: id }) });
const page = (start: number, length = 10, discovery = false): FeedPage => ({
  items: Array.from({ length }, (_, index) => row(start + index, discovery)),
  mode: discovery ? 'discovery' : 'personalized', sessionId: 'session', feedVersion: '1',
  nextCursor: String(start + length), requestCursor: start === 0 ? null : String(start),
});
const history = (pages: FeedPage[]): InfiniteData<FeedPage> => ({ pages, pageParams: pages.map(value => value.requestCursor) });
const count = (data: InfiniteData<FeedPage>) => data.pages.reduce((sum, value) => sum + value.items.length, 0);

test('ten thousand served cards keep both actual QueryClient history and controller IDs bounded at 500', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const key = ['feed', 'long-session'];
  const cursors: (string | null)[] = [];
  const committed = () => client.getQueryData<InfiniteData<FeedPage>>(key)?.pages ?? [];
  const controller = new FeedPaginationController(async cursor => { cursors.push(cursor); return page(Number(cursor ?? 0)); }, [], committed);
  const observer = new InfiniteQueryObserver(client, {
    queryKey: key, enabled: false, initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => controller.load(pageParam, signal),
    getNextPageParam: (last: FeedPage) => last.nextCursor ?? undefined,
    structuralSharing: (previous, next) => shareHomeFeedHistory(previous, next, []),
  });
  const stop = observer.subscribe(result => {
    if (result.data) assert.ok(count(result.data) <= HOME_FEED_HISTORY_LIMIT, 'no published query state may exceed the limit');
  });
  try {
    for (let index = 0; index < 1_000; index++) {
      const result = index ? await observer.fetchNextPage() : await observer.refetch();
      assert.equal(result.isError, false, String(result.error));
      const data = client.getQueryData<InfiniteData<FeedPage>>(key)!;
      controller.commitPages(data.pages);
      assert.equal(count(data), Math.min((index + 1) * 10, HOME_FEED_HISTORY_LIMIT));
      assert.ok((controller as any).seen.size <= HOME_FEED_HISTORY_LIMIT, 'evicted dedup IDs must leave the controller');
      assert.strictEqual((controller as any).committedPages, data.pages, 'controller must release superseded page arrays');
    }
    const before = client.getQueryData<InfiniteData<FeedPage>>(key)!;
    assert.equal(before.pages[0].items[0].repo_id, '9500');
    assert.equal(before.pageParams[0], '9500');
    assert.equal(before.pages.at(-1)!.nextCursor, '10000');
    const priorCalls = cursors.length;
    const refreshed = await observer.refetch();
    assert.equal(refreshed.isError, false, String(refreshed.error));
    assert.equal(cursors[priorCalls], '9500', 'refetch starts at the retained authoritative page parameter');
    assert.deepEqual(refreshed.data?.pages.flatMap(value => value.items.map(item => item.repo_id)),
      before.pages.flatMap(value => value.items.map(item => item.repo_id)), 'retained refetch must not discard all cards as duplicates');
  } finally { stop(); client.clear(); }
});

test('variable pages trim only old rows, preserving paired cursors, serve attribution and terminal emptiness', () => {
  const pages = [page(0, 7), ...Array.from({ length: 50 }, (_, index) => page(7 + index * 10))];
  const source = history(pages), retained = retainHomeFeedHistory(source);
  assert.equal(count(retained), 500);
  assert.equal(retained.pages[0].items[0].repo_id, '7');
  assert.equal(retained.pageParams[0], '7');
  assert.equal(source.pages[0].items.length, 7, 'retention never mutates a fetched page');
  const partialSource = history([page(0, 10), ...Array.from({ length: 50 }, (_, index) => page(10 + index * 10, index === 49 ? 3 : 10))]);
  const partial = retainHomeFeedHistory(partialSource);
  assert.equal(count(partial), 500);
  assert.deepEqual(partial.pages[0].items.map(item => [item.repo_id, item.position, item.serve_id]),
    partialSource.pages[0].items.slice(3).map(item => [item.repo_id, item.position, item.serve_id]));
  assert.equal(partial.pageParams[0], null, 'partial page keeps the cursor which obtained it');
  const terminal = { ...page(507, 0), nextCursor: null };
  const ended = retainHomeFeedHistory(history([...pages, terminal]));
  assert.equal(count(ended), 500);
  assert.strictEqual(ended.pages.at(-1), terminal);
  assert.equal(ended.pages.at(-1)!.nextCursor, null);
  const empty = retainHomeFeedHistory(history(Array.from({ length: 1_000 }, (_, index) => ({ ...page(index, 0), nextCursor: null }))));
  assert.equal(empty.pages.length, 1, 'empty intermediate pages must not grow unbounded metadata');
  assert.equal(empty.pageParams[0], '999');
});

test('late page completion pins a back-scrolled visible card without exceeding 500', () => {
  const source = history(Array.from({ length: 51 }, (_, index) => page(index * 10)));
  const retained = retainHomeFeedHistory(source, ['serve-0:0:0']);
  assert.equal(count(retained), 500);
  assert.equal(retained.pages[0].items[0].repo_id, '0');
  assert.equal(retained.pages[1].items[0].repo_id, '11');
  assert.equal(retained.pages.at(-1)!.nextCursor, '510');
});

for (const discovery of [false, true]) {
  test(`eviction preserves retained card identity and fractional scroll anchor (discovery=${discovery})`, () => {
    const source = history(Array.from({ length: 51 }, (_, index) => page(index * 10, 10, discovery)));
    const mapper = createFeedItemMapper();
    const before = mapper(source.pages.slice(0, 50));
    const anchor = before[480];
    const after = mapper(retainHomeFeedHistory(source, [anchor.feedId]).pages);
    assert.equal(after[470].feedId, anchor.feedId);
    assert.strictEqual(after[470].repository, anchor.repository, 'existing rows keep the same mapped repository');
    assert.equal(retainedFeedScrollOffset(before, after, 480 * 800 + 35, 800, [anchor.feedId]), 470 * 800 + 35);
    assert.equal(retainedFeedScrollOffset(after, after, 470 * 800, 800, [anchor.feedId]), undefined);
  });
}
