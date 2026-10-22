import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mapCollectionList,
  mapLegacyBoardList,
  listMembershipKey,
  partitionListMembershipKeys,
  repositoryListsQueryKey,
} from '../src/models/list';

test('collection membership records map to the product List DTO', () => {
  const list = mapCollectionList({
    collection_id: 'list-1',
    name: 'Read later',
    description: 'Repositories to revisit',
    repo_count: 3,
    board_count: 1,
    selected: true,
    created_at: '2026-08-09T00:00:00.000Z',
  });

  assert.deepEqual(list, {
    id: 'list-1',
    name: 'Read later',
    description: 'Repositories to revisit',
    icon: null,
    color: null,
    repositoryCount: 3,
    nestedListCount: 1,
    selected: true,
    source: 'collection',
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: null,
    lastUpdatedAt: null,
  });
});

test('legacy Boards use the same source-tagged product List DTO', () => {
  const list = mapLegacyBoardList({
    board_id: 'board-1',
    name: 'Legacy board',
    repo_count: 4,
  });

  assert.equal(list.id, 'board-1');
  assert.equal(list.source, 'legacy-board');
  assert.equal(list.selected, false);
  assert.equal(list.repositoryCount, 4);
});

test('mixed Collection and legacy Board memberships retain their backing store', () => {
  const collection = mapCollectionList({
    collection_id: 'collection-1',
    name: 'Collection List',
    selected: true,
  });
  const board = mapLegacyBoardList({
    board_id: 'board-1',
    name: 'Board List',
    selected: true,
  });

  assert.equal(listMembershipKey(collection), 'collection:collection-1');
  assert.equal(listMembershipKey(board), 'legacy-board:board-1');
  assert.deepEqual(partitionListMembershipKeys([
    listMembershipKey(collection),
    listMembershipKey(board),
    listMembershipKey(collection),
  ]), {
    collectionIds: ['collection-1'],
    boardIds: ['board-1'],
  });
});

test('repository List query identity is centralized by viewer and repository', () => {
  assert.deepEqual(
    repositoryListsQueryKey('repo-1', 'viewer-1'),
    ['repository-lists', 'viewer-1', 'repo-1'],
  );
});
