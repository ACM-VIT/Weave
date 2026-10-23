import type { RepositoryApiPayload } from './repositories';
import { requestKeysetItems } from './keyset-pagination';
import { PROFILE_REPOSITORY_PAGE_SIZE, type ProfileRepositoryPage } from './profile-data';
import { mapRepositoryList } from '../utils/repository-mapper';

export async function requestProfileRepositoryPage(
  type: 'likes' | 'saved',
  userId: string,
  cursor: string | null,
  send: (path: string) => Promise<unknown>,
): Promise<ProfileRepositoryPage> {
  const path = type === 'likes' ? `/users/${encodeURIComponent(userId)}/likes-given` : '/repositories/saved';
  const page = await requestKeysetItems<RepositoryApiPayload>(path,
    { limit: PROFILE_REPOSITORY_PAGE_SIZE, cursor: cursor ?? undefined }, send);
  return { items: mapRepositoryList(page.items), nextCursor: page.next_cursor ?? undefined };
}
