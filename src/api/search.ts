import { apiV2 } from './client';
import { getStorageItem } from '../utils/storage';
import { mapExploreRepository, type RepositoryProjection } from './explore-data';
import type { SearchGroup, SearchItem, SearchPage } from '../models/search';

type SearchResponse = Omit<SearchPage, 'items'> & {
  items: (Exclude<SearchItem, { type: 'repository' }> | { type: 'repository'; id: string; data: RepositoryProjection })[];
};

export async function fetchSearch(query: string, group: SearchGroup, searchId: string, cursor: string | null, signal: AbortSignal): Promise<SearchPage> {
  const token = await getStorageItem('access_token');
  signal.throwIfAborted();
  if (!token) throw new Error('Sign in to search.');
  const response = await apiV2<SearchResponse>('/search', {
    signal, method: 'POST', body: JSON.stringify({ schema_version: 2, search_id: searchId, query, group, limit: 24, cursor }),
  }, token);
  const items = response.items.map((item): SearchItem => item.type === 'repository'
    ? { ...item, data: mapExploreRepository(item.data) } : item);
  return { ...response, items };
}
