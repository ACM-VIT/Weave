import { ONBOARDING_SKILLS, ONBOARDING_INTERESTS, ONBOARDING_TAXONOMY_VERSION } from '../../backend/contracts/onboardingTaxonomy';
import { resolveOnboardingTaxonomy } from './onboardingTaxonomy';

export type OnboardingSelections = {
  bio?: string | null;
  interests?: string[];
  skills?: string[];
  tech_stack?: string[];
};

export type NormalizedOnboardingPayload = {
  bio?: string | null;
  topics: string[];
  interests: string[];
  skills: string[];
  tech_stack: string[];
  taxonomy_selections: ReturnType<typeof resolveOnboardingTaxonomy>['taxonomy_selections'] & { version: number };
};

const SPECIAL_SLUGS: Readonly<Record<string, string>> = {
  'c++': 'cpp',
  'c#': 'c-sharp',
  'f#': 'f-sharp',
};

export function normalizeOnboardingSlug(value: string): string {
  const input = value.trim().toLowerCase();
  const special = SPECIAL_SLUGS[input];
  if (special) return special;
  return input
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 50)
    .replace(/-+$/g, '');
}

function normalize(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map(normalizeOnboardingSlug).filter(Boolean))].slice(0, 50);
}

export function buildOnboardingPayload(data: OnboardingSelections): NormalizedOnboardingPayload {
  const bio = data.bio ?? '';
  if (bio.length > 2_000) throw new Error('Bio can contain at most 2000 characters.');

  const selections = resolveOnboardingTaxonomy(data, { skills: ONBOARDING_SKILLS, interests: ONBOARDING_INTERESTS });
  const interests = normalize(selections.interests);
  const skills = normalize(selections.skills);
  const techStack = normalize(data.tech_stack);
  const allTopics = [...new Set([...interests, ...skills, ...techStack])];
  if (allTopics.length > 100) {
    throw new Error('The combined onboarding profile may contain at most 100 unique slugs.');
  }
  if (allTopics.length === 0) {
    throw new Error('Choose at least one interest, skill, or technology.');
  }

  return {
    ...(data.bio === undefined ? {} : { bio: bio || null }),
    // The deployed backend still reads this legacy field. The new backend uses
    // the structured fields below, so sending both keeps the contract safe
    // during the rollout without losing category information.
    topics: allTopics.slice(0, 50),
    interests,
    skills,
    tech_stack: techStack,
    taxonomy_selections: { version: ONBOARDING_TAXONOMY_VERSION, ...selections.taxonomy_selections },
  };
}
