import assert from 'node:assert/strict';
import test from 'node:test';

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
