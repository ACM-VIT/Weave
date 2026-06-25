import type {
  ParsedRepoUrl,
  RepoMetadata,
  Author,
  GitHubRepositoryResponse,
  GitHubReadmeResponse,
  GitHubRepositoryNode,
  GitHubCommitNode,
  GitHubUserProfile,
} from '../types/index.js';

const githubGraphqlUrl = 'https://api.github.com/graphql';
const githubRestBaseUrl = 'https://api.github.com';
const GITHUB_HANDLE_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}[a-zA-Z0-9])?$/;

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
    const payload = await response.json() as { message?: string; documentation_url?: string };

    if (payload.message) {
      return payload.message;
    }
  } catch (_err) {
    try {
      const text = await response.text();
      if (text.trim()) {
        return text;
      }
    } catch (_textErr) {
      // Fall through to fallback message.
    }
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

async function requestGitHubRest<T>(path: string): Promise<T> {
  const response = await fetch(`${githubRestBaseUrl}${path}`, {
    method: 'GET',
    headers: buildGitHubHeaders(),
  });

  if (!response.ok) {
    const message = await parseGitHubErrorMessage(response);
    throw new GitHubApiError(response.status, message);
  }

  return response.json() as Promise<T>;
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

export async function fetchGitHubUserProfile(githubHandle: string): Promise<GitHubUserProfile> {
  const normalizedHandle = githubHandle.trim();

  if (!normalizedHandle) {
    throw new GitHubApiError(400, 'GitHub handle is required.');
  }

  if (!GITHUB_HANDLE_REGEX.test(normalizedHandle)) {
    throw new GitHubApiError(400, 'Invalid GitHub handle format.');
  }

  const profile = await requestGitHubRest<GitHubUserProfile>(
    `/users/${encodeURIComponent(normalizedHandle)}`,
  );

  return {
    id: profile.id,
    login: profile.login,
    avatar_url: profile.avatar_url,
    html_url: profile.html_url,
    bio: profile.bio ?? null,
    name: profile.name ?? null,
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
