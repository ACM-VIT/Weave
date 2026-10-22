import crypto from 'node:crypto';

import type { FeedPersistencePort } from '../ports/feedPersistencePort.js';
import type { RecommendationPort } from '../ports/recommendationPort.js';
import type { FeedQueuePort } from '../redis/feedQueue.js';
import { canonicalEntries } from './feedV2Service.js';

export interface IndexedFeedRefillPolicy {
  maxQueueDepth: number;
}

export interface FeedRefillRequest {
  expectedVersion: bigint;
  lowWatermark: number;
}

export type FeedGenerationOutcome =
  | { status: 'generated'; feedVersion: bigint; count: number }
  | { status: 'coalesced' | 'stale' | 'capacity'; feedVersion: bigint };

export class FeedGenerationService {
  constructor(
    private readonly persistence: FeedPersistencePort,
    private readonly queue: FeedQueuePort,
    private readonly recommendations: RecommendationPort,
    private readonly queueTtlSeconds = 600,
    private readonly lockTtlMs = 15_000,
    // Only supplied after all writers are upgraded and legacy reservations have
    // drained. Without that explicit rollout gate, retain the legacy live path.
    private readonly indexedRefill?: IndexedFeedRefillPolicy,
  ) {
    if (indexedRefill && (!Number.isInteger(indexedRefill.maxQueueDepth)
      || indexedRefill.maxQueueDepth < 2 || indexedRefill.maxQueueDepth > 100)) {
      throw new Error('Indexed feed queue target must be an integer between 2 and 100.');
    }
  }

  async generate(
    userId: string,
    limit = 45,
    excludeRepoIds: string[] = [],
    mode: 'live' | 'prewarm' = 'live',
    sessionId?: string,
    refill?: FeedRefillRequest,
  ): Promise<FeedGenerationOutcome> {
    const feedVersion = await this.persistence.getFeedVersion(userId);
    if (refill && (refill.expectedVersion !== feedVersion || !this.indexedRefill)) {
      return { status: 'stale', feedVersion };
    }
    const token = crypto.randomUUID();
    const generationId = crypto.randomUUID();
    const started = Date.now();
    if (!await this.queue.acquireGenerationLock(userId, feedVersion, token, this.lockTtlMs)) {
      await this.persistence.recordGenerationAttempt?.({
        generation_id: generationId, user_id: userId, feed_version: feedVersion, mode,
        status: 'coalesced', latency_ms: Date.now() - started, result_count: 0,
      });
      return { status: 'coalesced', feedVersion };
    }
    try {
      if (this.indexedRefill && (!this.queue.generationState || !this.queue.append)) {
        throw new Error('Indexed feed refill requires reservation-aware queue support.');
      }
      const state = this.indexedRefill
        ? await this.queue.generationState!(userId, feedVersion, token)
        : undefined;
      if (state === null) {
        await this.persistence.recordGenerationAttempt?.({
          generation_id: generationId, user_id: userId, feed_version: feedVersion, mode,
          status: 'coalesced', latency_ms: Date.now() - started, result_count: 0,
        });
        return { status: 'coalesced', feedVersion };
      }
      const generationLimit = this.indexedRefill
        ? Math.max(0, Math.min(limit, this.indexedRefill.maxQueueDepth - state!.remainingDepth,
          500 - state!.occupiedCount))
        : limit;
      if (generationLimit === 0) {
        // A full queue or outstanding reservations can exhaust the budget
        // temporarily. This is not evidence of an empty ML result/end of feed.
        await this.persistence.recordGenerationAttempt?.({
          generation_id: generationId, user_id: userId, feed_version: feedVersion, mode,
          status: 'coalesced', latency_ms: Date.now() - started, result_count: 0,
          error_code: 'FEED_RESERVATION_CAPACITY',
        });
        return { status: 'capacity', feedVersion };
      }
      if (refill && state!.remainingDepth >= refill.lowWatermark) {
        await this.persistence.recordGenerationAttempt?.({
          generation_id: generationId, user_id: userId, feed_version: feedVersion, mode,
          status: 'completed', latency_ms: Date.now() - started, result_count: 0,
        });
        return { status: 'generated', feedVersion, count: 0 };
      }
      const history = await this.persistence.listExcludedRepositoryIds(userId, sessionId, 500);
      // Keep the full bounded snapshot in the local filter even when ML's
      // request-side 500-ID limit cannot hold snapshot + history together.
      const excludedIds = new Set([
        ...(state?.excludedRepoIds ?? []), ...excludeRepoIds.slice(0, 500), ...history.slice(0, 500),
      ]);
      const excluded = [...excludedIds].slice(0, 500);
      let socialRepoIds: string[] = [];
      try {
        socialRepoIds = await this.persistence.listFollowedRepositoryIds(userId, 500);
      } catch (error) {
        console.error('[FeedGenerationService] Failed to load followed-owner repositories:', error);
      }
      const response = await this.recommendations.generate({
        schema_version: 2,
        generation_id: generationId,
        user_id: userId,
        feed_version: Number(feedVersion),
        limit: generationLimit,
        exclude_repo_ids: excluded,
        social_repo_ids: socialRepoIds,
        context: { cold_start: false },
      });
      if (await this.persistence.getFeedVersion(userId) !== feedVersion) {
        await this.persistence.recordGenerationAttempt?.({
          generation_id: generationId, user_id: userId, feed_version: feedVersion, mode,
          status: 'stale', latency_ms: Date.now() - started, result_count: response.items.length,
        });
        return { status: 'stale', feedVersion };
      }
      const seen = new Set<string>();
      const items = response.items.filter(item => {
        if (excludedIds.has(item.repo_id) || seen.has(item.repo_id)) return false;
        seen.add(item.repo_id); return true;
      }).slice(0, generationLimit);
      const projections = await this.persistence.listActiveRepositoryIdentities(items.map((item) => item.repo_id));
      const summaries = new Map(projections.map((repo) => [repo.repo_id, repo.summary_id]));
      if (projections.length !== items.length) throw new Error('ML returned unknown or inactive repositories.');
      // Identity hydration is asynchronous too; recheck invalidation immediately
      // before the final Redis lock-token fence and append.
      if (await this.persistence.getFeedVersion(userId) !== feedVersion) {
        await this.persistence.recordGenerationAttempt?.({
          generation_id: generationId, user_id: userId, feed_version: feedVersion, mode,
          status: 'stale', latency_ms: Date.now() - started, result_count: items.length,
        });
        return { status: 'stale', feedVersion };
      }
      const canonical = canonicalEntries(items, response.model_version, summaries, generationId);
      let count = items.length;
      if (this.indexedRefill) {
        const appended = await this.queue.append!(userId, feedVersion, token, canonical,
          this.queueTtlSeconds, this.indexedRefill.maxQueueDepth);
        if (appended === null) {
          await this.persistence.recordGenerationAttempt?.({
            generation_id: generationId, user_id: userId, feed_version: feedVersion, mode,
            status: 'coalesced', latency_ms: Date.now() - started, result_count: 0,
          });
          return { status: 'coalesced', feedVersion };
        }
        count = appended;
      } else {
        await this.queue.replace(userId, feedVersion, canonical, this.queueTtlSeconds);
      }
      await this.persistence.recordGenerationAttempt?.({
        generation_id: generationId, user_id: userId, feed_version: feedVersion, mode,
        status: 'completed', latency_ms: Date.now() - started, result_count: count,
      });
      return { status: 'generated', feedVersion, count };
    } catch (error) {
      await this.persistence.recordGenerationAttempt?.({
        generation_id: generationId, user_id: userId, feed_version: feedVersion, mode,
        status: 'failed', latency_ms: Date.now() - started, result_count: 0,
        error_code: (error instanceof Error ? error.message : String(error)).slice(0, 120),
      });
      throw error;
    } finally {
      await this.queue.releaseGenerationLock(userId, feedVersion, token);
    }
  }
}
