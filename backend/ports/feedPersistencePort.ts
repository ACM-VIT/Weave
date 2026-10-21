import type {
  CreateServeInput,
  RecommendationEntry,
  RepositoryProjection,
  StoredServe,
} from '../contracts/feed.v2.js';
import type { MlOnboardingJob } from '../contracts/ml.v2.js';

export type RepositoryIdentityProjection = Pick<RepositoryProjection, 'repo_id' | 'summary_id'>;

export interface FeedPersistencePort {
  getFeedVersion(userId: string): Promise<bigint>;
  getMlOnboardingJob?(userId: string): Promise<MlOnboardingJob | null>;
  listFollowedRepositoryIds(userId: string, limit: number): Promise<string[]>;
  getServeByRequest(userId: string, feedRequestId: string): Promise<StoredServe | null>;
  createServe(input: CreateServeInput): Promise<StoredServe>;
  listActiveRepositoryIdentities(repoIds: string[]): Promise<RepositoryIdentityProjection[]>;
  listActiveRepositories(repoIds: string[], viewerUserId?: string): Promise<RepositoryProjection[]>;
  getTrendingFallback(
    limit: number,
    excludeRepoIds: string[],
    viewerUserId?: string,
  ): Promise<RepositoryProjection[]>;
  getRecentPersonalizedEntries?(
    userId: string,
    feedVersion: bigint,
    limit: number,
    excludeRepoIds: string[],
  ): Promise<RecommendationEntry[]>;
  hasServe?(userId: string, feedRequestId: string): Promise<boolean>;
  recordGenerationAttempt?(input: {
    generation_id: string;
    user_id: string;
    feed_version: bigint;
    mode: 'live' | 'shadow' | 'prewarm';
    status: 'completed' | 'failed' | 'stale' | 'coalesced';
    latency_ms: number;
    result_count: number;
    error_code?: string;
  }): Promise<void>;
}
