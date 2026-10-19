import type { Href } from 'expo-router';
import type { ExploreRepository } from '../api/explore-data';

export type SearchGroup = 'all' | 'repositories' | 'people' | 'lists';
export const SEARCH_GROUPS: { id: SearchGroup; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'repositories', label: 'Repositories' },
  { id: 'people', label: 'People' }, { id: 'lists', label: 'Lists' },
];
export type PersonSearchData = {
  user_id: string | null; profile_id: string | null; username: string;
  display_name: string | null; bio: string | null;
};
export type ListSearchData = {
  id: string; name: string; description: string | null;
  repositoryCount: number; source: 'collection' | 'legacy-board';
};
export type SearchItem = { type: 'repository'; id: string; data: ExploreRepository }
  | { type: 'person'; id: string; data: PersonSearchData }
  | { type: 'list'; id: string; data: ListSearchData };
export type SearchPage = { items: SearchItem[]; next_cursor: string | null; mode: 'hybrid' | 'lexical' };

export function searchResultHref(item: SearchItem): Href {
  if (item.type === 'repository') return { pathname: '/repository/[repoId]', params: { repoId: item.data.id } } as Href;
  if (item.type === 'person') return { pathname: '/user/[username]', params: {
    username: item.data.username,
    ...(item.data.user_id ? { userId: item.data.user_id } : { profileId: item.data.profile_id! }),
  } };
  return { pathname: '/board', params: {
    boardName: item.data.name, boardDescription: item.data.description ?? '',
    ...(item.data.source === 'collection'
      ? { collectionId: item.data.id, collectionType: 'collection' }
      : { boardId: item.data.id }),
  } };
}
