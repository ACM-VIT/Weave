import type { GitHubActivitySnapshot } from './githubActivityImport.js';
import { inferGitHubPersona } from './githubPersonaInference.js';
import { canonicalSkillNames } from './onboardingTaxonomy.js';
import { normalizeOnboardingTopic } from '../contracts/onboardingTaxonomy.js';
export type Preferences = { interests: string[]; skills: string[]; tech_stack: string[] };
const fields = ['interests', 'skills', 'tech_stack'] as const;
export function importedPreferences(snapshot: GitHubActivitySnapshot): Preferences {
  const inferred = inferGitHubPersona({ repositories: snapshot.repositories.map(repo => ({
    private: false, visibility: 'public', fork: repo.fork, topics: repo.topics, language: repo.primary_language,
  })) });
  return { interests: inferred.interests, skills: canonicalSkillNames(inferred.skills), tech_stack: inferred.tech_stack };
}
export function mergeImportedPreferences(baseline: Preferences, inferred: Preferences): Preferences {
  const result = structuredClone(baseline);
  const topicFor = (field: typeof fields[number], value: string) => normalizeOnboardingTopic(
    field === 'skills' ? canonicalSkillNames([value])[0] : value);
  const topics = new Set(fields.flatMap(field => baseline[field].map(value => topicFor(field, value))));
  for (const field of fields) {
    const known = new Set(result[field].map(value => topicFor(field, value)));
    for (const value of inferred[field]) {
      const topic = topicFor(field, value);
      if (known.has(topic) || result[field].length >= 50 || (!topics.has(topic) && topics.size >= 100)) continue;
      result[field].push(value); known.add(topic); topics.add(topic);
    }
  }
  return result;
}
