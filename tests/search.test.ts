import assert from 'node:assert/strict';
import test from 'node:test';
import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { isSearchExpired, runSearchRequest, searchQueryOptions } from '../src/api/search-query';
import { mapExploreRepository, mapTrendingRepository } from '../src/api/explore-data';
import { searchResultHref, SEARCH_GROUPS, type SearchPage } from '../src/models/search';

const projection = {
  repo_id: 'canonical-id', name: 'vision', owner: 'owner', full_name: 'owner/vision',
  url: 'https://github.com/owner/vision', description: 'Useful image models.',
  primary_language: 'Python', star_count: 120, fork_count: 20,
};
const page = (cursor: string | null = null): SearchPage => ({
  items: [{ type: 'repository', id: projection.repo_id, data: mapExploreRepository(projection) }],
  next_cursor: cursor, mode: 'hybrid',
});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('Trending preserves backend ranking and rejects absent or malformed positions', () => {
  const repo = mapTrendingRepository({ ...projection, position: 1, score: 0.8, features: { trend_velocity: 12 } })!;
  assert.equal(repo.trend?.rank, 2);
  assert.equal(repo.trend?.score, 0.8);
  assert.equal(repo.trend?.velocity, 12);
  assert.equal(repo.stars, '120');
  assert.equal(repo.forks, '20');
  assert.equal(repo.language, 'Python');
  assert.equal(mapTrendingRepository(projection), null);
  assert.equal(mapTrendingRepository({ ...projection, position: 'bad' }), null);
  assert.equal(mapTrendingRepository({ ...projection, position: null }), null);
});

test('all result types route to existing internal entity routes', () => {
  assert.deepEqual(searchResultHref(page().items[0]), {
    pathname: '/repository/[repoId]', params: { repoId: 'canonical-id' },
  });
  for (const [user_id, profile_id] of [['user-id', null], [null, 'profile-id']]) {
    assert.deepEqual(searchResultHref({ type: 'person', id: 'person', data: {
      user_id, profile_id, username: 'dev', display_name: null, bio: null,
    } }), { pathname: '/user/[username]', params: {
      username: 'dev', ...(user_id ? { userId: user_id } : { profileId: profile_id }),
    } });
  }
  for (const source of ['collection', 'legacy-board'] as const) {
    assert.deepEqual(searchResultHref({ type: 'list', id: 'list', data: {
      id: 'list', name: 'Vision', description: null, repositoryCount: 2, source,
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
