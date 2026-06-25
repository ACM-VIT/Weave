import type { Request, Response } from 'express';
import * as boardService from '../services/boardService.js';
import { sendError, sendSuccess, sendDatabaseError, sendControllerError } from '../utils/response.js';
import { isValidUuid } from '../utils/validators.js';
import type { BoardInsert } from '../types/index.js';

export async function createBoard(req: Request, res: Response): Promise<void> {
  const body = req.body as BoardInsert;

  if (!body.user_id || !body.board_name) {
    return sendError(res, 400, 'user_id and board_name are required.');
  }

  if (!isValidUuid(body.user_id)) {
    return sendError(res, 400, 'user_id must be a valid UUID.');
  }

  try {
    const { data, error } = await boardService.createBoard(body);
    if (error) return sendDatabaseError(res, error);
    return sendSuccess(res, 201, data);
  } catch (err) {
    return sendControllerError(res, err);
  }
}

export async function getBoardsByUser(req: Request, res: Response): Promise<void> {
  const userId = req.params.userId as string;
  const viewerId = req.query.viewer_id as string | undefined;
  if (!isValidUuid(userId)) return sendError(res, 400, 'userId must be a valid UUID.');

  const { data, error } = await boardService.getBoardsByUser(userId);
  if (error) return sendDatabaseError(res, error);

  if (viewerId === userId) {
    return sendSuccess(res, 200, data);
  }

  const publicBoards = (data as { visibility: string }[]).filter(b => b.visibility === 'public');
  return sendSuccess(res, 200, publicBoards);
}

export async function getBoardById(req: Request, res: Response): Promise<void> {
  const boardId = req.params.boardId as string;
  const viewerId = req.query.viewer_id as string | undefined;
  if (!isValidUuid(boardId)) return sendError(res, 400, 'boardId must be a valid UUID.');

  const { data, error } = await boardService.getBoardById(boardId);
  if (error) return sendDatabaseError(res, error, { notFoundMessage: 'Board not found.' });

  if (data.visibility === 'private' && data.user_id !== viewerId) {
    return sendError(res, 404, 'Board not found.');
  }

  return sendSuccess(res, 200, data);
}

export async function addRepoToBoard(req: Request, res: Response): Promise<void> {
  const boardId = req.params.boardId as string;
  const repoId = req.body.repo_id as string;
  const userId = req.body.user_id as string | undefined;

  if (!isValidUuid(boardId) || !isValidUuid(repoId)) return sendError(res, 400, 'boardId and repo_id must be valid UUIDs.');
  if (!userId || !isValidUuid(userId)) return sendError(res, 400, 'user_id is required and must be a valid UUID.');

  const { data: board, error: boardError } = await boardService.getBoardById(boardId);
  if (boardError) return sendDatabaseError(res, boardError, { notFoundMessage: 'Board not found.' });
  if (board.user_id !== userId) return sendError(res, 403, 'You do not own this board.');

  try {
    const { data, error } = await boardService.addRepoToBoard(boardId, repoId);
    if (error) {
      if (
        error.code === 'P0001' &&
        error.message?.includes('Repo must be saved by the board owner')
      ) {
        return sendError(
          res,
          400,
          'Repo must be saved by the board owner before it can be added to this board.',
        );
      }
      return sendDatabaseError(res, error, {
        invalidReferenceMessage: 'Repo does not exist or is not linked to a valid record.',
      });
    }
    return sendSuccess(res, 201, data);
  } catch (err) {
    return sendControllerError(res, err);
  }
}

export async function removeRepoFromBoard(req: Request, res: Response): Promise<void> {
  const { boardId, repoId } = req.params as { boardId: string; repoId: string };
  const userId = req.body.user_id as string | undefined;
  if (!isValidUuid(boardId) || !isValidUuid(repoId)) return sendError(res, 400, 'boardId and repoId must be valid UUIDs.');
  if (!userId || !isValidUuid(userId)) return sendError(res, 400, 'user_id is required and must be a valid UUID.');

  const { data: board, error: boardError } = await boardService.getBoardById(boardId);
  if (boardError) return sendDatabaseError(res, boardError, { notFoundMessage: 'Board not found.' });
  if (board.user_id !== userId) return sendError(res, 403, 'You do not own this board.');

  try {
    const { error, count } = await boardService.removeRepoFromBoard(boardId, repoId);
    if (error) return sendDatabaseError(res, error);

    if (typeof count === 'number' && count === 0) return sendError(res, 404, 'Repo not found on board.');

    return sendSuccess(res, 200, { message: 'Repo removed from board.' });
  } catch (err) {
    return sendControllerError(res, err);
  }
}

export async function deleteBoardById(req: Request, res: Response): Promise<void> {
  const boardId = req.params.boardId as string;
  const userId = req.body.user_id as string | undefined;
  if (!isValidUuid(boardId)) return sendError(res, 400, 'boardId must be a valid UUID.');
  if (!userId || !isValidUuid(userId)) return sendError(res, 400, 'user_id is required and must be a valid UUID.');

  const { data: board, error: boardError } = await boardService.getBoardById(boardId);
  if (boardError) return sendDatabaseError(res, boardError, { notFoundMessage: 'Board not found.' });
  if (board.user_id !== userId) return sendError(res, 403, 'You do not own this board.');

  try {
    const { error, count } = await boardService.deleteBoard(boardId);
    if (error) return sendDatabaseError(res, error);
    if (typeof count === 'number' && count === 0) return sendError(res, 404, 'Board not found.');
    return sendSuccess(res, 200, { message: 'Board deleted.' });
  } catch (err) {
    return sendControllerError(res, err);
  }
}

export async function getReposForBoard(req: Request, res: Response): Promise<void> {
  const boardId = req.params.boardId as string;
  const viewerId = req.query.viewer_id as string | undefined;
  if (!isValidUuid(boardId)) return sendError(res, 400, 'boardId must be a valid UUID.');

  const { data: board, error: boardError } = await boardService.getBoardById(boardId);
  if (boardError) return sendDatabaseError(res, boardError, { notFoundMessage: 'Board not found.' });

  if (board.visibility === 'private' && board.user_id !== viewerId) {
    return sendError(res, 404, 'Board not found.');
  }

  const { data, error } = await boardService.getReposForBoard(boardId);
  if (error) return sendDatabaseError(res, error);
  return sendSuccess(res, 200, data);
}
