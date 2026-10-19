import type { Repo, TabName } from '../types';

export type ExploreRepoPage = {
  items: ExploreRepository[];
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

export function mergeExplorePages(pages: ExploreRepoPage[]): ExploreRepository[] {
  const repos = new Map<string, ExploreRepository>();
  pages.forEach((page) => page.items.forEach((repo) => repos.set(repo.id, repo)));
  return [...repos.values()];
}

export type ExploreRepository = Repo & {
  trend?: { rank: number; score: number | null; velocity: number | null };
};

export type RepositoryProjection = {
  repo_id: string; name: string; full_name: string; owner: string; url: string;
  description: string | null; primary_language: string | null;
  star_count?: number | null; fork_count?: number | null;
  position?: unknown; score?: unknown; features?: unknown;
};

function compactCount(value = 0): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return value.toString();
}

export function mapExploreRepository(repo: RepositoryProjection): ExploreRepository {
  const gradients = [
    ['#64D2FF', '#2A7FBF'], ['#FFB340', '#E08700'], ['#BF5AF2', '#8944AB'],
    ['#63E6A9', '#2E9E6B'], ['#FF6482', '#C93A56'],
  ] as const;
  const seed = [...repo.owner].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  const avatarGradient = gradients[seed % gradients.length];
  return {
    id: repo.repo_id, name: repo.name, author: repo.owner, url: repo.url,
    description: repo.description ?? 'No description provided.',
    stars: compactCount(repo.star_count ?? 0), forks: compactCount(repo.fork_count ?? 0),
    language: repo.primary_language ?? undefined, avatarInitial: repo.owner.slice(0, 2).toUpperCase(),
    avatarColor: avatarGradient[0], avatarGradient,
  };
}

export function mapTrendingRepository(repo: RepositoryProjection): ExploreRepository | null {
  if (typeof repo.position !== 'number' || !Number.isInteger(repo.position) || repo.position < 0) return null;
  const features = repo.features && typeof repo.features === 'object' ? repo.features as Record<string, unknown> : {};
  return { ...mapExploreRepository(repo), trend: {
    rank: repo.position + 1,
    score: typeof repo.score === 'number' && Number.isFinite(repo.score) ? repo.score : null,
    velocity: typeof features.trend_velocity === 'number' && Number.isFinite(features.trend_velocity) ? features.trend_velocity : null,
  } };
}
