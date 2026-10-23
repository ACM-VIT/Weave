import {
  mapCollectionList,
  mapLegacyBoardList,
  type CollectionListRecord,
  type LegacyBoardListRecord,
  type ListDto,
} from '@/models/list';
import type { RepositoryDetail } from '../models/repository';

export const PROFILE_REPOSITORY_PAGE_SIZE = 40;
export type ProfileRepositoryPage = {
  items: RepositoryDetail[];
  nextCursor?: string;
};

export function mergeProfileRepositoryPages(pages: ProfileRepositoryPage[]): RepositoryDetail[] {
  const byId = new Map<string, RepositoryDetail>();
  for (const page of pages) for (const item of page.items) byId.set(item.id, item);
  return [...byId.values()];
}

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
