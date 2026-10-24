import type { SocialCandidateProjection } from '../services/socialCandidateProjection.js';
import type {
  CreateServeInput,
  RecommendationEntry,
  RepositoryProjection,
  StoredServe,
} from '../contracts/feed.v2.js';
import type { MlOnboardingJob } from '../contracts/ml.v2.js';

export type RepositoryIdentityProjection = Pick<RepositoryProjection, 'repo_id' | 'summary_id'>;

export const MAX_FEED_SERVE_LOOKUP_BATCH = 100;

export interface FeedServeRequest {
  userId: string;
  requestId: string;
}

/** Reconciliation needs durable identities, never hydrated cards. */
export interface FeedReconciliationPersistencePort {
  getFeedVersion(userId: string): Promise<bigint>;
  hasServe(userId: string, feedRequestId: string): Promise<boolean>;
  listServedRequests(requests: FeedServeRequest[]): Promise<FeedServeRequest[]>;
}

export interface FeedGenerationContext { feedVersion: bigint; profileVersion: bigint; delivered: boolean; modelPolicySha256?:string }

/** A different request committed one of these session candidates first. */
export class FeedServeOverlapError extends Error {
  constructor() { super('Feed candidates were already delivered in this session.'); }
}

export class FeedPreferenceChangedError extends Error {
  constructor() { super('Current repository preferences changed; retry the feed request.'); }
}

export class FeedExposureChangedError extends Error {
  constructor() { super('A repository was recently delivered or impressed; retry with fresh candidates.'); }
}

export class FeedProvenanceDependencyError extends Error {
  constructor() { super('FEED_PROVENANCE_DEPENDENCY_UNAVAILABLE'); }
}

export class FeedProvenanceUnavailableError extends Error {
  constructor() { super('FEED_PROVENANCE_UNAVAILABLE'); }
}

export interface FeedPersistencePort {
  /** Current explicit negatives are independent of bounded exposure exclusions. */
  listPreferenceEligibleRepositoryIds(userId: string, repoIds: string[]): Promise<string[]>;
  /** Exact cross-session window check; implementations also fence at createServe. */
  listExposureEligibleRepositoryIds?(userId: string, repoIds: string[]): Promise<string[]>;
  getGenerationContext?(userId: string): Promise<FeedGenerationContext | null>;
  recordMlProfileDelivered?(userId: string, profileVersion: bigint): Promise<boolean>;
  hasServedFeed?(userId: string, feedVersion: bigint): Promise<boolean>;
  getFeedVersion(userId: string): Promise<bigint>;
  hasPublishedGeneration?(userId: string, feedVersion: bigint): Promise<boolean>;
  markGenerationPublished?(userId: string, feedVersion: bigint): Promise<void>;
  getMlOnboardingJob?(userId: string): Promise<MlOnboardingJob | null>;
  listExcludedRepositoryIds(userId: string, sessionId: string | undefined, limit: number): Promise<string[]>;
  /** Exact membership for a bounded candidate batch, without truncating session history. */
  listServedRepositoryIds?(userId: string, sessionId: string, repoIds: string[]): Promise<string[]>;
  listSocialRepositoryCandidates?(userId: string, limit: number, excludeRepoIds?: string[]): Promise<SocialCandidateProjection[]>;
  listFollowedRepositoryIds(userId: string, limit: number): Promise<string[]>;
  getServeByRequest(userId: string, feedRequestId: string): Promise<StoredServe | null>;
  createServe(input: CreateServeInput): Promise<StoredServe>;
  listActiveRepositoryIdentities(repoIds: string[]): Promise<RepositoryIdentityProjection[]>;
  listActiveRepositories(repoIds: string[], viewerUserId?: string): Promise<RepositoryProjection[]>;
  /** Fresh active cards for this viewer; callers may reuse them within the requesting serve only. */
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
    sessionId?: string,
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
