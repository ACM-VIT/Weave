import assert from 'node:assert/strict';
import test from 'node:test';

import type { MlOnboardingJob } from '../../contracts/ml.v2.js';
import type {
  GitHubInferredPersona,
  GitHubPublicPersonaSource,
  GitHubPublicRepository,
} from '../../types/github.js';
import { GitHubApiError, fetchGitHubPublicPersona } from '../../services/githubService.js';
import {
  inferGitHubPersona,
  normalizeGitHubPersonaSlug,
  persistGitHubPersona,
  planGitHubPersonaUpdate,
  type GitHubPersonaProfileUpdate,
  type GitHubPersonaTransactionStore,
  type StoredGitHubPersonaProfile,
} from '../../services/githubPersonaService.js';

const USER_ID = '00000000-0000-4000-8000-000000000901';

function repository(
  language: string | null,
  topics: string[] = [],
  overrides: Partial<GitHubPublicRepository> = {},
): GitHubPublicRepository {
  return {
    id: 1,
    name: 'repo',
    full_name: 'octocat/repo',
    fork: false,
    private: false,
    visibility: 'public',
    language,
    topics,
    updated_at: '2026-07-22T00:00:00.000Z',
    owner: { login: 'octocat' },
    ...overrides,
  };
}

function source(repositories: GitHubPublicRepository[]): GitHubPublicPersonaSource {
  return {
    profile: {
      id: 1234,
      login: 'octocat',
      avatar_url: 'https://avatars.githubusercontent.com/u/1234',
      html_url: 'https://github.com/octocat',
      bio: 'Builds developer tools',
      name: 'The Octocat',
      followers: 10,
      following: 2,
    },
    repositories,
  };
}

test('persona slug normalization preserves languages whose punctuation carries meaning', () => {
  assert.equal(normalizeGitHubPersonaSlug('C++'), 'cpp');
  assert.equal(normalizeGitHubPersonaSlug('C#'), 'c-sharp');
  assert.equal(normalizeGitHubPersonaSlug('Objective-C'), 'objective-c');
  assert.equal(normalizeGitHubPersonaSlug('Objective C'), 'objective-c');
  assert.equal(normalizeGitHubPersonaSlug('F#'), 'f-sharp');
  assert.equal(normalizeGitHubPersonaSlug('Machine Learning'), 'machine-learning');
});

test('persona inference prefers topics per repository, falls back to languages, and ignores forks', () => {
  const repositories = [
    repository('TypeScript', ['React', 'GraphQL']),
    repository('Python'),
    repository('C++', ['compiler']),
    repository('C#'),
    repository('Objective-C'),
    repository('F#'),
    repository('Rust', ['embedded'], { fork: true }),
  ];
  const persona = inferGitHubPersona(source(repositories));

  assert.deepEqual(persona.interests, [
    'c-sharp', 'compiler', 'f-sharp', 'graphql', 'objective-c', 'python', 'react',
  ]);
  assert.deepEqual(persona.tech_stack, [
    'c-sharp', 'cpp', 'f-sharp', 'objective-c', 'python', 'typescript',
  ]);
  assert.deepEqual(persona.skills, ['web', 'backend', 'data', 'mobile', 'systems']);
  assert.deepEqual(inferGitHubPersona(source([...repositories].reverse())), persona);
});

class MemoryPersonaStore implements GitHubPersonaTransactionStore {
  readonly topics = new Set<string>();
  readonly jobs = new Map<string, MlOnboardingJob>();
  updateCalls = 0;

  constructor(public profile: StoredGitHubPersonaProfile, topics: string[] = []) {
    topics.forEach((topic) => this.topics.add(topic));
  }

  async lockProfile(): Promise<StoredGitHubPersonaProfile> {
    return structuredClone(this.profile);
  }

  async listTopicSlugs(): Promise<string[]> {
    return [...this.topics].sort();
  }

  async updateProfile(_userId: string, update: GitHubPersonaProfileUpdate): Promise<bigint> {
    this.updateCalls += 1;
    this.profile = {
      ...this.profile,
      fullName: update.fullName,
      bio: update.bio,
      githubId: update.githubId,
      githubHandle: update.githubHandle,
      avatarUrl: update.avatarUrl,
      interests: [...update.interests],
      skills: [...update.skills],
      techStack: [...update.techStack],
      profileVersion: this.profile.profileVersion + 1n,
    };
    return this.profile.profileVersion;
  }

  async ensureUserTopic(_userId: string, slug: string): Promise<boolean> {
    const existed = this.topics.has(slug);
    this.topics.add(slug);
    return !existed;
  }

  async enqueueOnboarding(
    userId: string,
    profileVersion: bigint,
    job: MlOnboardingJob,
  ): Promise<boolean> {
    const key = `onboard:${userId}:${profileVersion}`;
    if (this.jobs.has(key)) return false;
    this.jobs.set(key, job);
    return true;
  }
}

function emptyStoredProfile(): StoredGitHubPersonaProfile {
  return {
    username: 'octocat-00000000',
    fullName: null,
    bio: null,
    githubId: null,
    githubHandle: null,
    avatarUrl: null,
    interests: [],
    skills: [],
    techStack: [],
    onboardingCompleted: false,
    profileVersion: 1n,
  };
}

test('transactional persistence seeds persona topics, versions once, and enqueues semantic ML work', async () => {
  const store = new MemoryPersonaStore(emptyStoredProfile());
  const persona: GitHubInferredPersona = {
    interests: ['react', 'graphql'],
    skills: ['web', 'backend'],
    tech_stack: ['typescript'],
  };
  const first = await persistGitHubPersona(store, USER_ID, source([]), persona);

  assert.equal(first.changed, true);
  assert.equal(first.profileVersion, '2');
  assert.equal(first.topicsAdded, 5);
  assert.equal(first.enqueued, true);
  assert.deepEqual([...store.topics], ['backend', 'graphql', 'react', 'typescript', 'web']);
  const job = store.jobs.get(`onboard:${USER_ID}:2`);
  assert.ok(job);
  assert.deepEqual(job.profile.interests, ['react', 'graphql']);
  assert.deepEqual(job.profile.skills, ['web', 'backend']);
  assert.deepEqual(job.profile.tech_stack, ['typescript']);

  const second = await persistGitHubPersona(store, USER_ID, source([]), persona);
  assert.equal(second.changed, false);
  assert.equal(second.profileVersion, '2');
  assert.equal(second.topicsAdded, 0);
  assert.equal(second.enqueued, false);
  assert.equal(store.updateCalls, 1);
});

test('update planning preserves every nonempty manual array and leaves existing user topics untouched', () => {
  const existing: StoredGitHubPersonaProfile = {
    ...emptyStoredProfile(),
    fullName: 'The Octocat',
    bio: 'Builds developer tools',
    githubId: '1234',
    githubHandle: 'octocat',
    avatarUrl: 'https://avatars.githubusercontent.com/u/1234',
    interests: ['manual-interest'],
    skills: ['devops'],
    techStack: ['manual-stack'],
    onboardingCompleted: true,
    profileVersion: 7n,
  };
  const inferred: GitHubInferredPersona = {
    interests: ['inferred-interest'],
    skills: ['web'],
    tech_stack: ['typescript'],
  };
  const plan = planGitHubPersonaUpdate(existing, ['manual-topic'], source([]), inferred);

  assert.deepEqual(plan.update.interests, ['manual-interest']);
  assert.deepEqual(plan.update.skills, ['devops']);
  assert.deepEqual(plan.update.techStack, ['manual-stack']);
  assert.deepEqual(plan.topicSlugsToInsert, []);
  assert.equal(plan.materialChange, false);
  assert.equal(plan.nextProfileVersion, 7n);
});

test('GitHub persona sync never completes explicit onboarding', async () => {
  const existing = emptyStoredProfile();
  existing.fullName = 'The Octocat';
  existing.bio = 'Builds developer tools';
  existing.githubId = '1234';
  existing.githubHandle = 'octocat';
  existing.avatarUrl = 'https://avatars.githubusercontent.com/u/1234';
  const store = new MemoryPersonaStore(existing);

  const result = await persistGitHubPersona(store, USER_ID, source([]), {
    interests: [],
    skills: [],
    tech_stack: [],
  });

  assert.equal(result.changed, false);
  assert.equal(result.profileVersion, '1');
  assert.equal(store.profile.onboardingCompleted, false);
  assert.equal(store.updateCalls, 0);
});

test('GitHub persona REST fetch uses one timeout signal, caps owned public repos, and rejects failures', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_TOKEN as string | undefined;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  process.env.GITHUB_TOKEN = 'test-token';
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/users/octocat')) {
      return new Response(JSON.stringify(source([]).profile), { status: 200 });
    }
    return new Response(JSON.stringify([
      repository('TypeScript'),
      repository('Rust', [], { id: 2, fork: true }),
      repository('Go', [], { id: 3, private: true, visibility: 'private' }),
      repository('Python', [], { id: 4, owner: { login: 'someone-else' } }),
    ]), { status: 200 });
  };

  try {
    const fetched = await fetchGitHubPublicPersona('octocat', { timeoutMs: 1_000 });
    assert.equal(fetched.repositories.length, 1);
    assert.equal(fetched.repositories[0].language, 'TypeScript');
    const repositoryCall = calls.find((call) => call.url.includes('/repos?'));
    assert.ok(repositoryCall);
    const repositoryUrl = new URL(repositoryCall.url);
    assert.equal(repositoryUrl.searchParams.get('type'), 'owner');
    assert.equal(repositoryUrl.searchParams.get('sort'), 'updated');
    assert.equal(repositoryUrl.searchParams.get('per_page'), '100');
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.init?.signal instanceof AbortSignal));
    assert.equal(calls[0].init?.signal, calls[1].init?.signal);

    globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    await assert.rejects(
      fetchGitHubPublicPersona('octocat', { timeoutMs: 5 }),
      (error: unknown) => error instanceof GitHubApiError && error.statusCode === 504,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) Reflect.deleteProperty(process.env, 'GITHUB_TOKEN');
    else process.env.GITHUB_TOKEN = originalToken;
  }
});
