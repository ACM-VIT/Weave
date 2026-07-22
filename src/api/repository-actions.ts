import { apiV2 } from './client';
import { sendBatchedActivity } from './activity';

export type RepositoryShareDetails = {
  id: string;
  name: string;
  fullName: string;
  githubUrl: string;
  description: string | null;
};

type RepositoryDetailsResponse = {
  repo_id: string;
  name: string;
  full_name: string;
  url: string;
  description: string | null;
};

export type SaveCollection = {
  collection_id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  repo_count: number;
  board_count: number;
  selected: boolean;
  created_at: string;
  updated_at: string;
  last_updated_at: string | null;
};

export type CreateCollectionInput = {
  name: string;
  icon?: string | null;
  color?: string | null;
};

export async function getRepositoryShareDetails(
  repositoryId: string,
  signal?: AbortSignal,
): Promise<RepositoryShareDetails> {
  const repository = await apiV2<RepositoryDetailsResponse>(
    `/repositories/${encodeURIComponent(repositoryId)}/share`,
    { signal },
  );
  if (!/^https:\/\/github\.com\//i.test(repository.url)) {
    throw new Error('This repository does not have a valid GitHub URL.');
  }
  return {
    id: repository.repo_id,
    name: repository.name,
    fullName: repository.full_name,
    githubUrl: repository.url,
    description: repository.description,
  };
}

export async function getSaveCollections(
  repositoryId: string,
  token: string,
  signal?: AbortSignal,
): Promise<SaveCollection[]> {
  const data = await apiV2<{ items: SaveCollection[] }>(
    `/collections?repository_id=${encodeURIComponent(repositoryId)}`,
    { signal },
    token,
  );
  return data.items;
}

export async function createSaveCollection(
  input: CreateCollectionInput,
  token: string,
): Promise<SaveCollection> {
  return apiV2<SaveCollection>('/collections', {
    method: 'POST',
    body: JSON.stringify(input),
  }, token);
}

export async function saveRepositoryToCollections(
  repositoryId: string,
  collectionIds: string[],
  token: string,
  attribution?: { serve_id?: string | null; position?: number | null },
) {
  const result = await apiV2<{
    repository_id: string;
    collection_ids: string[];
    saved: boolean;
    save_state_changed: boolean;
  }>('/collections/save', {
    method: 'POST',
    body: JSON.stringify({ repositoryId, collectionIds }),
  }, token);
  if (result.save_state_changed) {
    await sendBatchedActivity([{
      repo_id: repositoryId,
      action: result.saved ? 'save' : 'unsave',
      ...attribution,
    }], token).catch(() => undefined);
  }
  return result;
}
