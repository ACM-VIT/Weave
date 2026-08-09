import type { RepositoryDetail } from '@/models/repository';
import type { TabName } from '../types';

export type ExploreRepoPage = {
  items: RepositoryDetail[];
  nextOffset?: number;
};

export const EXPLORE_PAGE_SIZE = 24;
const MAX_EXPLORE_OFFSET = 10_000;

export function getNextExploreOffset(tab: TabName, offset: number, itemCount: number): number | undefined {
  const nextOffset = offset + itemCount;
  return tab === 'Latest'
    && itemCount === EXPLORE_PAGE_SIZE
    && nextOffset <= MAX_EXPLORE_OFFSET
    ? nextOffset
    : undefined;
}

export function mergeExplorePages(pages: ExploreRepoPage[]): RepositoryDetail[] {
  const repos = new Map<string, RepositoryDetail>();
  pages.forEach((page) => page.items.forEach((repo) => repos.set(repo.id, repo)));
  return [...repos.values()];
}
