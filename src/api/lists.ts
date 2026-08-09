import { apiV2 } from '@/api/client';
import type { InteractionEventV2 } from '@/api/activity';
import {
  listMembershipKey,
  mapCollectionList,
  mapLegacyBoardList,
  partitionListMembershipKeys,
  type CollectionListRecord,
  type LegacyBoardListRecord,
  type ListDto,
} from '@/models/list';

export {
  mapCollectionList,
  mapLegacyBoardList,
  listMembershipKey,
  parseListMembershipKey,
  partitionListMembershipKeys,
  repositoryListsQueryKey,
} from '@/models/list';
export type {
  CollectionListRecord,
  LegacyBoardListRecord,
  ListDto,
  ListSource,
} from '@/models/list';

export type CreateListInput = {
  name: string;
  icon?: string | null;
  color?: string | null;
};

export type ListMembershipSyncResult = {
  repositoryId: string;
  selectedListIds: string[];
  saved: boolean;
  saveStateChanged: boolean;
};

export async function getRepositoryLists(
  repositoryId: string,
  token: string,
  signal?: AbortSignal,
): Promise<ListDto[]> {
  const query = `repository_id=${encodeURIComponent(repositoryId)}`;
  const [collections, boards] = await Promise.all([
    apiV2<{ items: CollectionListRecord[] }>(`/collections?${query}`, { signal }, token),
    apiV2<{ items: LegacyBoardListRecord[] }>(`/boards?${query}`, { signal }, token),
  ]);
  return [
    ...collections.items.map(mapCollectionList),
    ...boards.items.map(mapLegacyBoardList),
  ];
}

export async function createRepositoryList(
  input: CreateListInput,
  token: string,
): Promise<ListDto> {
  const record = await apiV2<CollectionListRecord>('/collections', {
    method: 'POST',
    body: JSON.stringify(input),
  }, token);
  return mapCollectionList(record);
}

export async function syncRepositoryLists(
  repositoryId: string,
  selectedListIds: string[],
  token: string,
  event: InteractionEventV2,
): Promise<ListMembershipSyncResult> {
  const { collectionIds, boardIds } = partitionListMembershipKeys(selectedListIds);
  const result = await apiV2<{
    repository_id: string;
    collection_ids: string[];
    board_ids: string[];
    selected_list_ids?: string[];
    saved: boolean;
    save_state_changed: boolean;
  }>('/collections/save', {
    method: 'POST',
    body: JSON.stringify({ repositoryId, collectionIds, boardIds, event }),
  }, token);

  return {
    repositoryId: result.repository_id,
    selectedListIds: result.selected_list_ids ?? [
      ...result.collection_ids.map((id) => listMembershipKey({ source: 'collection', id })),
      ...result.board_ids.map((id) => listMembershipKey({ source: 'legacy-board', id })),
    ],
    saved: result.saved,
    saveStateChanged: result.save_state_changed,
  };
}
