import { apiV2 } from '@/api/client';
import type { InteractionEventV2 } from '@/api/activity';
import { keysetPageQuery, validateKeysetPageResponse, type KeysetPage, type KeysetPageOptions } from './keyset-pagination';
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

export type ListPageOptions = KeysetPageOptions & {
  /** Decorates each list's selection state; it does not filter the list results. */
  repositoryId?: string;
};

function listPageQuery(options: ListPageOptions): string {
  const query = keysetPageQuery(options);
  return options.repositoryId === undefined
    ? query
    : `${query}&repository_id=${encodeURIComponent(options.repositoryId)}`;
}

/** A display page only. Do not use a partial page as a complete membership selection. */
export async function getCollectionsPage(
  token: string,
  options: ListPageOptions = {},
  signal?: AbortSignal,
): Promise<KeysetPage<ListDto>> {
  const data = await apiV2<KeysetPage<CollectionListRecord>>(
    `/collections?${listPageQuery(options)}`,
    { signal },
    token,
  );
  validateKeysetPageResponse(data);
  return { ...data, items: data.items.map(mapCollectionList) };
}

/** A display page only. Membership mutations still require getRepositoryLists. */
export async function getBoardsPage(
  token: string,
  options: ListPageOptions = {},
  signal?: AbortSignal,
): Promise<KeysetPage<ListDto>> {
  const data = await apiV2<KeysetPage<LegacyBoardListRecord>>(
    `/boards?${listPageQuery(options)}`,
    { signal },
    token,
  );
  validateKeysetPageResponse(data);
  return { ...data, items: data.items.map(mapLegacyBoardList) };
}

export async function getRepositoryLists(
  repositoryId: string,
  token: string,
  signal?: AbortSignal,
): Promise<ListDto[]> {
  const query = `repository_id=${encodeURIComponent(repositoryId)}`;
  const collections = await apiV2<{ items: CollectionListRecord[] }>(`/collections?${query}`, { signal }, token);
  return collections.items.map(mapCollectionList);
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
  if (boardIds.length) throw new Error('Refresh your Lists before saving.');
  const result = await apiV2<{
    repository_id: string;
    collection_ids: string[];
    board_ids: string[];
    selected_list_ids?: string[];
    saved: boolean;
    save_state_changed: boolean;
  }>('/collections/save', {
    method: 'POST',
    body: JSON.stringify({ repositoryId, collectionIds, event }),
  }, token);

  return {
    repositoryId: result.repository_id,
    selectedListIds: result.collection_ids.map((id) => listMembershipKey({ source: 'collection', id })),
    saved: result.saved,
    saveStateChanged: result.save_state_changed,
  };
}
