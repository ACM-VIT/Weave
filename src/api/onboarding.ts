import { apiV2 } from './client';
import { buildOnboardingPayload } from '../utils/onboarding-payload';

export interface OnboardingData {
  username: string;
  full_name: string;
  bio?: string;
  github_url?: string;
  github_handle?: string;
  avatar_url?: string;
  interests?: string[];
  skills?: string[];
  tech_stack?: string[];
}

export async function setupOnboarding(token: string, data: OnboardingData) {
  try {
    await apiV2('/users/me', {
      method: 'PATCH',
      body: JSON.stringify({
        username: data.username,
        full_name: data.full_name,
        bio: data.bio ?? null,
        github_handle: data.github_handle ?? null,
        avatar_url: data.avatar_url ?? null,
      }),
    }, token);
  } catch (error) {
    if ((error as { status?: number }).status === 409) {
      throw new Error('That username is already taken. Go back and choose another username.');
    }
    throw error;
  }

  const payload = buildOnboardingPayload(data);
  return apiV2('/onboarding', {
    method: 'PUT',
    body: JSON.stringify(payload),
  }, token);
}
