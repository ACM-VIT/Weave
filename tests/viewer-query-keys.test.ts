import assert from 'node:assert/strict';
import test from 'node:test';

import { repositoryListsQueryKey } from '../src/models/list';
import { repositoryDetailQueryKey } from '../src/models/repository';
import { feedQueryKey } from '../src/utils/feed-repository';

test('viewer-aware repository state cannot collide across account switches', () => {
  const repositoryId = '00000000-0000-4000-8000-000000000001';

  assert.notDeepEqual(
    repositoryDetailQueryKey(repositoryId, 'viewer-a'),
    repositoryDetailQueryKey(repositoryId, 'viewer-b'),
  );
  assert.notDeepEqual(
    repositoryListsQueryKey(repositoryId, 'viewer-a'),
    repositoryListsQueryKey(repositoryId, 'viewer-b'),
  );
  assert.notDeepEqual(feedQueryKey('viewer-a'), feedQueryKey('viewer-b'));

  assert.deepEqual(
    repositoryDetailQueryKey(repositoryId, 'viewer-a'),
    ['repository-detail', 'viewer-a', repositoryId],
  );
  assert.deepEqual(
    repositoryListsQueryKey(repositoryId, 'viewer-a'),
    ['repository-lists', 'viewer-a', repositoryId],
  );
  assert.deepEqual(feedQueryKey('viewer-a'), ['feed', 'viewer-a']);
});
