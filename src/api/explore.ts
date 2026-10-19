import type { TabName } from '../types';
import { getStorageItem } from '../utils/storage';
import { apiV2 } from './client';
import { EXPLORE_PAGE_SIZE, getNextExploreOffset, mapExploreRepository, mapTrendingRepository } from './explore-data';
import type { ExploreRepoPage, RepositoryProjection } from './explore-data';

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
  const data = await apiV2<{ items: RepositoryProjection[]; period?: string; available_periods?: string[] }>(path, { signal }, token);

  const items = tab === 'Trending'
    ? data.items.flatMap(repo => { const mapped = mapTrendingRepository(repo); return mapped ? [mapped] : []; })
    : data.items.map(mapExploreRepository);

  const nextOffset = getNextExploreOffset(tab, offset, items.length);

  return { items, nextOffset, period: data.period, availablePeriods: data.available_periods };
}
