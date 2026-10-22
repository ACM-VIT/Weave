export type ListSource = 'collection' | 'legacy-board';

/** One product-facing List shape over the two existing backend stores. */
export type ListDto = {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  repositoryCount: number;
  nestedListCount: number;
  selected: boolean;
  source: ListSource;
  createdAt: string | null;
  updatedAt: string | null;
  lastUpdatedAt: string | null;
};

export type CollectionListRecord = {
  collection_id: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  repo_count?: number | null;
  board_count?: number | null;
  selected?: boolean;
  created_at?: string | null;
  updated_at?: string | null;
  last_updated_at?: string | null;
};

export type LegacyBoardListRecord = {
  board_id: string;
  name: string;
  description?: string | null;
  repo_count?: number | null;
  selected?: boolean;
  created_at?: string | null;
};

function count(value: number | null | undefined): number {
  return Math.max(0, Number(value) || 0);
}

export function mapCollectionList(record: CollectionListRecord): ListDto {
  return {
    id: record.collection_id,
    name: record.name,
    description: record.description ?? null,
    icon: record.icon ?? null,
    color: record.color ?? null,
    repositoryCount: count(record.repo_count),
    nestedListCount: count(record.board_count),
    selected: record.selected === true,
    source: 'collection',
    createdAt: record.created_at ?? null,
    updatedAt: record.updated_at ?? null,
    lastUpdatedAt: record.last_updated_at ?? null,
  };
}

export function mapLegacyBoardList(record: LegacyBoardListRecord): ListDto {
  return {
    id: record.board_id,
    name: record.name,
    description: record.description ?? null,
    icon: null,
    color: null,
    repositoryCount: count(record.repo_count),
    nestedListCount: 0,
    selected: record.selected === true,
    source: 'legacy-board',
    createdAt: record.created_at ?? null,
    updatedAt: null,
    lastUpdatedAt: null,
  };
}

export function listMembershipKey(list: Pick<ListDto, 'id' | 'source'>): string {
  return `${list.source}:${list.id}`;
}

export function parseListMembershipKey(
  value: string,
): Pick<ListDto, 'id' | 'source'> | null {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return null;
  const source = value.slice(0, separator);
  if (source !== 'collection' && source !== 'legacy-board') return null;
  return { source, id: value.slice(separator + 1) };
}

export function partitionListMembershipKeys(values: string[]): {
  collectionIds: string[];
  boardIds: string[];
} {
  const collectionIds: string[] = [];
  const boardIds: string[] = [];
  for (const value of values) {
    const membership = parseListMembershipKey(value);
    if (!membership) throw new Error('One or more List selections are invalid.');
    if (membership.source === 'collection') collectionIds.push(membership.id);
    else boardIds.push(membership.id);
  }
  return {
    collectionIds: [...new Set(collectionIds)],
    boardIds: [...new Set(boardIds)],
  };
}

export function repositoryListsQueryKey(
  repositoryId: string | undefined,
  viewerUserId: string | null | undefined,
) {
  return ['repository-lists', viewerUserId ?? null, repositoryId ?? null] as const;
}
