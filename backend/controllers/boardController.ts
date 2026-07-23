import type { Request, Response } from 'express';
import type { AuthRequest } from '../middlewares/authMiddleware.js';
import * as boardService from '../services/boardService.js';
import { sendError, sendSuccess, sendDatabaseError, sendControllerError } from '../utils/response.js';
import { isValidUuid } from '../utils/validators.js';
import type { BoardInsert } from '../types/index.js';
import * as repoService from '../services/repoService.js';
import { db } from '../db/index.js';
import { repos } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { FeedService } from '../services/feedService.js';

const feedService = new FeedService();

async function resolveRepoId(repoIdOrFullName: string): Promise<string | null> {
  if (isValidUuid(repoIdOrFullName)) return repoIdOrFullName;
  
  try {
    const [existing] = await db.select().from(repos).where(eq(repos.full_name, repoIdOrFullName)).limit(1);
    if (existing) return existing.repo_id;
    
    const parts = repoIdOrFullName.split('/');
    if (parts.length !== 2) return null;
    const [owner_id, repo_name] = parts;
    
    const { data: newRepo } = await repoService.createRepo({
      full_name: repoIdOrFullName,
      owner_id,
      repo_name,
      github_repo_url: `https://github.com/${repoIdOrFullName}`
    });
    
    if (newRepo) return newRepo.repo_id;
  } catch (err) {
    console.error('[boardController] Error resolving repo ID:', err);
  }
  return null;
}

export async function createBoard(req: AuthRequest, res: Response): Promise<void> {
  const body = req.body as BoardInsert;
  const authUserId = req.user?.userId;

  if (!authUserId) return sendError(res, 401, 'Unauthorized');
  
  if (!body.board_name) {
    return sendError(res, 400, 'board_name is required.');
  }

  body.user_id = authUserId;

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
  
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
  const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

  if (!isValidUuid(userId)) return sendError(res, 400, 'userId must be a valid UUID.');

  const { data, error } = await boardService.getBoardsByUser(userId, limit, offset);
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

export async function addRepoToBoard(req: AuthRequest, res: Response): Promise<void> {
  const boardId = req.params.boardId as string;
  let repoId = req.body.repo_id as string;
  const authUserId = req.user?.userId;

  if (!authUserId) return sendError(res, 401, 'Unauthorized');

  const resolvedRepoId = await resolveRepoId(repoId);
  if (!resolvedRepoId) return sendError(res, 400, 'Invalid repository format or could not create repo.');
  repoId = resolvedRepoId;

  if (!isValidUuid(boardId)) return sendError(res, 400, 'boardId must be a valid UUID.');

  const { data: board, error: boardError } = await boardService.getBoardById(boardId);
  if (boardError) return sendDatabaseError(res, boardError, { notFoundMessage: 'Board not found.' });
  if (board.user_id !== authUserId) return sendError(res, 403, 'You do not own this board.');

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

export async function saveRepoToBoard(req: AuthRequest, res: Response): Promise<void> {
  const boardId = req.params.boardId as string;
  let repoId = req.body.repo_id as string;
  const authUserId = req.user?.userId;

  if (!authUserId) return sendError(res, 401, 'Unauthorized');

  const resolvedRepoId = await resolveRepoId(repoId);
  if (!resolvedRepoId) return sendError(res, 400, 'Invalid repository format or could not create repo.');
  repoId = resolvedRepoId;

  if (!isValidUuid(boardId)) return sendError(res, 400, 'boardId must be a valid UUID.');

  const { data: board, error: boardError } = await boardService.getBoardById(boardId);
  if (boardError) return sendDatabaseError(res, boardError, { notFoundMessage: 'Board not found.' });
  if (board.user_id !== authUserId) return sendError(res, 403, 'You do not own this board.');

  try {
    const { data, error } = await boardService.saveRepoToBoardAtomic(authUserId, boardId, repoId);
    if (error) {
      return sendDatabaseError(res, error, {
        invalidReferenceMessage: 'Repo does not exist or is not linked to a valid record.',
      });
    }
    
    if ((data as { saveStateChanged?: boolean } | null)?.saveStateChanged) {
      void feedService.invalidateUserFeed(authUserId);
    }

    return sendSuccess(res, 201, data);
  } catch (err) {
    return sendControllerError(res, err);
  }
}

export async function removeRepoFromBoard(req: AuthRequest, res: Response): Promise<void> {
  const { boardId, repoId } = req.params as { boardId: string; repoId: string };
  const authUserId = req.user?.userId;

  if (!authUserId) return sendError(res, 401, 'Unauthorized');
  if (!isValidUuid(boardId) || !isValidUuid(repoId)) return sendError(res, 400, 'boardId and repoId must be valid UUIDs.');

  const { data: board, error: boardError } = await boardService.getBoardById(boardId);
  if (boardError) return sendDatabaseError(res, boardError, { notFoundMessage: 'Board not found.' });
  if (board.user_id !== authUserId) return sendError(res, 403, 'You do not own this board.');

  try {
    const { error, count } = await boardService.removeRepoFromBoard(boardId, repoId);
    if (error) return sendDatabaseError(res, error);

    if (typeof count === 'number' && count === 0) return sendError(res, 404, 'Repo not found on board.');

    return sendSuccess(res, 200, { message: 'Repo removed from board.' });
  } catch (err) {
    return sendControllerError(res, err);
  }
}

export async function deleteBoardById(req: AuthRequest, res: Response): Promise<void> {
  const boardId = req.params.boardId as string;
  const authUserId = req.user?.userId;

  if (!authUserId) return sendError(res, 401, 'Unauthorized');
  if (!isValidUuid(boardId)) return sendError(res, 400, 'boardId must be a valid UUID.');

  const { data: board, error: boardError } = await boardService.getBoardById(boardId);
  if (boardError) return sendDatabaseError(res, boardError, { notFoundMessage: 'Board not found.' });
  if (board.user_id !== authUserId) return sendError(res, 403, 'You do not own this board.');

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
