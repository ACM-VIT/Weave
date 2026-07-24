import type { Request, Response } from 'express';
import type { AuthRequest } from '../middlewares/authMiddleware.js';
import * as activityService from '../services/activityService.js';
import { FeedService } from '../services/feedService.js';
import { sendError, sendSuccess, sendDatabaseError } from '../utils/response.js';
import { isValidUuid } from '../utils/validators.js';
import { isFeedbackInteraction } from '../config/feedback.js';

const feedService = new FeedService();

function shouldInvalidateFeedForEvents(events: { action: string }[]): boolean {
  return events.some((event) => event.action !== 'impression');
}

// Return every activity row.
export async function getAllActivity(_req: Request, res: Response): Promise<void> {
  const { data, error } = await activityService.getAllActivity();

  if (error) {
    return sendDatabaseError(res, error);
  }

  return sendSuccess(res, 200, data);
}

// Process a batch of activity events (impressions, dwells, and explicit feedback)
export async function processBatchedActivity(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user?.userId;
  const events = req.body.events;

  if (!userId) {
    return sendError(res, 401, 'Unauthorized');
  }

  if (!Array.isArray(events)) {
    return sendError(res, 400, 'events must be an array');
  }
  if (events.length === 0 || events.length > 100) {
    return sendError(res, 400, 'events must contain between 1 and 100 items');
  }
  for (const event of events) {
    if (!event || typeof event.repo_id !== 'string' || !isFeedbackInteraction(event.action)) {
      return sendError(res, 400, 'Each event requires a repo_id and supported action');
    }
    if (event.action === 'dwell' && (
      typeof event.dwell_seconds !== 'number' || event.dwell_seconds <= 0
    )) {
      return sendError(res, 400, 'dwell_seconds must be positive for dwell events');
    }
  }

  const persistEvents: activityService.BatchedActivityEvent[] = [];
  for (const event of events) {
    if (event.action === 'like' || event.action === 'dislike') {
      const { data: currentActivity } = await activityService.getActivityByUserAndRepo(userId, event.repo_id);
      if (event.action === 'like' && currentActivity?.likelihood_count === -1) {
        persistEvents.push({ repo_id: event.repo_id, action: 'undislike' });
      } else if (event.action === 'dislike' && currentActivity?.likelihood_count === 1) {
        persistEvents.push({ repo_id: event.repo_id, action: 'unlike' });
      }
    }
    persistEvents.push({
      repo_id: event.repo_id,
      action: event.action,
      dwell_seconds: event.dwell_seconds,
    });
  }

  const { error } = await activityService.processBatchedActivity(userId, persistEvents);
  if (error) {
    return sendDatabaseError(res, error as import('../types/index.js').PostgresError);
  }

  if (shouldInvalidateFeedForEvents(persistEvents)) {
    void feedService.invalidateUserFeed(userId);
  }

  return sendSuccess(res, 202, { message: 'Batched activity processed' });
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

export async function getSavedActivity(req: Request, res: Response): Promise<void> {
  const userId = req.params.userId as string;

  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
  const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

  const { data, error } = await activityService.getSavedActivity(userId, limit, offset);

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
export async function likeRepo(req: AuthRequest, res: Response): Promise<void> {
  const { userId, repoId } = req.params as { userId: string; repoId: string };
  const authUserId = req.user?.userId;

  if (!authUserId) {
    return sendError(res, 401, 'Unauthorized');
  }
  if (authUserId !== userId) {
    return sendError(res, 403, 'Forbidden: user mismatch.');
  }

  if (!isValidUuid(userId) || !isValidUuid(repoId)) {
    return sendError(res, 400, 'userId and repoId must be valid UUIDs.');
  }

  const { data: currentActivity } = await activityService.getActivityByUserAndRepo(userId, repoId);
  const wasDisliked = currentActivity?.likelihood_count === -1;
  const wasLiked = currentActivity?.likelihood_count === 1;
  const action = wasLiked ? 'unlike' : 'like';
  const events: activityService.BatchedActivityEvent[] = [];
  if (!wasLiked && wasDisliked) {
    events.push({ repo_id: repoId, action: 'undislike' });
  }
  events.push({ repo_id: repoId, action });

  const { error } = await activityService.processBatchedActivity(userId, events);

  if (error) {
    return sendDatabaseError(res, error as import('../types/index.js').PostgresError);
  }

  void feedService.invalidateUserFeed(userId);

  const { data } = await activityService.getActivityByUserAndRepo(userId, repoId);
  const liked = (data as { likelihood_count?: number } | null)?.likelihood_count === 1;
  return sendSuccess(res, 200, data);
}

// Toggle save for a user/repo pair.
export async function saveRepo(req: AuthRequest, res: Response): Promise<void> {
  const { userId, repoId } = req.params as { userId: string; repoId: string };
  const authUserId = req.user?.userId;

  if (!authUserId) {
    return sendError(res, 401, 'Unauthorized');
  }
  if (authUserId !== userId) {
    return sendError(res, 403, 'Forbidden: user mismatch.');
  }

  if (!isValidUuid(userId) || !isValidUuid(repoId)) {
    return sendError(res, 400, 'userId and repoId must be valid UUIDs.');
  }

  const { data: currentActivity } = await activityService.getActivityByUserAndRepo(userId, repoId);
  const savedAlready = currentActivity?.is_saved === true;
  const action = savedAlready ? 'unsave' : 'save';
  const { error } = await activityService.processBatchedActivity(userId, [
    { repo_id: repoId, action },
  ]);

  if (error) {
    return sendDatabaseError(res, error as import('../types/index.js').PostgresError);
  }

  void feedService.invalidateUserFeed(userId);

  const { data } = await activityService.getActivityByUserAndRepo(userId, repoId);
  return sendSuccess(res, 200, data);
}

// Toggle dislike for a user/repo pair.
export async function dislikeRepo(req: AuthRequest, res: Response): Promise<void> {
  const { userId, repoId } = req.params as { userId: string; repoId: string };
  const authUserId = req.user?.userId;

  if (!authUserId) {
    return sendError(res, 401, 'Unauthorized');
  }
  if (authUserId !== userId) {
    return sendError(res, 403, 'Forbidden: user mismatch.');
  }

  if (!isValidUuid(userId) || !isValidUuid(repoId)) {
    return sendError(res, 400, 'userId and repoId must be valid UUIDs.');
  }

  const { data: currentActivity } = await activityService.getActivityByUserAndRepo(userId, repoId);
  const wasLiked = currentActivity?.likelihood_count === 1;
  const wasDisliked = currentActivity?.likelihood_count === -1;

  // Toggle dislike via the batch processing service (handles the CASE logic)
  const action = wasDisliked ? 'undislike' : 'dislike';
  const events: activityService.BatchedActivityEvent[] = [];
  if (!wasDisliked && wasLiked) {
    events.push({ repo_id: repoId, action: 'unlike' });
  }
  events.push({ repo_id: repoId, action });

  const { error } = await activityService.processBatchedActivity(userId, events);

  if (error) {
    return sendDatabaseError(res, error as import('../types/index.js').PostgresError);
  }

  void feedService.invalidateUserFeed(userId);

  // Build ML events with correct reversal ordering
    // Switching from like → dislike: emit unlike first

  // Re-fetch the updated activity row
  const { data: updatedActivity } = await activityService.getActivityByUserAndRepo(userId, repoId);
  return sendSuccess(res, 200, updatedActivity);
}
