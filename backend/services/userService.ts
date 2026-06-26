import { db } from '../db/index.js';
import { users, follows } from '../db/schema.js';
import { eq, desc, and } from 'drizzle-orm';
import type { UserProfile, UserUpdate } from '../types/database.js';
import type { OnboardingStatusResponse, OnboardingStepStatus } from '../types/onboarding.js';

const USER_PROFILE_COLUMNS = {
  username: users.username,
  full_name: users.full_name,
  date_of_birth: users.date_of_birth,
  bio: users.bio,
  github_url: users.github_url,
  github_handle: users.github_handle,
  avatar_url: users.avatar_url,
  followers_count: users.followers_count,
  following_count: users.following_count,
  saved_repos_count: users.saved_repos_count,
  interests: users.interests,
  skills: users.skills,
  tech_stack: users.tech_stack,
  onboarding_completed: users.onboarding_completed,
  created_at: users.created_at,
};

const ONBOARDING_EVALUATION_COLUMNS = { ...USER_PROFILE_COLUMNS };

const DEFAULT_USERNAME_PREFIX = 'user_';

type OnboardingProfileState = Pick<
  UserProfile,
  | 'username' | 'full_name' | 'bio' | 'avatar_url' | 'github_url' | 'github_handle'
  | 'interests' | 'skills' | 'tech_stack' | 'onboarding_completed'
>;

function isDefaultUsername(username: string): boolean {
  return /^user_[0-9a-f]{8}$/.test(username);
}

function hasNonEmptyJsonArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function evaluateOnboardingSteps(profile: OnboardingProfileState): OnboardingStepStatus {
  const profileComplete =
    profile.username.trim().length > 0 &&
    !isDefaultUsername(profile.username) &&
    Boolean(profile.full_name?.trim());

  const githubComplete = Boolean(profile.github_handle?.trim());

  return {
    profile: profileComplete,
    github: githubComplete,
    interests: hasNonEmptyJsonArray(profile.interests),
    skills: hasNonEmptyJsonArray(profile.skills),
    tech_stack: hasNonEmptyJsonArray(profile.tech_stack),
  };
}

function buildMissingFields(steps: OnboardingStepStatus, profile: OnboardingProfileState): string[] {
  const missing: string[] = [];
  if (!steps.profile) {
    if (!profile.username.trim() || isDefaultUsername(profile.username)) missing.push('username');
    if (!profile.full_name?.trim()) missing.push('full_name');
  }
  if (!steps.github) missing.push('github');
  if (!steps.interests) missing.push('interests');
  if (!steps.skills) missing.push('skills');
  if (!steps.tech_stack) missing.push('tech_stack');
  return missing;
}

function isOnboardingComplete(profile: OnboardingProfileState): boolean {
  const steps = evaluateOnboardingSteps(profile);
  return buildMissingFields(steps, profile).length === 0;
}

function buildOnboardingStatus(profile: UserProfile): OnboardingStatusResponse {
  const steps = evaluateOnboardingSteps(profile);
  const missingFields = buildMissingFields(steps, profile);

  return {
    isComplete: profile.onboarding_completed || missingFields.length === 0,
    steps,
    missingFields,
    profile,
  };
}

export async function getUserProfile(userId: string) {
  try {
    const [data] = await db.select(ONBOARDING_EVALUATION_COLUMNS).from(users).where(eq(users.user_id, userId)).limit(1);
    if (!data) throw { code: 'PGRST116', message: 'Not found' };
    return { data: buildOnboardingStatus(data as unknown as UserProfile), error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function getUserProfileByUsername(username: string) {
  try {
    const [data] = await db.select(USER_PROFILE_COLUMNS).from(users).where(eq(users.username, username)).limit(1);
    if (!data) throw { code: 'PGRST116', message: 'Not found' };
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function getUserIdByUsername(username: string) {
  try {
    const [data] = await db.select({ user_id: users.user_id }).from(users).where(eq(users.username, username)).limit(1);
    if (!data) throw { code: 'PGRST116', message: 'Not found' };
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function followUser(followerId: string, followingId: string) {
  try {
    const [data] = await db.insert(follows).values({ follower_id: followerId, following_id: followingId }).returning();
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function unfollowUser(followerId: string, followingId: string) {
  try {
    const result = await db.delete(follows).where(and(eq(follows.follower_id, followerId), eq(follows.following_id, followingId))).returning();
    return { data: null, error: null, count: result.length };
  } catch (error) { return { data: null, error: error as any, count: 0 }; }
}

export async function getAllUsers() {
  try {
    const data = await db.select(USER_PROFILE_COLUMNS).from(users).orderBy(desc(users.created_at));
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function getUserById(userId: string) {
  try {
    const [data] = await db.select(USER_PROFILE_COLUMNS).from(users).where(eq(users.user_id, userId)).limit(1);
    if (!data) throw { code: 'PGRST116', message: 'Not found' };
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function updateUserProfile(userId: string, updates: UserUpdate) {
  try {
    const [updatedRow] = await db.update(users).set(updates).where(eq(users.user_id, userId)).returning(USER_PROFILE_COLUMNS);
    if (!updatedRow) throw { code: 'PGRST116', message: 'Not found' };
    return { data: updatedRow, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}