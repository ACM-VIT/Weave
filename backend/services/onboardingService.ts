import { supabaseAdmin } from '../config/supabase.js';
import * as githubService from './githubService.js';
import * as userService from './userService.js';
import type { UserUpdate } from '../types/database.js';
import type { OnboardingSetupBody, SyncGitHubResponse } from '../types/onboarding.js';

export function buildSetupUpdates(body: OnboardingSetupBody): UserUpdate {
  const updates: UserUpdate = {
    username: body.username.trim(),
    full_name: body.full_name.trim(),
  };

  if (body.date_of_birth !== undefined) {
    updates.date_of_birth = body.date_of_birth;
  }

  if (body.bio !== undefined) {
    updates.bio = body.bio;
  }

  if (body.interests !== undefined) {
    updates.interests = body.interests;
  }

  if (body.skills !== undefined) {
    updates.skills = body.skills;
  }

  if (body.tech_stack !== undefined) {
    updates.tech_stack = body.tech_stack;
  }

  if (body.avatar_url !== undefined) {
    updates.avatar_url = body.avatar_url;
  }

  return updates;
}

export async function getOnboardingStatus(userId: string) {
  return userService.getUserProfile(userId);
}

export async function setupOnboardingProfile(userId: string, body: OnboardingSetupBody) {
  const updates = buildSetupUpdates(body);
  return userService.updateUserProfile(userId, updates);
}

function extractGitHubHandleFromAuthIdentity(user: {
  identities?: Array<{ provider: string; identity_data?: Record<string, unknown> }>;
  user_metadata?: Record<string, unknown>;
}): string | null {
  const githubIdentity = user.identities?.find((identity) => identity.provider === 'github');

  if (githubIdentity?.identity_data) {
    const preferredUsername = githubIdentity.identity_data.preferred_username;
    if (typeof preferredUsername === 'string' && preferredUsername.trim()) {
      return preferredUsername.trim();
    }

    const userName = githubIdentity.identity_data.user_name;
    if (typeof userName === 'string' && userName.trim()) {
      return userName.trim();
    }
  }

  return null;
}

export async function syncGitHubProfile(userId: string) {
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.getUserById(userId);

  if (authError || !authData?.user) {
    return { data: null, error: authError ?? { code: 'PGRST116', message: 'User not found' } };
  }

  // FORCE the use of the securely extracted handle. No overrides allowed.
  const githubHandle = extractGitHubHandleFromAuthIdentity(authData.user);

  if (!githubHandle) {
    return {
      data: null,
      error: {
        code: 'GITHUB_NOT_LINKED',
        message: 'No GitHub account linked. You must sign in using the GitHub provider.',
      },
    };
  }

  const githubProfile = await githubService.fetchGitHubUserProfile(githubHandle);

  const updates: UserUpdate = {
    github_id: String(githubProfile.id),
    github_handle: githubProfile.login,
    github_url: githubProfile.html_url,
    avatar_url: githubProfile.avatar_url,
  };

  // Only safely update bio/name if they exist
  if (githubProfile.bio) {
    updates.bio = githubProfile.bio;
  }

  if (githubProfile.name) {
    updates.full_name = githubProfile.name;
  }

  const { data, error } = await userService.updateUserProfile(userId, updates);

  if (error) {
    return { data: null, error };
  }

  const syncResult: SyncGitHubResponse = {
    github_id: String(githubProfile.id),
    github_handle: githubProfile.login,
    github_url: githubProfile.html_url,
    avatar_url: githubProfile.avatar_url,
    bio: githubProfile.bio,
    full_name: githubProfile.name,
  };

  return { data: syncResult, error: null, profile: data };
}