import type {
  ParsedRepoUrl,
  RepoMetadata,
  Author,
  GitHubRepositoryResponse,
  GitHubReadmeResponse,
  GitHubRepositoryNode,
  GitHubCommitNode,
  GitHubUserProfile,
  GitHubPublicPersonaSource,
  GitHubPublicRepository,
} from '../types/index.js';

const githubGraphqlUrl = 'https://api.github.com/graphql';
const githubRestBaseUrl = 'https://api.github.com';
const GITHUB_HANDLE_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}[a-zA-Z0-9])?$/;
const DEFAULT_GITHUB_PERSONA_TIMEOUT_MS = 8_000;

export class ServerConfigError extends Error {
  statusCode: number;

  constructor(message: string) {
    super(message);
    this.name = 'ServerConfigError';
    this.statusCode = 500;
  }
}

export class GitHubApiError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'GitHubApiError';
    this.statusCode = statusCode;
  }
}

function buildGitHubHeaders(): HeadersInit {
  if (!process.env.GITHUB_TOKEN) {
    throw new ServerConfigError('Missing GITHUB_TOKEN in environment.');
  }

  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export function parseGitHubRepoUrl(repoUrl: string): ParsedRepoUrl | null {
  try {
    const url = new URL(repoUrl);

    if (url.hostname !== 'github.com') {
      return null;
    }

    const [owner, repo] = url.pathname.replace(/^\/|\/$/g, '').split('/');

    if (!owner || !repo) {
      return null;
    }

    return {
      owner,
      repo: repo.replace(/\.git$/i, ''),
    };
  } catch (_err) {
    return null;
  }
}

const repoMetadataQuery = `
  query RepoMetadata($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      name
      nameWithOwner
      description
      url
      forkCount
      stargazerCount
      primaryLanguage {
        name
        color
      }
      languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
        totalSize
        edges {
          size
          node {
            name
            color
          }
        }
      }
      repositoryTopics(first: 20) {
        nodes {
          topic {
            name
          }
        }
      }
      pullRequests {
        totalCount
      }
      issues(states: OPEN) {
        totalCount
      }
      defaultBranchRef {
        name
        target {
          ... on Commit {
            history(first: 20) {
              nodes {
                author {
                  name
                  email
                  user {
                    login
                    avatarUrl
                    url
                  }
                }
              }
            }
          }
        }
      }
      readme: object(expression: "HEAD:README.md") {
        ... on Blob {
          text
        }
      }
    }
  }
`;

async function parseGitHubErrorMessage(response: Response): Promise<string> {
  const fallback = `GitHub API request failed with status ${response.status}.`;

  try {
    const text = await response.text();
    if (!text.trim()) return fallback;
    try {
      const payload = JSON.parse(text) as { message?: string };
      if (payload.message) return payload.message;
    } catch {
      return text;
    }
  } catch {
    // Fall through to the status-based message.
  }

  return fallback;
}

async function requestGitHubGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(githubGraphqlUrl, {
    method: 'POST',
    headers: buildGitHubHeaders(),
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const message = await parseGitHubErrorMessage(response);
    throw new GitHubApiError(response.status, message);
  }

  const payload = await response.json() as { data: T; errors?: Array<{ message: string }> };

  if (payload.errors && payload.errors.length > 0) {
    const message = payload.errors.map((error) => error.message).join('; ');
    throw new GitHubApiError(502, `GitHub GraphQL error: ${message}`);
  }

  return payload.data;
}

async function requestGitHubRest<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${githubRestBaseUrl}${path}`, {
      method: 'GET',
      headers: buildGitHubHeaders(),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new GitHubApiError(504, 'GitHub API request timed out or was cancelled.');
    }
    const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
    throw new GitHubApiError(502, `GitHub API request failed${detail}`);
  }

  if (!response.ok) {
    const message = await parseGitHubErrorMessage(response);
    throw new GitHubApiError(response.status, message);
  }

  return response.json() as Promise<T>;
}

function normalizeGitHubProfile(value: unknown): GitHubUserProfile {
  if (!value || typeof value !== 'object') {
    throw new GitHubApiError(502, 'GitHub returned an invalid user profile.');
  }
  const profile = value as Partial<GitHubUserProfile>;
  if (!Number.isSafeInteger(profile.id) || Number(profile.id) <= 0
    || typeof profile.login !== 'string' || !GITHUB_HANDLE_REGEX.test(profile.login)
    || typeof profile.avatar_url !== 'string' || typeof profile.html_url !== 'string') {
    throw new GitHubApiError(502, 'GitHub returned an invalid user profile.');
  }
  return {
    id: Number(profile.id),
    login: profile.login,
    avatar_url: profile.avatar_url,
    html_url: profile.html_url,
    bio: typeof profile.bio === 'string' ? profile.bio : null,
    name: typeof profile.name === 'string' ? profile.name : null,
    followers: Number.isSafeInteger(profile.followers) && Number(profile.followers) >= 0
      ? Number(profile.followers) : 0,
    following: Number.isSafeInteger(profile.following) && Number(profile.following) >= 0
      ? Number(profile.following) : 0,
  };
}

function normalizeGitHubRepositories(value: unknown, githubHandle: string): GitHubPublicRepository[] {
  if (!Array.isArray(value)) {
    throw new GitHubApiError(502, 'GitHub returned an invalid repository list.');
  }
  const normalizedHandle = githubHandle.toLowerCase();
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .filter((entry) => entry.fork !== true && entry.private !== true && entry.visibility !== 'private')
    .filter((entry) => {
      const owner = entry.owner;
      if (!owner || typeof owner !== 'object' || !('login' in owner)) return true;
      return typeof owner.login === 'string' && owner.login.toLowerCase() === normalizedHandle;
    })
    .slice(0, 100)
    .map((entry) => ({
      id: Number.isSafeInteger(entry.id) ? Number(entry.id) : 0,
      name: typeof entry.name === 'string' ? entry.name : '',
      full_name: typeof entry.full_name === 'string' ? entry.full_name : '',
      fork: false,
      private: false,
      visibility: typeof entry.visibility === 'string' ? entry.visibility : 'public',
      language: typeof entry.language === 'string' ? entry.language : null,
      topics: Array.isArray(entry.topics)
        ? entry.topics.filter((topic): topic is string => typeof topic === 'string')
        : [],
      updated_at: typeof entry.updated_at === 'string' ? entry.updated_at : '',
      ...(entry.owner && typeof entry.owner === 'object' && 'login' in entry.owner
        && typeof entry.owner.login === 'string'
        ? { owner: { login: entry.owner.login } }
        : {}),
    }));
}

function githubHandle(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new GitHubApiError(400, 'GitHub handle is required.');
  if (!GITHUB_HANDLE_REGEX.test(normalized)) {
    throw new GitHubApiError(400, 'Invalid GitHub handle format.');
  }
  return normalized;
}

function personaRequestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError('GitHub persona timeout must be between 1 and 60000 milliseconds.');
  }
  const timeoutSignal = AbortSignal.timeout(Math.floor(timeoutMs));
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function getUniqueAuthors(historyNodes: GitHubCommitNode[] = []): Author[] {
  const authors = new Map<string, Author>();

  historyNodes.forEach((node) => {
    const author = node.author;

    if (!author) {
      return;
    }

    const key = author.user?.login || author.email || author.name;

    if (!key || authors.has(key)) {
      return;
    }

    authors.set(key, {
      login: author.user?.login || null,
      name: author.name || null,
      email: author.email || null,
      avatar_url: author.user?.avatarUrl || null,
      profile_url: author.user?.url || null,
    });
  });

  return Array.from(authors.values());
}

function formatRepositoryMetadata(repository: GitHubRepositoryNode): RepoMetadata {
  const languageEdges = repository.languages?.edges || [];
  const totalLanguageSize = repository.languages?.totalSize || 0;
  const historyNodes = repository.defaultBranchRef?.target?.history?.nodes || [];

  return {
    github_repo_url: repository.url,
    repo_name: repository.name,
    full_name: repository.nameWithOwner,
    description: repository.description,
    primary_language: repository.primaryLanguage
      ? {
          name: repository.primaryLanguage.name,
          color: repository.primaryLanguage.color,
        }
      : null,
    language_breakdown: languageEdges.map((edge) => ({
      name: edge.node.name,
      color: edge.node.color,
      size: edge.size,
      percentage:
        totalLanguageSize > 0
          ? Number(((edge.size / totalLanguageSize) * 100).toFixed(2))
          : 0,
    })),
    topics:
      repository.repositoryTopics?.nodes?.map((node) => node.topic.name) || [],
    readme: repository.readme?.text || '',
    forks_count: repository.forkCount || 0,
    stars_count: repository.stargazerCount || 0,
    pr_count: repository.pullRequests?.totalCount || 0,
    default_branch: repository.defaultBranchRef?.name || null,
    authors: getUniqueAuthors(historyNodes),
  };
}

async function fetchReadmeFromGitHubRest(owner: string, repo: string): Promise<string> {
  try {
    const data = await requestGitHubRest<GitHubReadmeResponse>(`/repos/${owner}/${repo}/readme`);

    if (!data.content) {
      return '';
    }

    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (_err) {
    return '';
  }
}

export async function fetchGitHubUserProfile(
  value: string,
  signal?: AbortSignal,
): Promise<GitHubUserProfile> {
  const normalizedHandle = githubHandle(value);
  const profile = await requestGitHubRest<unknown>(
    `/users/${encodeURIComponent(normalizedHandle)}`,
    signal,
  );
  return normalizeGitHubProfile(profile);
}

export async function fetchGitHubPublicPersona(
  value: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<GitHubPublicPersonaSource> {
  const normalizedHandle = githubHandle(value);
  const signal = personaRequestSignal(
    options.timeoutMs ?? DEFAULT_GITHUB_PERSONA_TIMEOUT_MS,
    options.signal,
  );
  const encodedHandle = encodeURIComponent(normalizedHandle);
  const [rawProfile, rawRepositories] = await Promise.all([
    requestGitHubRest<unknown>(`/users/${encodedHandle}`, signal),
    requestGitHubRest<unknown>(
      `/users/${encodedHandle}/repos?type=owner&sort=updated&direction=desc&per_page=100&page=1`,
      signal,
    ),
  ]);
  return {
    profile: normalizeGitHubProfile(rawProfile),
    repositories: normalizeGitHubRepositories(rawRepositories, normalizedHandle),
  };
}

export async function fetchRepoMetadataFromGitHub(owner: string, repo: string): Promise<RepoMetadata> {
  const data = await requestGitHubGraphql<GitHubRepositoryResponse>(repoMetadataQuery, {
    owner,
    name: repo,
  });

  if (!data.repository) {
    throw new GitHubApiError(404, 'GitHub repository not found.');
  }

  const metadata = formatRepositoryMetadata(data.repository);

  if (!metadata.readme) {
    metadata.readme = await fetchReadmeFromGitHubRest(owner, repo);
  }

  return metadata;
}
