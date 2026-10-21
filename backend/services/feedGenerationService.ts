import crypto from 'node:crypto';

import type { FeedPersistencePort } from '../ports/feedPersistencePort.js';
import type { RecommendationPort } from '../ports/recommendationPort.js';
import type { FeedQueuePort } from '../redis/feedQueue.js';
import { canonicalEntries } from './feedV2Service.js';

export type FeedGenerationOutcome =
  | { status: 'generated'; feedVersion: bigint; count: number }
  | { status: 'coalesced' | 'stale'; feedVersion: bigint };

export class FeedGenerationService {
  constructor(
    private readonly persistence: FeedPersistencePort,
    private readonly queue: FeedQueuePort,
    private readonly recommendations: RecommendationPort,
    private readonly queueTtlSeconds = 600,
    private readonly lockTtlMs = 15_000,
  ) {}

  async generate(
    userId: string,
    limit = 45,
    excludeRepoIds: string[] = [],
    mode: 'live' | 'prewarm' = 'live',
    sessionId?: string,
  ): Promise<FeedGenerationOutcome> {
    const feedVersion = await this.persistence.getFeedVersion(userId);
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
      const history = await this.persistence.listExcludedRepositoryIds(userId, sessionId, 500);
      const excluded = [...new Set([...excludeRepoIds, ...history])].slice(0, 500);
      const excludedIds = new Set(excluded);
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
        limit,
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
      });
      const projections = await this.persistence.listActiveRepositoryIdentities(items.map((item) => item.repo_id));
      const summaries = new Map(projections.map((repo) => [repo.repo_id, repo.summary_id]));
      if (projections.length !== items.length) throw new Error('ML returned unknown or inactive repositories.');
      await this.queue.replace(
        userId,
        feedVersion,
        canonicalEntries(items, response.model_version, summaries, generationId),
        this.queueTtlSeconds,
      );
      await this.persistence.recordGenerationAttempt?.({
        generation_id: generationId, user_id: userId, feed_version: feedVersion, mode,
        status: 'completed', latency_ms: Date.now() - started, result_count: items.length,
      });
      return { status: 'generated', feedVersion, count: items.length };
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
