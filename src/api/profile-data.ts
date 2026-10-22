import {
  mapCollectionList,
  mapLegacyBoardList,
  type CollectionListRecord,
  type LegacyBoardListRecord,
  type ListDto,
} from '@/models/list';
import type { RepositoryDetail } from '../models/repository';

export const PROFILE_REPOSITORY_PAGE_SIZE = 40;
// The existing offset API rejects offsets above this value; cursor support is #122.
const MAX_PROFILE_REPOSITORY_OFFSET = 10_000;

export type ProfileRepositoryPage = {
  items: RepositoryDetail[];
  nextOffset?: number;
};

export function nextProfileRepositoryOffset(offset: number, count: number): number | undefined {
  const next = offset + count;
  return count === PROFILE_REPOSITORY_PAGE_SIZE && next <= MAX_PROFILE_REPOSITORY_OFFSET ? next : undefined;
}

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
