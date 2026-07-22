import { apiV2 } from './client';
import { settleProfileContent } from './profile-data';
import type {
  ProfileBoard,
  ProfileCollection,
  ProfileContent,
  ProfileRepository,
} from './profile-data';

export type { ProfileBoard, ProfileCollection, ProfileContent, ProfileRepository } from './profile-data';
export { settleProfileContent } from './profile-data';

export async function getProfileContent(token: string, signal?: AbortSignal): Promise<ProfileContent> {
  const content = await settleProfileContent({
    boards: apiV2<{ items: ProfileBoard[] }>('/boards', { signal }, token),
    collections: apiV2<{ items: ProfileCollection[] }>('/collections', { signal }, token),
    repositories: apiV2<{ items: ProfileRepository[] }>('/repositories/saved?limit=100&offset=0', { signal }, token),
  });

  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Profile request was cancelled.');
  }

  return content;
}
