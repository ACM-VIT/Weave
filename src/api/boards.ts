import { apiV2, apiV2Raw } from './client';
import { sendBatchedActivity } from './activity';

export type BoardRecord = {
  board_id: string;
  name: string;
  repo_count: number;
  [key: string]: unknown;
};

export type FrontendBoard = BoardRecord & {
  board_name: string;
  repos_count: number;
};

export async function getUserBoards(_userId: string, token: string, _limit = 20, _offset = 0) {
  const data = await apiV2<{ items: BoardRecord[] }>('/boards', {}, token);
  return data.items.map((board) => ({
    ...board,
    board_name: board.name,
    repos_count: board.repo_count,
  }));
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
) {
  await apiV2Raw(`/boards/${encodeURIComponent(boardId)}/repositories/${encodeURIComponent(repoId)}`, {
    method: 'PUT',
  }, token);
  await sendBatchedActivity([{ repo_id: repoId, action: 'save', ...attribution }], token);
  return { board_id: boardId, repo_id: repoId };
}
