import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import { validateKeysetPageResponse } from "../src/api/keyset-pagination";
import { mapCollectionList, mapLegacyBoardList, listMembershipKey, partitionListMembershipKeys, repositoryListsQueryKey } from "../src/models/list";
import { MAX_PINNED_DESCRIPTION_LENGTH, parsePinnedRepositories, serializePinnedRepositories, type PinnedRepository } from "../src/services/pinnedRepositoryCodec";

describe("lists", () => {
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

  for (const itemsKey of ['items', 'repositories'] as const) {
    test(`${itemsKey} pages accept continuing/final metadata and reject legacy or inconsistent responses`, () => {
      const items = [{ repo_id: 'repository-1' }];
      assert.doesNotThrow(() => validateKeysetPageResponse({ [itemsKey]: items, has_more: true, next_cursor: 'opaque-cursor' }, itemsKey));
      assert.doesNotThrow(() => validateKeysetPageResponse({ [itemsKey]: items, has_more: false, next_cursor: null }, itemsKey));
      assert.doesNotThrow(() => validateKeysetPageResponse({ [itemsKey]: [], has_more: false, next_cursor: null }, itemsKey));
      for (const response of [
        null, [], {}, { [itemsKey]: items },
        { [itemsKey]: items, next_cursor: null },
        { [itemsKey]: items, has_more: false },
        { [itemsKey]: items, has_more: 'false', next_cursor: null },
        { has_more: false, next_cursor: null },
        { [itemsKey]: {}, has_more: false, next_cursor: null },
        { [itemsKey]: items, has_more: true, next_cursor: null },
        { [itemsKey]: items, has_more: true, next_cursor: '' },
        { [itemsKey]: items, has_more: true, next_cursor: '  ' },
        { [itemsKey]: items, has_more: true, next_cursor: 1 },
        { [itemsKey]: items, has_more: true, next_cursor: 'x'.repeat(2049) },
        { [itemsKey]: items, has_more: false, next_cursor: 'unexpected' },
      ]) {
        assert.throws(() => validateKeysetPageResponse(response, itemsKey), /Unsupported or invalid pagination response/);
      }
    });
  }
});

describe("pinned repository codec", () => {
  const repository: PinnedRepository = {
    key: 'repo-id:openai/example',
    repositoryId: 'repo-id',
    name: 'example',
    owner: 'openai',
    description: 'A useful repository.',
    primaryLanguage: 'TypeScript',
    url: 'https://github.com/openai/example',
    pinnedAt: '2026-07-22T12:00:00.000Z',
  };

  test('pinned repository payloads round-trip with their storage version', () => {
    assert.deepEqual(
      parsePinnedRepositories(serializePinnedRepositories([repository])),
      [repository],
    );
  });

  test('pinned repository parsing fails safely and keeps only valid unique records', () => {
    assert.deepEqual(parsePinnedRepositories('{not-json'), []);
    assert.deepEqual(parsePinnedRepositories(JSON.stringify({ version: 2, repositories: [repository] })), []);

    const parsed = parsePinnedRepositories(JSON.stringify({
      version: 1,
      repositories: [
        { ...repository, description: 'x'.repeat(MAX_PINNED_DESCRIPTION_LENGTH + 20) },
        repository,
        { key: '', repositoryId: null },
      ],
    }));

    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].description.length, MAX_PINNED_DESCRIPTION_LENGTH);
  });
});
