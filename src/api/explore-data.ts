import { mapRepositoryDetail } from '@/utils/repository-mapper';
import type { RepositoryApiPayload } from '@/api/repositories';
import type { RepositoryDetail } from '@/models/repository';
import type { TabName } from '../types';

export type ExploreRepoPage = {
  items: RepositoryDetail[];
  nextOffset?: number;
  availablePeriods?: string[];
  period?: string;
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

export function mapTrendingRepository(payload: RepositoryApiPayload & { position?: unknown; score?: unknown; features?: unknown }, period: string, capturedAt: string | null): RepositoryDetail | null {
  const repo = mapRepositoryDetail(payload);
  if (!repo) return null;
  const rank = Number(payload.position);
  if (!Number.isInteger(rank) || rank < 0) return null;
  return { ...repo, trend: {
    rank: rank + 1, score: typeof payload.score === 'number' && Number.isFinite(payload.score) ? payload.score : null,
    features: payload.features && typeof payload.features === 'object' && !Array.isArray(payload.features) ? payload.features as Record<string, unknown> : {},
    period, capturedAt,
  } };
}
