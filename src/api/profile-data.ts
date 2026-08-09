import {
  mapCollectionList,
  mapLegacyBoardList,
  type CollectionListRecord,
  type LegacyBoardListRecord,
  type ListDto,
} from '@/models/list';

export type ProfileContentSection = 'boards' | 'collections';

export type ProfileContent = {
  lists: ListDto[];
  errors: Partial<Record<ProfileContentSection, string>>;
};

export type ProfileContentRequests = {
  boards: Promise<{ items: LegacyBoardListRecord[] }>;
  collections: Promise<{ items: CollectionListRecord[] }>;
};

function failureMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'Unable to load this section.';
}

export async function settleProfileContent(
  requests: ProfileContentRequests,
): Promise<ProfileContent> {
  const [boards, collections] = await Promise.allSettled([
    requests.boards,
    requests.collections,
  ] as const);
  const errors: ProfileContent['errors'] = {};

  if (boards.status === 'rejected') errors.boards = failureMessage(boards.reason);
  if (collections.status === 'rejected') errors.collections = failureMessage(collections.reason);

  return {
    lists: [
      ...(boards.status === 'fulfilled'
        ? boards.value.items.map(mapLegacyBoardList)
        : []),
      ...(collections.status === 'fulfilled'
        ? collections.value.items.map(mapCollectionList)
        : []),
    ],
    errors,
  };
}
