import { apiV2 } from './client';
import { buildOnboardingPayload } from '../utils/onboarding-payload';
import { authSessionLifecycle } from './session-lifecycle';

export interface OnboardingData {
  username: string;
  full_name: string;
  date_of_birth: string;
  bio?: string;
  github_url?: string;
  github_handle?: string;
  interests?: string[];
  skills?: string[];
  tech_stack?: string[];
}

export interface OnboardingCompletionResponse {
  completed: boolean;
  user_id?: string;
  username?: string;
  full_name?: string | null;
  date_of_birth?: string;
  bio?: string | null;
  avatar_url?: string | null;
  onboarding_completed?: boolean;
  [key: string]: unknown;
}

export async function setupOnboarding(token: string, data: OnboardingData, policy: { beforeSend?: () => void; expectedVersion?: string; onLegacyFallback?: () => void; allowLegacyFallback?: boolean } = {}) {
  const generation = authSessionLifecycle.currentGeneration();
  let preferences: ReturnType<typeof buildOnboardingPayload>;
  try { preferences = buildOnboardingPayload(data); }
  catch (error) {
    if (error instanceof Error) Object.assign(error, { status: 400 });
    throw error;
  }
  const profile = { username: data.username, full_name: data.full_name, date_of_birth: data.date_of_birth,
    ...(policy.expectedVersion !== undefined ? { expected_version: policy.expectedVersion } : {}) };
  try {
    try {
      const result = await apiV2<{ completed?: boolean; viewer: Record<string, unknown> }>('/onboarding/complete', {
        method: 'PUT', body: JSON.stringify({ ...preferences, profile }),
      }, token, policy);
      authSessionLifecycle.assertCurrent(generation);
      return { ...result.viewer, completed: result.completed ?? result.viewer?.onboarding_completed === true } as OnboardingCompletionResponse;
    } catch (error) {
      authSessionLifecycle.assertCurrent(generation);
      // Only a missing additive route permits the older-server write path.
      if ((error as { status?: number }).status !== 404 || policy.allowLegacyFallback === false) throw error;
    }
    policy.onLegacyFallback?.();
    const legacyProfile = { username: data.username, full_name: data.full_name, date_of_birth: data.date_of_birth };
    await apiV2('/users/me', {
      method: 'PATCH', body: JSON.stringify({ ...legacyProfile, ...(data.bio !== undefined ? { bio: data.bio } : {}) }),
    }, token, policy);
    authSessionLifecycle.assertCurrent(generation);
    await apiV2('/onboarding', { method: 'PUT', body: JSON.stringify(preferences) }, token, policy);
    authSessionLifecycle.assertCurrent(generation);
    const viewer = await apiV2<Record<string, unknown>>('/users/me', {}, token);
    authSessionLifecycle.assertCurrent(generation);
    return { ...viewer, completed: viewer.onboarding_completed === true } as OnboardingCompletionResponse;
  } catch (error) {
    if ((error as { status?: number }).status === 409) {
      throw Object.assign(new Error('That username is already taken. Go back and choose another username.'), { status: 409 });
    }
    throw error;
  }
}
