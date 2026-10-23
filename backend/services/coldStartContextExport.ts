import crypto from 'node:crypto';
import type { GitHubActivitySnapshot } from './githubActivityImport.js';
import { importedPreferences, mergeImportedPreferences } from './githubPreferenceProjection.js';
import { buildMlOnboardingJob, hasMlEmbeddingContext, type MlOnboardingProfileInput } from './mlOnboardingService.js';
import { isValidUuid } from '../utils/validators.js';

export interface ColdStartContextInput {
  schema_version: 1;
  profile_id: string;
  source_kind: 'controlled_fixture' | 'consented_profile';
  cutoff: string;
  manual_collected_at: string;
  github_consent_at: string;
  manual: MlOnboardingProfileInput;
  github: GitHubActivitySnapshot;
}
export function exportColdStartContexts(input: ColdStartContextInput) {
  const cutoff = Date.parse(input.cutoff);
  if (input.schema_version !== 1 || !isValidUuid(input.profile_id)
    || !['controlled_fixture', 'consented_profile'].includes(input.source_kind) || !Number.isFinite(cutoff)) {
    throw new Error('A versioned, provenance-tagged canonical profile input is required.');
  }
  const observed = [input.manual_collected_at, input.github_consent_at, input.github.collected_at,
    ...input.github.repositories.map(repo => repo.updated_at)].map(Date.parse);
  if (observed.some(value => !Number.isFinite(value) || value > cutoff)
    || Date.parse(input.github_consent_at) > Date.parse(input.github.collected_at)) {
    throw new Error('All observations must respect the consent and point-in-time cutoff.');
  }
  for (const values of [input.manual.interests, input.manual.skills, input.manual.techStack]) {
    if (values && (values.length > 50 || values.some(value => typeof value !== 'string' || value.length > 100))) {
      throw new Error('Manual context exceeds its bounded profile contract.');
    }
  }
  const manual = { interests: [...(input.manual.interests ?? [])], skills: [...(input.manual.skills ?? [])], tech_stack: [...(input.manual.techStack ?? [])] };
  const github = importedPreferences(input.github);
  const combined = mergeImportedPreferences(manual, github);
  return {
    schema_version: 1,
    purpose: 'cold_start_context_variants',
    evaluation_ready: false,
    evidence_limit: 'Context inputs only. Frozen corpus, real judgments and actual measured model runs are still required by the ML33 benchmark.',
    source_kind: input.source_kind, cutoff: input.cutoff,
    variants: (['onboarding_only', 'github_only', 'combined'] as const).map(variant => {
      const values = variant === 'onboarding_only' ? manual : variant === 'github_only' ? github : combined;
      const profile = buildMlOnboardingJob(input.profile_id, 1, { ...input.manual,
        bio: variant === 'github_only' ? null : input.manual.bio,
        interests: values.interests, skills: values.skills, techStack: values.tech_stack,
      }).profile;
      return { variant, profile_id: input.profile_id, context_sha256: crypto.createHash('sha256').update(JSON.stringify(profile)).digest('hex'),
        has_embedding_context: hasMlEmbeddingContext(profile), profile,
        provenance: { manual_collected_at: variant === 'github_only' ? null : input.manual_collected_at,
          github_consent_at: variant === 'onboarding_only' ? null : input.github_consent_at,
          github_collected_at: variant === 'onboarding_only' ? null : input.github.collected_at,
          github_sources: variant === 'onboarding_only' ? null : input.github.sources } };
    }),
  };
}
