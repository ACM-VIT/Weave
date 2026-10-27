import type { TabName } from '../types';
import { getStorageItem } from '../utils/storage';
import type { RepositoryApiPayload } from './repositories';
import { mapRepositoryList } from '@/utils/repository-mapper';
import { apiV2 } from './client';
import { EXPLORE_PAGE_SIZE, getNextExploreOffset, mapTrendingRepository } from './explore-data';
import type { ExploreRepoPage } from './explore-data';

export { EXPLORE_PAGE_SIZE, mergeExplorePages } from './explore-data';
export type { ExploreRepoPage } from './explore-data';

export async function fetchExploreRepos(
  tab: TabName,
  searchQuery: string,
  offset = 0,
  signal?: AbortSignal,
  period?: string,
): Promise<ExploreRepoPage> {
  const token = await getStorageItem('access_token');
  if (!token) throw new Error('Your session has expired. Please log in again.');
  const query = searchQuery.trim();
  const path = tab === 'Trending'
    ? `/repositories/trending${period ? `?period=${encodeURIComponent(period)}` : ''}`
    : `/repositories?limit=${EXPLORE_PAGE_SIZE}&offset=${offset}${query ? `&q=${encodeURIComponent(query)}` : ''}`;
  const data = await apiV2<{ items: RepositoryApiPayload[]; period?: string; available_periods?: string[]; captured_at?: string }>(path, { signal }, token);
  const items = tab === 'Trending' ? data.items.map(item => mapTrendingRepository(item, data.period ?? 'daily', data.captured_at ?? null)).filter((item): item is NonNullable<typeof item> => item !== null) : mapRepositoryList(data.items);

  const nextOffset = getNextExploreOffset(tab, offset, items.length);

  return { items, nextOffset, availablePeriods: data.available_periods, period: data.period };
}

/** Shared by the selected screen and bounded idle prefetching. */
export function exploreBrowseQueryOptions(viewer: string | undefined, tab: TabName, period?: string) {
  return {
    queryKey: ['exploreRepos', viewer, tab, period] as const,
    queryFn: ({pageParam, signal}: {pageParam: number; signal: AbortSignal}) => fetchExploreRepos(tab, '', pageParam, signal, period),
    initialPageParam: 0,
    getNextPageParam: (page: ExploreRepoPage) => page.nextOffset,
    staleTime: 60_000,
  };
}
