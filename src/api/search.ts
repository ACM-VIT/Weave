import { apiV2 } from './client';
import { getStorageItem } from '../utils/storage';
import { mapRepositoryDetail } from '../utils/repository-mapper';
import type { RepositoryApiPayload } from './repositories';
import type { SearchGroup, SearchItem, SearchPage } from '../models/search';

export async function fetchSearch(query: string, group: SearchGroup, searchId: string, cursor: string | null, signal: AbortSignal): Promise<SearchPage> {
  const token = await getStorageItem('access_token');
  signal.throwIfAborted();
  if (!token) throw new Error('Sign in to search.');
  const response = await apiV2<SearchPage>('/search', { signal, method: 'POST', body: JSON.stringify({
    schema_version: 2, search_id: searchId, query, group, limit: 24, cursor,
  }) }, token);
  const items = response.items.flatMap((item): SearchItem[] => {
    if (item.type !== 'repository') return [item];
    const repository = mapRepositoryDetail(item.data as unknown as RepositoryApiPayload);
    return repository ? [{ ...item, data: repository }] : [];
  });
  return { ...response, items };
}
