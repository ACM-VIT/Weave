import { apiV2 } from './client';
import { mapCollectionList, mapLegacyBoardList } from '../models/list';
import type {
  CollectionListRecord,
  LegacyBoardListRecord,
} from './lists';
import {
  settleProfileContent,
  type ProfileContent,
} from './profile-data';

export type { ProfileContent } from './profile-data';
export { settleProfileContent } from './profile-data';

export async function getProfileBoards(token: string, signal?: AbortSignal) {
  const { items } = await apiV2<{ items: LegacyBoardListRecord[] }>('/boards', { signal }, token);
  return items.map(mapLegacyBoardList);
}

export async function getProfileCollections(token: string, signal?: AbortSignal) {
  const { items } = await apiV2<{ items: CollectionListRecord[] }>('/collections', { signal }, token);
  return items.map(mapCollectionList);
}

export type PublicUserProfile = {
  user_id: string;
  username: string;
  full_name: string | null;
  bio: string | null;
  github_handle: string | null;
  avatar_url: string | null;
  followers_count: number;
  following_count: number;
  likes_given_count?: number;
  is_self: boolean;
  viewer_follows_user: boolean;
  topics: string[];
};

export async function getProfileContent(
  token: string,
  signal?: AbortSignal,
): Promise<ProfileContent> {
  const content = await settleProfileContent({
    boards: apiV2<{ items: LegacyBoardListRecord[] }>('/boards', { signal }, token),
    collections: apiV2<{ items: CollectionListRecord[] }>('/collections', { signal }, token),
  });

  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('Profile request was cancelled.');
  }

  return content;
}

export function getPublicUserProfile(
  userId: string,
  token: string,
  signal?: AbortSignal,
): Promise<PublicUserProfile> {
  return apiV2<PublicUserProfile>(
    `/users/${encodeURIComponent(userId)}`,
    { signal },
    token,
  );
}
