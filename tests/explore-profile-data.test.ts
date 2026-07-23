import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXPLORE_PAGE_SIZE,
  getNextExploreOffset,
  mergeExplorePages,
} from '../src/api/explore-data';
import { settleProfileContent } from '../src/api/profile-data';
import type { Repo } from '../src/types';

function repo(id: string, name = id): Repo {
  return {
    id,
    name,
    stars: '0',
    forks: '0',
    author: 'weave',
    avatarColor: '#000000',
    avatarInitial: 'W',
  };
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
    repositories: Promise.resolve({ items: [{ repo_id: 'repo', name: 'api', full_name: 'weave/api', star_count: 8 }] }),
  });

  assert.equal(content.boards.length, 1);
  assert.deepEqual(content.collections, []);
  assert.equal(content.repositories.length, 1);
  assert.deepEqual(content.errors, { collections: 'collections unavailable' });
});
