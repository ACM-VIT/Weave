import type { Request, Response } from 'express';
import * as activityService from '../services/activityService.js';
import { sendError, sendSuccess, sendDatabaseError } from '../utils/response.js';
import { isValidUuid } from '../utils/validators.js';
import { AuthRequest } from '../middlewares/authMiddleware.js';
import { FeedService } from '../services/feedService.js';

const feedService = new FeedService();

// Return every activity row.
export async function getAllActivity(_req: Request, res: Response): Promise<void> {
  const { data, error } = await activityService.getAllActivity();

  if (error) {
    return sendDatabaseError(res, error);
  }

  return sendSuccess(res, 200, data);
}

// Return activity rows for a specific user.
export async function getUserActivity(req: Request, res: Response): Promise<void> {
  const userId = req.params.userId as string;
  const { data, error } = await activityService.getUserActivity(userId);

  if (error) {
    return sendDatabaseError(res, error);
  }

  return sendSuccess(res, 200, data);
}

// Return saved activity rows for a specific user.
export async function getSavedActivity(req: Request, res: Response): Promise<void> {
  const userId = req.params.userId as string;
  const { data, error } = await activityService.getSavedActivity(userId);

  if (error) {
    return sendDatabaseError(res, error);
  }

  return sendSuccess(res, 200, data);
}

// Return one activity row for a user and repo pair.
export async function getActivityByUserAndRepo(req: Request, res: Response): Promise<void> {
  const { userId, repoId } = req.params as { userId: string; repoId: string };
  const { data, error } = await activityService.getActivityByUserAndRepo(userId, repoId);

  if (error) {
    return sendDatabaseError(res, error);
  }

  return sendSuccess(res, 200, data);
}

// Update activity when the app knows user_id and repo_id.
export async function updateActivityByUserAndRepo(req: Request, res: Response): Promise<void> {
  const { userId, repoId } = req.params as { userId: string; repoId: string };
  const { data, error } = await activityService.updateActivityByUserAndRepo(
    userId,
    repoId,
    req.body,
  );

  if (error) {
    return sendDatabaseError(res, error, {
      notFoundMessage: 'Activity not found for this user and repo.',
    });
  }

  return sendSuccess(res, 200, data);
}

// Return one activity row by its primary key.
export async function getActivityById(req: Request, res: Response): Promise<void> {
  const activityId = req.params.activityId as string;
  const { data, error } = await activityService.getActivityById(activityId);

  if (error) {
    return sendDatabaseError(res, error, {
      notFoundMessage: 'Activity not found.',
    });
  }

  return sendSuccess(res, 200, data);
}

// Create a new activity row.
export async function createActivity(req: Request, res: Response): Promise<void> {
  const { data, error } = await activityService.createActivity(req.body);

  if (error) {
    return sendDatabaseError(res, error);
  }

  return sendSuccess(res, 201, data);
}

// Update activity directly by primary key.
export async function updateActivityById(req: Request, res: Response): Promise<void> {
  const activityId = req.params.activityId as string;
  const { data, error } = await activityService.updateActivityById(activityId, req.body);

  if (error) {
    return sendDatabaseError(res, error, {
      notFoundMessage: 'Activity not found.',
    });
  }

  return sendSuccess(res, 200, data);
}

// Delete activity directly by primary key.
export async function deleteActivityById(req: Request, res: Response): Promise<void> {
  const activityId = req.params.activityId as string;
  const { error, count } = await activityService.deleteActivityById(activityId);

  if (error) {
    return sendDatabaseError(res, error, {
      notFoundMessage: 'Activity not found.',
    });
  }

  if (count === 0) {
    return sendError(res, 404, 'Activity not found.');
  }

  res.status(204).send();
}

// Toggle like for a user/repo pair.
export async function likeRepo(req: Request, res: Response): Promise<void> {
  const { userId, repoId } = req.params as { userId: string; repoId: string };
  const authReq = req as AuthRequest;

  if (authReq.user && authReq.user.userId !== userId) {
    return sendError(res, 403, 'Forbidden: You cannot perform activities for another user.');
  }

  if (!isValidUuid(userId) || !isValidUuid(repoId)) {
    return sendError(res, 400, 'userId and repoId must be valid UUIDs.');
  }

  const { data, error } = await activityService.toggleRepoLike(userId, repoId);

  if (error) {
    return sendDatabaseError(res, error);
  }

  // Forward feedback to ML service asynchronously and invalidate cache
  const isLiked = data && data.likelihood_count === 1;
  const action = isLiked ? 'like' : 'skip';
  feedService.submitFeedback(userId, repoId, action).catch(err => {
    console.error('[ActivityController] Failed to forward like feedback:', err);
  });

  return sendSuccess(res, 200, data);
}

// Toggle save for a user/repo pair.
export async function saveRepo(req: Request, res: Response): Promise<void> {
  const { userId, repoId } = req.params as { userId: string; repoId: string };
  const authReq = req as AuthRequest;

  if (authReq.user && authReq.user.userId !== userId) {
    return sendError(res, 403, 'Forbidden: You cannot perform activities for another user.');
  }

  if (!isValidUuid(userId) || !isValidUuid(repoId)) {
    return sendError(res, 400, 'userId and repoId must be valid UUIDs.');
  }

  const { data, error } = await activityService.toggleRepoSave(userId, repoId);

  if (error) {
    return sendDatabaseError(res, error);
  }

  // Forward feedback to ML service asynchronously and invalidate cache
  const isSaved = data && data.is_saved === true;
  const action = isSaved ? 'save' : 'skip';
  feedService.submitFeedback(userId, repoId, action).catch(err => {
    console.error('[ActivityController] Failed to forward save feedback:', err);
  });

  return sendSuccess(res, 200, data);
}
