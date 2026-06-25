import type { Request, Response } from 'express';
import type { AuthRequest } from '../middlewares/authMiddleware.js'; // Bring in your custom type
import * as userService from '../services/userService.js';
import { sendError, sendSuccess, sendDatabaseError } from '../utils/response.js';
import { isValidUuid } from '../utils/validators.js'; // You might not need this anymore for the follower, but keep it if you use it elsewhere

// Fetch a user's public profile (Remains standard Request as it is a public route)
export async function getUserProfile(req: Request, res: Response): Promise<void> {
  const username = req.params.username as string;

  const { data, error } = await userService.getUserProfileByUsername(username);

  if (error) {
    return sendDatabaseError(res, error, {
      notFoundMessage: 'User not found',
    });
  }

  return sendSuccess(res, 200, data);
}

// Update current user's profile (Uses AuthRequest)
export async function updateProfile(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user?.userId;

  if (!userId) {
    return sendError(res, 401, 'Unauthorized request. Please log in.');
  }

  const { username, full_name, date_of_birth, bio, github_url, avatar_url } = req.body;

  // Build the updates object
  const updates: any = {};
  if (username !== undefined) updates.username = username;
  if (full_name !== undefined) updates.full_name = full_name;
  if (date_of_birth !== undefined) updates.date_of_birth = date_of_birth;
  if (bio !== undefined) updates.bio = bio;
  if (github_url !== undefined) updates.github_url = github_url;
  if (avatar_url !== undefined) updates.avatar_url = avatar_url;

  const { data, error } = await userService.updateUserProfile(userId, updates);

  if (error) {
    return sendDatabaseError(res, error);
  }

  return sendSuccess(res, 200, data);
}

// Follow a user (Uses AuthRequest)
export async function followUser(req: AuthRequest, res: Response): Promise<void> {
  const username = req.params.username as string;
  
  // SECURE: Grab the ID directly from the verified JWT
  const followerId = req.user?.userId;

  if (!followerId) {
    return sendError(res, 401, 'Unauthorized request. Please log in.');
  }

  const { data: targetUser, error: targetError } = await userService.getUserIdByUsername(username);

  if (targetError) {
    return sendDatabaseError(res, targetError, {
      notFoundMessage: 'Target user not found',
    });
  }

  if (!targetUser) {
    return sendError(res, 404, 'Target user not found');
  }

  const targetUserId = (targetUser as { user_id: string }).user_id;

  if (followerId === targetUserId) {
    return sendError(res, 400, 'You cannot follow yourself.');
  }

  const { error: followError } = await userService.followUser(followerId, targetUserId);

  if (followError) {
    return sendDatabaseError(res, followError, {
      conflictMessage: 'You are already following this user.',
      invalidReferenceMessage: 'Invalid follower_id: User does not exist.',
    });
  }

  return sendSuccess(res, 200, { message: `Successfully followed ${username}` });
}

// Unfollow a user (Uses AuthRequest)
export async function unfollowUser(req: AuthRequest, res: Response): Promise<void> {
  const username = req.params.username as string;
  
  // SECURE: Grab the ID directly from the verified JWT
  const followerId = req.user?.userId;

  if (!followerId) {
    return sendError(res, 401, 'Unauthorized request. Please log in.');
  }

  const { data: targetUser, error: targetError } = await userService.getUserIdByUsername(username);

  if (targetError) {
    return sendDatabaseError(res, targetError, {
      notFoundMessage: 'Target user not found',
    });
  }

  if (!targetUser) {
    return sendError(res, 404, 'Target user not found');
  }

  const targetUserId = (targetUser as { user_id: string }).user_id;

  const { error: unfollowError, count } = await userService.unfollowUser(
    followerId,
    targetUserId,
  );

  if (unfollowError) {
    return sendDatabaseError(res, unfollowError);
  }

  if (count === 0) {
    return sendError(res, 400, 'You are not following this user.');
  }

  return sendSuccess(res, 200, { message: `Successfully unfollowed ${username}` });
}

// List all users.
export async function getAllUsers(_req: Request, res: Response): Promise<void> {
  const { data, error } = await userService.getAllUsers();

  if (error) {
    return sendDatabaseError(res, error);
  }

  return sendSuccess(res, 200, data);
}

// Fetch a user's public profile by UUID.
export async function getUserById(req: Request, res: Response): Promise<void> {
  const userId = req.params.userId as string;

  if (!isValidUuid(userId)) {
    return sendError(res, 400, 'userId must be a valid UUID.');
  }

  const { data, error } = await userService.getUserById(userId);

  if (error) {
    return sendDatabaseError(res, error, {
      notFoundMessage: 'User not found',
    });
  }

  return sendSuccess(res, 200, data);
}
