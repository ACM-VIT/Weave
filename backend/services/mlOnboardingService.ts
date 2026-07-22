import crypto from 'node:crypto';

import type { MlOnboardingJob } from '../contracts/ml.v2.js';

export interface MlOnboardingProfileInput {
  username: string | null;
  fullName?: string | null;
  bio?: string | null;
  githubUsername?: string | null;
  avatarUrl?: string | null;
  interests?: readonly string[];
  skills?: readonly string[];
  techStack?: readonly string[];
}

function strings(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function optionalString(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  return normalized || null;
}

export function buildMlOnboardingJob(
  userId: string,
  profileVersion: number,
  input: MlOnboardingProfileInput,
  jobId = crypto.randomUUID(),
): MlOnboardingJob {
  return {
    job_id: jobId,
    user_id: userId,
    profile_version: profileVersion,
    profile: {
      username: optionalString(input.username),
      full_name: optionalString(input.fullName),
      bio: optionalString(input.bio),
      github_username: optionalString(input.githubUsername),
      avatar_url: optionalString(input.avatarUrl),
      interests: strings(input.interests),
      skills: strings(input.skills),
      tech_stack: strings(input.techStack),
    },
  };
}

/**
 * Names and account handles identify a user but do not provide enough semantic
 * material to construct a recommendation embedding. Empty identity-only jobs
 * are deferred until onboarding or a later profile update supplies context.
 */
export function hasMlEmbeddingContext(profile: Record<string, unknown>): boolean {
  if (typeof profile.bio === 'string' && profile.bio.trim().length > 0) return true;
  return ['interests', 'topics', 'skills', 'tech_stack'].some((key) => {
    const values = profile[key];
    return Array.isArray(values) && values.some((value) => typeof value === 'string' && value.trim().length > 0);
  });
}

export function isObsoleteIdentityOnboardingJob(payload: Record<string, unknown>): boolean {
  const profile = payload.profile;
  return payload.profile_version === 1
    && !!profile
    && typeof profile === 'object'
    && !Array.isArray(profile)
    && !hasMlEmbeddingContext(profile as Record<string, unknown>);
}
