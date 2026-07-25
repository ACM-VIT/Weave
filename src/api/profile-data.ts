export type ProfileBoard = {
  board_id: string;
  name: string;
  repo_count: number;
};

export type ProfileCollection = {
  collection_id: string;
  name: string;
  board_count: number;
  repo_count: number;
  description?: string | null;
};

export type ProfileRepository = {
  repo_id: string;
  name: string;
  full_name: string;
  star_count: number;
};

export type ProfileContentSection = 'boards' | 'collections' | 'repositories';

export type ProfileContent = {
  boards: ProfileBoard[];
  collections: ProfileCollection[];
  repositories: ProfileRepository[];
  errors: Partial<Record<ProfileContentSection, string>>;
};

export type ProfileContentRequests = {
  boards: Promise<{ items: ProfileBoard[] }>;
  collections: Promise<{ items: ProfileCollection[] }>;
  repositories: Promise<{ items: ProfileRepository[] }>;
};

function failureMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'Unable to load this section.';
}

export async function settleProfileContent(requests: ProfileContentRequests): Promise<ProfileContent> {
  const [boards, collections, repositories] = await Promise.allSettled([
    requests.boards,
    requests.collections,
    requests.repositories,
  ] as const);
  const errors: ProfileContent['errors'] = {};

  if (boards.status === 'rejected') errors.boards = failureMessage(boards.reason);
  if (collections.status === 'rejected') errors.collections = failureMessage(collections.reason);
  if (repositories.status === 'rejected') errors.repositories = failureMessage(repositories.reason);

  return {
    boards: boards.status === 'fulfilled' ? boards.value.items : [],
    collections: collections.status === 'fulfilled' ? collections.value.items : [],
    repositories: repositories.status === 'fulfilled' ? repositories.value.items : [],
    errors,
  };
}
