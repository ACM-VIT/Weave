import type { TabName } from '../types';
import { getStorageItem } from '../utils/storage';
import type { RepositoryApiPayload } from './repositories';
import { mapRepositoryList } from '@/utils/repository-mapper';
import { apiV2 } from './client';
import { EXPLORE_PAGE_SIZE, getNextExploreOffset } from './explore-data';
import type { ExploreRepoPage } from './explore-data';

export { EXPLORE_PAGE_SIZE, mergeExplorePages } from './explore-data';
export type { ExploreRepoPage } from './explore-data';

export async function fetchExploreRepos(
  tab: TabName,
  searchQuery: string,
  offset = 0,
  signal?: AbortSignal,
): Promise<ExploreRepoPage> {
  const token = await getStorageItem('access_token');
  if (!token) throw new Error('Your session has expired. Please log in again.');
  const query = searchQuery.trim();
  const path = tab === 'Trending'
    ? '/repositories/trending?period=daily'
    : `/repositories?limit=${EXPLORE_PAGE_SIZE}&offset=${offset}${query ? `&q=${encodeURIComponent(query)}` : ''}`;
  const data = await apiV2<{ items: RepositoryApiPayload[] }>(path, { signal }, token);
  const items = mapRepositoryList(data.items);

  const nextOffset = getNextExploreOffset(tab, offset, items.length);

  return { items, nextOffset };
}
