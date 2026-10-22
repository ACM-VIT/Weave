import type { RecommendationSource } from './recommendation';
import type { ReadmeDigest } from './readme-digest';
export type RepositoryReaction = 'like' | 'dislike' | null;
export type RepositoryStatus = 'active' | 'archived' | 'deleted' | 'blocked' | null;

export type RepositoryCount = number;

export type RepositoryStats = {
  stars: RepositoryCount;
  forks: RepositoryCount;
  openIssues: RepositoryCount;
  likes: RepositoryCount;
  dislikes: RepositoryCount;
  saves: RepositoryCount;
  comments: RepositoryCount;
  views: RepositoryCount;
};

/**
 * The single product-level repository contract used by every repository
 * surface. Feed-only attribution stays optional so it cannot become part of
 * the repository's canonical identity.
 */
export type RepositoryDetail = {
  trend?: { rank: number; score: number | null; features: Record<string, unknown>; period: string; capturedAt: string | null };
  id: string;
  githubId: string | null;
  fullName: string;
  name: string;
  owner: string;
  githubUrl: string;
  status: RepositoryStatus;
  description: string;
  summaryId: string | null;
  readmeSummary: string | null;
  readmeDigest?: ReadmeDigest | null;
  readmeFull: string | null;
  readmeSourcePath: string | null;
  readmeDefaultBranch: string | null;
  readmeBaseUrl: string | null;
  summaryHighlights: string[];
  summaryPromptVersion: string | null;
  summaryFormatVersion: string | null;
  summarySource: 'generated' | 'description_fallback' | null;
  languages: string[];
  topics: string[];
  primaryLanguage: string | null;
  stats: RepositoryStats;
  createdAt: string | null;
  updatedAt: string | null;
  observedAt: string | null;
  contentUpdatedAt: string | null;
  sourceUpdatedAt: string | null;
  contentVersion: number | null;
  summaryModelVersion: string | null;
  viewerReaction: RepositoryReaction;
  viewerSaved: boolean;
  selectedListIds: string[];
  ownerGithubId: string | null;
  ownerUserId: string | null;
  ownerUsername: string | null;
  ownerDisplayName: string | null;
  ownerAvatarUrl: string | null;
  ownerBio: string | null;
  ownerProfileId: string | null;
  ownerProfileKind: string | null;
  ownerProfileClaimedUserId: string | null;
  viewerFollowsOwner: boolean | null;
  recommendationSource?: RecommendationSource;
  serveId: string | null;
  feedPosition: number | null;
};

export type RepositoryCardData = RepositoryDetail;

export function repositoryDetailQueryKey(
  repositoryId: string,
  viewerUserId: string | null | undefined,
) {
  return ['repository-detail', viewerUserId ?? null, repositoryId] as const;
}
