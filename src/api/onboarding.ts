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
  avatar_url?: string;
  interests?: string[];
  skills?: string[];
  tech_stack?: string[];
}

export async function setupOnboarding(token: string, data: OnboardingData) {
  const generation = authSessionLifecycle.currentGeneration();
  const payload = buildOnboardingPayload(data);
  const profile = { username: data.username, full_name: data.full_name, date_of_birth: data.date_of_birth,
    avatar_url: data.avatar_url ?? null };
  try {
    try {
      const result = await apiV2<{ viewer: Record<string, unknown> }>('/onboarding/complete', {
        method: 'PUT', body: JSON.stringify({ ...payload, profile }),
      }, token);
      authSessionLifecycle.assertCurrent(generation);
      return result.viewer;
    } catch (error) {
      authSessionLifecycle.assertCurrent(generation);
      // New clients remain usable while the additive backend route rolls out.
      if ((error as { status?: number }).status !== 404) throw error;
    }
    await apiV2('/users/me', {
      method: 'PATCH',
      body: JSON.stringify({
        ...profile,
        bio: data.bio ?? null,
      }),
    }, token);
    authSessionLifecycle.assertCurrent(generation);
    await apiV2('/onboarding', { method: 'PUT', body: JSON.stringify(payload) }, token);
    authSessionLifecycle.assertCurrent(generation);
    const viewer = await apiV2<Record<string, unknown>>('/users/me', {}, token);
    authSessionLifecycle.assertCurrent(generation);
    return viewer;
  } catch (error) {
    if ((error as { status?: number }).status === 409) {
      throw new Error('That username is already taken. Go back and choose another username.');
    }
    throw error;
  }
}
