import { apiV2 } from './client';

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

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

export async function setupOnboarding(token: string, data: OnboardingData) {
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
  const normalize = (values: string[] | undefined) =>
    [...new Set((values ?? []).map(slug).filter(Boolean))];
  const interests = normalize(data.interests);
  const skills = normalize(data.skills);
  const techStack = normalize(data.tech_stack);
  if (interests.length + skills.length + techStack.length === 0) {
    throw new Error('Choose at least one interest, skill, or technology.');
  }
  return apiV2('/onboarding', {
    method: 'PUT',
    body: JSON.stringify({
      interests,
      skills,
      tech_stack: techStack,
      bio: data.bio ?? null,
    }),
  }, token);
}
