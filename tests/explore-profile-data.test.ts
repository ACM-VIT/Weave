import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { profileSectionQueries } from '../src/api/profile-section-queries';
import { mapLegacyBoardList } from '../src/models/list';

import {
  EXPLORE_PAGE_SIZE,
  getNextExploreOffset,
  mergeExplorePages,
} from '../src/api/explore-data';
import { settleProfileContent } from '../src/api/profile-data';
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

test('profile sections become ready independently and retain viewer-scoped normalized List caches', async t => {
  const started = performance.now();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let failCollections!: (error: Error) => void;
  const heldCollections = new Promise<[]>( (_resolve, reject) => { failCollections = reject; });
  const loaders = {
    boards: async () => [mapLegacyBoardList({ board_id: 'board', name: 'Ready now', repo_count: 2 })],
    collections: () => heldCollections,
  };
  let legacyReady = false;
  const legacy = settleProfileContent({
    boards: Promise.resolve({ items: [{ board_id: 'board', name: 'Ready now', repo_count: 2 }] }),
    collections: heldCollections.then(items => ({ items })),
  }).then(() => { legacyReady = true; });
  const options = profileSectionQueries('alice', loaders);
  const boards = new QueryObserver(client, options.boards);
  const collections = new QueryObserver(client, options.collections);
  const unsubscribe = [boards.subscribe(() => {}), collections.subscribe(() => {})];
  try {
    await boards.refetch();
    assert.equal(boards.getCurrentResult().data?.[0].name, 'Ready now');
    assert.equal(collections.getCurrentResult().isPending, true, 'a slow collection cannot block boards');
    assert.equal(legacyReady, false, 'the previous aggregate still waits for the delayed section');
    t.diagnostic(`First section ready in ${(performance.now()-started).toFixed(1)} ms while the collection response was still held; local query-observer fixture.`);
    assert.equal(boards.getCurrentResult().data?.[0].source, 'legacy-board');
    assert.equal(boards.getCurrentResult().data?.[0].repositoryCount, 2);
    const collectionResult = collections.refetch();
    failCollections(new Error('collections unavailable'));
    await collectionResult;
    await legacy;
    assert.equal(collections.getCurrentResult().isError, true);
    assert.equal(boards.getCurrentResult().isSuccess, true);

    const bob = profileSectionQueries('bob', loaders);
    assert.equal(client.getQueryData(bob.boards.queryKey), undefined);
    const signedOut = profileSectionQueries(undefined, loaders);
    assert.equal(signedOut.boards.enabled, false);
    assert.equal(signedOut.collections.enabled, false);
    await client.invalidateQueries({ queryKey: ['profile-content', 'alice'], refetchType: 'none' });
    assert.equal(client.getQueryState(options.boards.queryKey)?.isInvalidated, true);
    assert.equal(client.getQueryState(options.collections.queryKey)?.isInvalidated, true);
  } finally { unsubscribe.forEach(stop => stop()); client.clear(); }
});
