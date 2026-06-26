export interface ParsedRepoUrl {
  owner: string;
  repo: string;
}

export interface LanguageBreakdown {
  name: string;
  color: string | null;
  size: number;
  percentage: number;
}

export interface Author {
  login: string | null;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  profile_url: string | null;
}

export interface RepoMetadata {
  github_repo_url: string;
  repo_name: string;
  full_name: string;
  description: string | null;
  primary_language: { name: string; color: string | null } | null;
  language_breakdown: LanguageBreakdown[];
  topics: string[];
  readme: string;
  forks_count: number;
  stars_count: number;
  pr_count: number;
  default_branch: string | null;
  authors: Author[];
}

// GitHub GraphQL response types
export interface GitHubGraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{
    message: string;
    type?: string;
    path?: string[];
  }>;
}

export interface GitHubCommitAuthor {
  name: string | null;
  email: string | null;
  user: {
    login: string;
    avatarUrl: string;
    url: string;
  } | null;
}

export interface GitHubCommitNode {
  author: GitHubCommitAuthor | null;
}

export interface GitHubRepositoryNode {
  name: string;
  nameWithOwner: string;
  description: string | null;
  url: string;
  forkCount: number;
  stargazerCount: number;
  primaryLanguage: { name: string; color: string | null } | null;
  languages: {
    totalSize: number;
    edges: Array<{
      size: number;
      node: { name: string; color: string | null };
    }>;
  } | null;
  repositoryTopics: {
    nodes: Array<{ topic: { name: string } }>;
  } | null;
  pullRequests: { totalCount: number } | null;
  defaultBranchRef: {
    name: string;
    target: {
      history: {
        nodes: GitHubCommitNode[];
      };
    };
  } | null;
  readme: {
    text: string;
  } | null;
}

export interface GitHubRepositoryResponse {
  repository: GitHubRepositoryNode | null;
}

// REST API types
export interface GitHubReadmeResponse {
  content: string;
  encoding: string;
}

export interface GitHubUserProfile {
  id: number;
  login: string;
  avatar_url: string;
  html_url: string;
  bio: string | null;
  name: string | null;
}
