import { apiV2, apiV2Raw } from './client';
import type { RepositoryApiPayload } from './repositories';
import { keysetPageQuery, validateKeysetPageResponse, type KeysetPage, type KeysetPageOptions } from './keyset-pagination';
import type { RepositoryDetail } from '@/models/repository';
import { mapRepositoryList } from '@/utils/repository-mapper';
import {
  prepareQueuedActivity,
  toInteractionEventV2,
  type ActivityInput,
  type QueuedActivity,
} from './activity';

export type BoardRecord = {
  board_id: string;
  name: string;
  description: string | null;
  repo_count: number;
  [key: string]: unknown;
};

export type FrontendBoard = BoardRecord & {
  board_name: string;
  repos_count: number;
};

export type BoardRepositoryRecord = RepositoryApiPayload & {
  added_at: string;
  repo_id: string;
  full_name: string;
  owner: string;
  name: string;
  url: string;
  description: string | null;
  primary_language: string | null;
};

export async function getUserBoards(_userId: string, token: string, _limit = 20, _offset = 0) {
  const data = await apiV2<{ items: BoardRecord[] }>('/boards', {}, token);
  return data.items.map((board) => ({
    ...board,
    board_name: board.name,
    repos_count: board.repo_count,
  }));
}

export async function getBoardRepositories(
  boardId: string,
  token: string,
  signal?: AbortSignal,
): Promise<RepositoryDetail[]> {
  const data = await apiV2<{ items: BoardRepositoryRecord[] }>(
    `/boards/${encodeURIComponent(boardId)}/repositories`,
    { signal },
    token,
  );
  return mapRepositoryList(data.items);
}

export async function getCollectionRepositories(
  collectionId: string,
  token: string,
  signal?: AbortSignal,
): Promise<RepositoryDetail[]> {
  const data = await apiV2<{ items: BoardRepositoryRecord[] }>(
    `/collections/${encodeURIComponent(collectionId)}/repositories`,
    { signal },
    token,
  );
  return mapRepositoryList(data.items);
}

export async function getBoardRepositoriesPage(
  boardId: string,
  token: string,
  options: KeysetPageOptions = {},
  signal?: AbortSignal,
): Promise<KeysetPage<RepositoryDetail>> {
  const data = await apiV2<KeysetPage<BoardRepositoryRecord>>(
    `/boards/${encodeURIComponent(boardId)}/repositories?${keysetPageQuery(options)}`,
    { signal },
    token,
  );
  // Keep the server cursor even if mapping drops an invalid repository record.
  validateKeysetPageResponse(data);
  return { ...data, items: mapRepositoryList(data.items) };
}

export async function getCollectionRepositoriesPage(
  collectionId: string,
  token: string,
  options: KeysetPageOptions = {},
  signal?: AbortSignal,
): Promise<KeysetPage<RepositoryDetail>> {
  const data = await apiV2<KeysetPage<BoardRepositoryRecord>>(
    `/collections/${encodeURIComponent(collectionId)}/repositories?${keysetPageQuery(options)}`,
    { signal },
    token,
  );
  validateKeysetPageResponse(data);
  return { ...data, items: mapRepositoryList(data.items) };
}

export async function createBoard(_userId: string, boardName: string, token: string) {
  const board = await apiV2<BoardRecord>('/boards', {
    method: 'POST',
    body: JSON.stringify({ name: boardName, description: null, visibility: 'private' }),
  }, token);
  return { ...board, board_name: board.name, repos_count: 0 };
}

export async function addRepoToBoardAtomic(
  _userId: string,
  boardId: string,
  repoId: string,
  token: string,
  attribution?: { serve_id?: string | null; position?: number | null },
  preparedEvent?: QueuedActivity,
) {
  const event = preparedEvent ?? prepareQueuedActivity({
    repo_id: repoId,
    action: 'save',
    ...attribution,
  } satisfies ActivityInput);
  if (event.repo_id !== repoId || event.action !== 'save') {
    throw new Error('The board save event does not match the repository request.');
  }
  await apiV2Raw(`/boards/${encodeURIComponent(boardId)}/repositories/${encodeURIComponent(repoId)}`, {
    method: 'PUT',
    body: JSON.stringify({ event: toInteractionEventV2(event) }),
  }, token);
  return { board_id: boardId, repo_id: repoId };
}
