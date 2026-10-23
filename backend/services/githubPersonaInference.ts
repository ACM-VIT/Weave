import type { GitHubInferredPersona, GitHubPersonaSkillId } from '../types/github.js';
import { GITHUB_PERSONA_SKILL_IDS } from '../types/github.js';

const MAX_INTERESTS = 50;
const MAX_TECH_STACK = 25;

const SPECIAL_SLUGS: Readonly<Record<string, string>> = {
  'c++': 'cpp',
  cplusplus: 'cpp',
  cpp: 'cpp',
  'c#': 'c-sharp',
  csharp: 'c-sharp',
  'c-sharp': 'c-sharp',
  'f#': 'f-sharp',
  fsharp: 'f-sharp',
  'f-sharp': 'f-sharp',
  'objective c': 'objective-c',
  'objective-c': 'objective-c',
  objectivec: 'objective-c',
};

const SKILL_EVIDENCE: Readonly<Record<GitHubPersonaSkillId, readonly string[]>> = {
  web: [
    'react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxt', 'frontend', 'ui', 'component',
    'tailwind', 'css', 'html', 'browser', 'dom', 'javascript', 'typescript', 'web',
  ],
  backend: [
    'express', 'django', 'flask', 'fastapi', 'spring', 'asp-net', 'rails', 'backend',
    'rest', 'graphql', 'api', 'microservice', 'server', 'middleware', 'rpc', 'grpc',
    'python', 'java', 'c-sharp', 'f-sharp', 'php', 'ruby', 'elixir', 'scala', 'node',
  ],
  data: [
    'tensorflow', 'pytorch', 'keras', 'scikit-learn', 'pandas', 'numpy', 'spark',
    'hadoop', 'airflow', 'kafka', 'machine-learning', 'deep-learning', 'neural-network',
    'data-pipeline', 'etl', 'llm', 'rag', 'vector-database', 'model', 'data', 'python',
    'jupyter-notebook', 'julia', 'r',
  ],
  devops: [
    'docker', 'kubernetes', 'terraform', 'ansible', 'jenkins', 'github-actions', 'ci-cd',
    'aws', 'gcp', 'azure', 'cloud', 'infrastructure', 'security', 'authentication',
    'oauth', 'deployment', 'container', 'shell', 'dockerfile', 'hcl', 'nix',
  ],
  databases: [
    'mysql', 'postgresql', 'mongodb', 'redis', 'cassandra', 'elasticsearch', 'database',
    'sql', 'nosql', 'orm', 'storage', 'cache', 'plpgsql', 't-sql',
  ],
  mobile: [
    'react-native', 'flutter', 'swift', 'kotlin', 'android', 'ios', 'mobile',
    'cross-platform', 'xamarin', 'ionic', 'objective-c', 'dart',
  ],
  systems: [
    'rust', 'cpp', 'c', 'go', 'assembly', 'embedded', 'os', 'kernel', 'system',
    'performance', 'memory-management', 'compiler', 'webassembly', 'wasm', 'zig',
  ],
};

export function normalizeGitHubPersonaSlug(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[‐‑‒–—]/g, '-')
    .trim()
    .toLowerCase();
  const special = SPECIAL_SLUGS[normalized];
  if (special) return special;
  return normalized
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 50)
    .replace(/-+$/g, '');
}

function increment(score: Map<string, number>, value: string): void {
  const slug = normalizeGitHubPersonaSlug(value);
  if (slug) score.set(slug, (score.get(slug) ?? 0) + 1);
}

function ranked(score: Map<string, number>, limit: number): string[] {
  return [...score.entries()]
    .sort(([leftSlug, leftScore], [rightSlug, rightScore]) =>
      rightScore - leftScore || (leftSlug < rightSlug ? -1 : leftSlug > rightSlug ? 1 : 0))
    .slice(0, limit)
    .map(([slug]) => slug);
}

function containsEvidence(candidate: string, evidence: string): boolean {
  if (evidence.length === 1) return candidate === evidence;
  return candidate === evidence
    || candidate.startsWith(`${evidence}-`)
    || candidate.endsWith(`-${evidence}`)
    || candidate.includes(`-${evidence}-`);
}

export function inferGitHubPersona(source: { repositories: readonly {
  fork: boolean; private?: boolean; visibility?: string; topics: string[]; language: string | null;
}[] }): GitHubInferredPersona {
  const interestScores = new Map<string, number>();
  const languageScores = new Map<string, number>();

  for (const repository of source.repositories) {
    if (repository.fork || repository.private || repository.visibility === 'private') continue;
    const topics = repository.topics
      .map(normalizeGitHubPersonaSlug)
      .filter(Boolean);
    if (topics.length > 0) {
      for (const topic of new Set(topics)) increment(interestScores, topic);
    } else if (repository.language) {
      increment(interestScores, repository.language);
    }
    if (repository.language) increment(languageScores, repository.language);
  }

  const interests = ranked(interestScores, MAX_INTERESTS);
  const techStack = ranked(languageScores, MAX_TECH_STACK);
  const evidence = new Set([...interests, ...techStack]);
  const skills = GITHUB_PERSONA_SKILL_IDS.filter((skill) =>
    SKILL_EVIDENCE[skill].some((keyword) =>
      [...evidence].some((candidate) => containsEvidence(candidate, keyword))));

  return { interests, skills, tech_stack: techStack };
}
