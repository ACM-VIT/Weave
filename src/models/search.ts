import type { Href } from 'expo-router';
import type { ListDto } from './list';
import type { RepositoryDetail } from './repository';
import { repositoryHref } from '../utils/repository-links';

export type SearchGroup = 'all' | 'repositories' | 'people' | 'lists';
export const SEARCH_GROUPS: { id: SearchGroup; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'repositories', label: 'Repositories' },
  { id: 'people', label: 'People' }, { id: 'lists', label: 'Lists' },
];
export type PersonSearchData = { user_id: string | null; profile_id: string | null; username: string; display_name: string | null; bio: string | null; github_handle: string | null; avatar_url: string | null };
export type SearchItem = { type: 'repository'; id: string; data: RepositoryDetail }
  | { type: 'person'; id: string; data: PersonSearchData }
  | { type: 'list'; id: string; data: ListDto };
export type SearchPage = { items: SearchItem[]; next_cursor: string | null; mode: 'hybrid' | 'lexical' };

export function searchResultHref(item: SearchItem): Href {
  if (item.type === 'repository') return repositoryHref(item.data.id);
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
