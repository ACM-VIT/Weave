import type { Request, Response } from 'express';
import * as commentService from '../services/commentService.js';
import { sendError, sendSuccess, sendDatabaseError } from '../utils/response.js';

// Return every comment row.
export async function getAllComments(_req: Request, res: Response): Promise<void> {
  const { data, error } = await commentService.getAllComments();

  if (error) {
    return sendDatabaseError(res, error);
  }

  return sendSuccess(res, 200, data);
}

// Return comment rows for a specific repository.
export async function getCommentsByRepo(req: Request, res: Response): Promise<void> {
  const repoId = req.params.repoId as string;
  const { data, error } = await commentService.getCommentsByRepo(repoId);

  if (error) {
    return sendDatabaseError(res, error);
  }

  return sendSuccess(res, 200, data);
}

// Return comment rows for a specific user.
export async function getCommentsByUser(req: Request, res: Response): Promise<void> {
  const userId = req.params.userId as string;
  const { data, error } = await commentService.getCommentsByUser(userId);

  if (error) {
    return sendDatabaseError(res, error);
  }

  return sendSuccess(res, 200, data);
}

// Return replies for a specific parent comment.
export async function getRepliesByParentComment(req: Request, res: Response): Promise<void> {
  const parentCommentId = req.params.parentCommentId as string;
  const { data, error } = await commentService.getRepliesByParentComment(parentCommentId);

  if (error) {
    return sendDatabaseError(res, error);
  }

  return sendSuccess(res, 200, data);
}

// Return one comment row by its primary key.
export async function getCommentById(req: Request, res: Response): Promise<void> {
  const commentId = req.params.commentId as string;
  const { data, error } = await commentService.getCommentById(commentId);

  if (error) {
    return sendDatabaseError(res, error, {
      notFoundMessage: 'Comment not found.',
    });
  }

  return sendSuccess(res, 200, data);
}

// Create a new comment row.
export async function createComment(req: Request, res: Response): Promise<void> {
  const { data, error } = await commentService.createComment(req.body);

  if (error) {
    return sendDatabaseError(res, error);
  }

  return sendSuccess(res, 201, data);
}

// Update one comment directly by primary key.
export async function updateCommentById(req: Request, res: Response): Promise<void> {
  const commentId = req.params.commentId as string;
  const { data, error } = await commentService.updateCommentById(commentId, req.body);

  if (error) {
    return sendDatabaseError(res, error, {
      notFoundMessage: 'Comment not found.',
    });
  }

  return sendSuccess(res, 200, data);
}

// Delete one comment directly by primary key.
export async function deleteCommentById(req: Request, res: Response): Promise<void> {
  const commentId = req.params.commentId as string;
  const { error, count } = await commentService.deleteCommentById(commentId);

  if (error) {
    return sendDatabaseError(res, error, {
      notFoundMessage: 'Comment not found.',
    });
  }

  if (count === 0) {
    return sendError(res, 404, 'Comment not found.');
  }

  res.status(204).send();
}
