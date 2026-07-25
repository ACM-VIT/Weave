import type {
  CreateServeInput,
  RepositoryProjection,
  StoredServe,
} from '../contracts/feed.v2.js';

export interface FeedPersistencePort {
  getFeedVersion(userId: string): Promise<bigint>;
  listFollowedRepositoryIds(userId: string, limit: number): Promise<string[]>;
  getServeByRequest(userId: string, feedRequestId: string): Promise<StoredServe | null>;
  createServe(input: CreateServeInput): Promise<StoredServe>;
  listActiveRepositories(repoIds: string[], viewerUserId?: string): Promise<RepositoryProjection[]>;
  getTrendingFallback(
    limit: number,
    excludeRepoIds: string[],
    viewerUserId?: string,
  ): Promise<RepositoryProjection[]>;
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
