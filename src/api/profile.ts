import { apiV2 } from './client';

export type ProfileBoard = {
  board_id: string;
  name: string;
  description: string | null;
  repo_count: number;
};

export type ProfileCollection = {
  collection_id: string;
  name: string;
  board_count: number;
};

export type ProfileRepository = {
  repo_id: string;
  name: string;
  full_name: string;
  star_count: number;
};

export type ProfileContent = {
  boards: ProfileBoard[];
  collections: ProfileCollection[];
  repositories: ProfileRepository[];
};

export async function getProfileContent(token: string): Promise<ProfileContent> {
  const [boards, collections, repositories] = await Promise.all([
    apiV2<{ items: ProfileBoard[] }>('/boards', {}, token),
    apiV2<{ items: ProfileCollection[] }>('/collections', {}, token),
    apiV2<{ items: ProfileRepository[] }>('/repositories/saved?limit=100&offset=0', {}, token),
  ]);

  return {
    boards: boards.items,
    collections: collections.items,
    repositories: repositories.items,
  };
}
