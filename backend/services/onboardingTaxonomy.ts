import { ONBOARDING_SKILLS, ONBOARDING_INTERESTS, ONBOARDING_TAXONOMY_VERSION } from '../contracts/onboardingTaxonomy.js';

export interface StoredOnboardingTaxonomy {
  version: number;
  skills: { id: string; label: string }[];
  interests: { id: string; label: string }[];
}

export function canonicalSkillNames(values: readonly string[]): string[] {
  return values.map(value => ONBOARDING_SKILLS.find(skill => skill.id === value)?.title ?? value);
}

export function validateOnboardingTaxonomy(value: unknown): StoredOnboardingTaxonomy | null {
  if (value === undefined) return null;
  const invalid = () => Object.assign(new Error('Invalid onboarding taxonomy selections.'), { statusCode: 400 });
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const supplied = value as Record<string, unknown>;
  if (supplied.version !== ONBOARDING_TAXONOMY_VERSION) throw invalid();
  const resolve = (raw: unknown, entries: readonly { id: string; label: string }[]) => {
    if (!Array.isArray(raw) || raw.length > 50) throw invalid();
    const selected = new Map<string, { id: string; label: string }>();
    for (const item of raw) {
      if (!item || typeof item !== 'object') throw invalid();
      const record = item as Record<string, unknown>;
      const known = entries.find(entry => entry.id === record.id);
      if (!known || known.label !== record.label) throw invalid();
      selected.set(known.id, { ...known });
    }
    return [...selected.values()];
  };
  return { version: ONBOARDING_TAXONOMY_VERSION,
    skills: resolve(supplied.skills, ONBOARDING_SKILLS.map(skill => ({ id: skill.id, label: skill.title }))),
    interests: resolve(supplied.interests, ONBOARDING_INTERESTS.flatMap(category => category.interests.map(interest => ({ id: interest.id, label: interest.name })))),
  };
}
