import crypto from 'node:crypto';

import type { FeedPersistencePort } from '../ports/feedPersistencePort.js';
import type { RecommendationPort } from '../ports/recommendationPort.js';
import type { FeedQueuePort } from '../redis/feedQueue.js';
import { incrementMetric } from '../observability/metrics.js';
import { canonicalEntries } from './feedV2Service.js';
import { isMissingPersonaRecommendationError } from './mlService.js';
import type { PersonaRepairService } from './personaRepairService.js';

export class FeedGenerationService {
  constructor(
    private readonly persistence: FeedPersistencePort,
    private readonly queue: FeedQueuePort,
    private readonly recommendations: RecommendationPort,
    private readonly queueTtlSeconds = 600,
    private readonly lockTtlMs = 15_000,
    private readonly personaRepair?: Pick<PersonaRepairService, 'repair'>,
  ) {}

  async generate(
    userId: string,
    limit = 45,
    excludeRepoIds: string[] = [],
    mode: 'live' | 'prewarm' = 'live',
  ): Promise<'generated' | 'coalesced' | 'stale'> {
    const feedVersion = await this.persistence.getFeedVersion(userId);
    const token = crypto.randomUUID();
    const generationId = crypto.randomUUID();
    const started = Date.now();
    if (!await this.queue.acquireGenerationLock(userId, feedVersion, token, this.lockTtlMs)) {
      await this.persistence.recordGenerationAttempt?.({
        generation_id: generationId, user_id: userId, feed_version: feedVersion, mode,
        status: 'coalesced', latency_ms: Date.now() - started, result_count: 0,
      });
      return 'coalesced';
    }
    let leaseLost = false;
    let renewal: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewal || leaseLost) return;
      renewal = this.queue.renewGenerationLock(userId, feedVersion, token, this.lockTtlMs)
        .then(owned => { if (!owned) leaseLost = true; })
        .catch(() => { leaseLost = true; })
        .finally(() => { renewal = undefined; });
    }, Math.max(1, Math.floor(this.lockTtlMs / 3)));
    heartbeat.unref();
    try {
      let socialRepoIds: string[] = [];
      try {
        socialRepoIds = await this.persistence.listFollowedRepositoryIds(userId, 500);
      } catch (error) {
        console.error('[FeedGenerationService] Failed to load followed-owner repositories:', error);
      }
      const request = {
        schema_version: 2,
        generation_id: generationId,
        user_id: userId,
        feed_version: Number(feedVersion),
        limit,
        exclude_repo_ids: excludeRepoIds,
        social_repo_ids: socialRepoIds,
        context: { cold_start: false },
      } as const;
      let response: Awaited<ReturnType<RecommendationPort['generate']>>;
      try {
        response = await this.recommendations.generate(request);
      } catch (error) {
        if (!this.personaRepair || !isMissingPersonaRecommendationError(error)) throw error;
        incrementMetric('feed_v2_persona_repairs_total');
        await this.personaRepair.repair(userId);
        response = await this.recommendations.generate({
          ...request,
          generation_id: crypto.randomUUID(),
        });
      }
      if (leaseLost || await this.persistence.getFeedVersion(userId) !== feedVersion) {
        await this.persistence.recordGenerationAttempt?.({
          generation_id: generationId, user_id: userId, feed_version: feedVersion, mode,
          status: 'stale', latency_ms: Date.now() - started, result_count: response.items.length,
        });
        return 'stale';
      }
      const projections = await this.persistence.listActiveRepositories(response.items.map((item) => item.repo_id));
      const summaries = new Map(projections.map((repo) => [repo.repo_id, repo.summary_id]));
      const activeRepoIds = new Set(projections.map((repo) => repo.repo_id));
      const usableItems = response.items.filter((item) => activeRepoIds.has(item.repo_id));
      const invalidCount = response.items.length - usableItems.length;
      for (let index = 0; index < invalidCount; index++) {
        incrementMetric('feed_v2_invalid_repository_recommendations_total');
      }
      if (usableItems.length === 0) throw new Error('ML returned no active canonical repositories.');
      const published = await this.queue.publishGeneration(
        userId,
        feedVersion,
        token,
        canonicalEntries(usableItems, response.model_version, summaries, response.generation_id),
        this.queueTtlSeconds,
      );
      await this.persistence.recordGenerationAttempt?.({
        generation_id: generationId, user_id: userId, feed_version: feedVersion, mode,
        status: published ? 'completed' : 'stale', latency_ms: Date.now() - started, result_count: usableItems.length,
      });
      return published ? 'generated' : 'stale';
    } catch (error) {
      await this.persistence.recordGenerationAttempt?.({
        generation_id: generationId, user_id: userId, feed_version: feedVersion, mode,
        status: 'failed', latency_ms: Date.now() - started, result_count: 0,
        error_code: (error instanceof Error ? error.message : String(error)).slice(0, 120),
      });
      throw error;
    } finally {
      clearInterval(heartbeat);
      await renewal;
      await this.queue.releaseGenerationLock(userId, feedVersion, token);
    }
  }
}
