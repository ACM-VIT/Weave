import type { Response } from 'express';
import type { AuthRequest } from '../middlewares/authMiddleware.js';
import * as onboardingService from '../services/onboardingService.js';
import {
  sendControllerError,
  sendError,
  sendSuccess,
  sendDatabaseError,
} from '../utils/response.js';
import { GitHubApiError } from '../services/githubService.js';
import type { OnboardingSetupBody } from '../types/onboarding.js';

function getAuthenticatedUserId(req: AuthRequest, res: Response): string | null {
  const userId = req.user?.userId;

  if (!userId) {
    sendError(res, 401, 'Unauthorized request. Please log in.');
    return null;
  }

  return userId;
}

export async function getOnboardingStatus(req: AuthRequest, res: Response): Promise<void> {
  const userId = getAuthenticatedUserId(req, res);
  if (!userId) return;

  const { data, error } = await onboardingService.getOnboardingStatus(userId);

  if (error) {
    return sendDatabaseError(res, error, {
      notFoundMessage: 'User profile not found',
    });
  }

  return sendSuccess(res, 200, data);
}

export async function setupOnboarding(req: AuthRequest, res: Response): Promise<void> {
  const userId = getAuthenticatedUserId(req, res);
  if (!userId) return;

  const body = req.body as OnboardingSetupBody;

  if (!body.username?.trim()) {
    return sendError(res, 400, 'username is required.');
  }

  if (!body.full_name?.trim()) {
    return sendError(res, 400, 'full_name is required.');
  }

  if (body.interests !== undefined && !Array.isArray(body.interests)) {
    return sendError(res, 400, 'interests must be an array of strings.');
  }

  if (body.interests?.some((interest) => typeof interest !== 'string' || !interest.trim())) {
    return sendError(res, 400, 'Each interest must be a non-empty string.');
  }

  if (body.skills !== undefined && !Array.isArray(body.skills)) {
    return sendError(res, 400, 'skills must be an array of strings.');
  }

  if (body.skills?.some((skill) => typeof skill !== 'string' || !skill.trim())) {
    return sendError(res, 400, 'Each skill must be a non-empty string.');
  }

  if (body.tech_stack !== undefined && !Array.isArray(body.tech_stack)) {
    return sendError(res, 400, 'tech_stack must be an array of strings.');
  }

  if (body.tech_stack?.some((item) => typeof item !== 'string' || !item.trim())) {
    return sendError(res, 400, 'Each tech_stack item must be a non-empty string.');
  }

  if (body.avatar_url !== undefined && body.avatar_url !== null) {
    if (typeof body.avatar_url !== 'string' || !body.avatar_url.startsWith('http')) {
      return sendError(res, 400, 'avatar_url must be a valid URL starting with http/https.');
    }
  }

  if (body.date_of_birth !== undefined && body.date_of_birth !== null) {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (typeof body.date_of_birth !== 'string' || !dateRegex.test(body.date_of_birth)) {
      return sendError(res, 400, 'date_of_birth must be a valid date string in YYYY-MM-DD format.');
    }
    if (isNaN(Date.parse(body.date_of_birth))) {
      return sendError(res, 400, 'date_of_birth must be a valid calendar date.');
    }
  }

  const { data, error } = await onboardingService.setupOnboardingProfile(userId, body);

  if (error) {
    return sendDatabaseError(res, error as any, {
      conflictMessage: 'Username is already taken.',
    });
  }

  return sendSuccess(res, 200, data);
}

export async function syncGitHub(req: AuthRequest, res: Response): Promise<void> {
  const userId = getAuthenticatedUserId(req, res);
  if (!userId) return;

  try {
    // Pass ONLY the userId. The service will extract the safe handle from Auth.
    const { data, error, profile } = await onboardingService.syncGitHubProfile(userId);

    if (error) {
      if (error.code === 'GITHUB_NOT_LINKED') {
        return sendError(res, 400, error.message);
      }

      return sendDatabaseError(res, error as any, {
        notFoundMessage: 'User profile not found',
        conflictMessage: 'This GitHub account is already linked to another user.',
      });
    }

    return sendSuccess(res, 200, { synced: data, profile });
    
  } catch (err) {
    if (err instanceof GitHubApiError) {
      const statusCode = err.statusCode === 404 ? 404 : err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 502;
      return sendError(res, statusCode, err.message);
    }

    return sendControllerError(res, err);
  }
}