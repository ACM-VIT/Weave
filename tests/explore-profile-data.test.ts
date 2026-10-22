import assert from 'node:assert/strict';
import test from 'node:test';
import { InfiniteQueryObserver, QueryClient, QueryObserver } from '@tanstack/react-query';

import {
  EXPLORE_PAGE_SIZE,
  getNextExploreOffset,
  mergeExplorePages,
} from '../src/api/explore-data';
import { mergeProfileRepositoryPages, nextProfileRepositoryOffset, PROFILE_REPOSITORY_PAGE_SIZE, settleProfileContent } from '../src/api/profile-data';
import { profileRepositoryQuery, profileSectionQueries } from '../src/api/profile-section-queries';
import { mapLegacyBoardList } from '../src/models/list';
import type { RepositoryDetail } from '../src/models/repository';
import { mapRepositoryDetail } from '../src/utils/repository-mapper';

function repo(id: string, name = id): RepositoryDetail {
  const repository = mapRepositoryDetail({
    repo_id: id,
    full_name: `weave/${name}`,
  });
  assert.ok(repository);
  return repository;
}

test('Latest pagination advances only after a complete API page', () => {
  assert.equal(getNextExploreOffset('Latest', 0, EXPLORE_PAGE_SIZE), EXPLORE_PAGE_SIZE);
  assert.equal(getNextExploreOffset('Latest', 24, EXPLORE_PAGE_SIZE - 1), undefined);
  assert.equal(getNextExploreOffset('Trending', 0, EXPLORE_PAGE_SIZE), undefined);
  assert.equal(getNextExploreOffset('Latest', 9_984, EXPLORE_PAGE_SIZE), undefined);
});

test('Explore pages retain order and de-duplicate repositories across offsets', () => {
  const merged = mergeExplorePages([
    { items: [repo('one'), repo('two', 'older')] },
    { items: [repo('two', 'newer'), repo('three')] },
  ]);

  assert.deepEqual(merged.map((item) => item.id), ['one', 'two', 'three']);
  assert.equal(merged[1].name, 'newer');
});

test('Profile content preserves successful sections when one endpoint fails', async () => {
  const content = await settleProfileContent({
    boards: Promise.resolve({ items: [{ board_id: 'board', name: 'Backend', repo_count: 2 }] }),
    collections: Promise.reject(new Error('collections unavailable')),
  });

  assert.equal(content.lists.length, 1);
  assert.equal(content.lists[0].id, 'board');
  assert.equal(content.lists[0].source, 'legacy-board');
  assert.deepEqual(content.errors, { collections: 'collections unavailable' });
});

test('Profile exposes Boards and Collections through one product List DTO', async () => {
  const content = await settleProfileContent({
    boards: Promise.resolve({ items: [{ board_id: 'board', name: 'Legacy', repo_count: 1 }] }),
    collections: Promise.resolve({ items: [{
      collection_id: 'list',
      name: 'Read later',
      repo_count: 2,
      board_count: 0,
      selected: false,
    }] }),
  });

  assert.deepEqual(
    content.lists.map(({ id, source, repositoryCount }) => ({ id, source, repositoryCount })),
    [
      { id: 'board', source: 'legacy-board', repositoryCount: 1 },
      { id: 'list', source: 'collection', repositoryCount: 2 },
    ],
  );
});

test('profile Lists become ready independently and repository sheets fetch only when visible', async t => {
  const started = performance.now();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let failCollections!: (error: Error) => void;
  const heldCollections = new Promise<[]>((_resolve, reject) => { failCollections = reject; });
  let repositoryRequests = 0;
  const board = { board_id: 'board', name: 'Ready now', description: null, repo_count: 2 };
  const loaders = { boards: async () => [mapLegacyBoardList(board)], collections: () => heldCollections };
  const loadRepositories = async () => { repositoryRequests++; return { items: [] }; };
  let legacyReady = false;
  const legacy = settleProfileContent({
    boards: Promise.resolve({ items: [board] }),
    collections: heldCollections.then(items => ({ items })),
  }).then(() => { legacyReady = true; });
  const options = profileSectionQueries('alice', loaders);
  const boards = new QueryObserver(client, options.boards);
  const collections = new QueryObserver(client, options.collections);
  const savedOptions = profileRepositoryQuery('alice', 'saved', false, loadRepositories);
  const repositories = new InfiniteQueryObserver(client, savedOptions);
  const unsubscribe = [boards.subscribe(() => {}), collections.subscribe(() => {}), repositories.subscribe(() => {})];
  try {
    await boards.refetch();
    assert.equal(boards.getCurrentResult().data?.[0].name, 'Ready now');
    assert.equal(collections.getCurrentResult().isPending, true, 'a slow collection cannot block legacy Lists');
    assert.equal(legacyReady, false, 'the previous aggregate still waits for the delayed section');
    t.diagnostic(`First section ready in ${(performance.now()-started).toFixed(1)} ms while the collection response was still held; local query-observer fixture.`);
    assert.equal(repositoryRequests, 0, 'hidden repository sheet must not fetch');
    const collectionResult = collections.refetch();
    failCollections(new Error('collections unavailable'));
    await collectionResult;
    await legacy;
    assert.equal(collections.getCurrentResult().isError, true);
    assert.equal(boards.getCurrentResult().isSuccess, true);
    repositories.setOptions(profileRepositoryQuery('alice', 'saved', true, loadRepositories));
    await repositories.refetch();
    assert.equal(repositoryRequests, 1);
    assert.equal(boards.getCurrentResult().data?.length, 1, 'opening the saved sheet preserves ready Lists');
    const bob = profileSectionQueries('bob', loaders);
    assert.equal(client.getQueryData(bob.boards.queryKey), undefined);
    assert.equal(client.getQueryData(profileRepositoryQuery('bob', 'saved', true, loadRepositories).queryKey), undefined);
    const signedOut = profileSectionQueries(undefined, loaders);
    assert.equal(signedOut.boards.enabled, false);
    assert.equal(signedOut.collections.enabled, false);
    assert.equal(profileRepositoryQuery(undefined, 'saved', true, loadRepositories).enabled, false);
    await client.invalidateQueries({ queryKey: ['profile-content', 'alice'], refetchType: 'none' });
    assert.equal(client.getQueryState(options.boards.queryKey)?.isInvalidated, true);
    assert.equal(client.getQueryState(options.collections.queryKey)?.isInvalidated, true);
  } finally { unsubscribe.forEach(stop => stop()); client.clear(); }
});

test('profile repository pages pass 100 items, preserve rows on page failure, retry and stop on a short page', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const items = Array.from({ length: 137 }, (_, index) => repo(`repo-${index}`));
  const offsets: number[] = [];
  let failNext = false;
  const options = profileRepositoryQuery('alice', 'saved', true, async offset => {
    offsets.push(offset);
    if (failNext) { failNext = false; throw new Error('page failed'); }
    const page = items.slice(offset, offset+PROFILE_REPOSITORY_PAGE_SIZE);
    return { items: page, nextOffset: nextProfileRepositoryOffset(offset, page.length) };
  });
  const observer = new InfiniteQueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  try {
    await observer.refetch();
    failNext = true;
    await observer.fetchNextPage();
    assert.equal(observer.getCurrentResult().isFetchNextPageError, true);
    assert.equal(observer.getCurrentResult().data?.pages[0].items.length, 40);
    await observer.fetchNextPage();
    while (observer.getCurrentResult().hasNextPage) await observer.fetchNextPage();
    assert.deepEqual(offsets, [0, 40, 40, 80, 120]);
    const pages = observer.getCurrentResult().data!.pages;
    assert.equal(mergeProfileRepositoryPages(pages).length, 137);
    assert.equal(mergeProfileRepositoryPages([...pages, pages[0]]).length, 137, 'overlapping offset pages cannot duplicate rows');
    assert.equal(nextProfileRepositoryOffset(10_000, PROFILE_REPOSITORY_PAGE_SIZE), undefined, 'respect the current server paging boundary');
  } finally { unsubscribe(); client.clear(); }
});
