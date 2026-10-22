import crypto from 'node:crypto';

import type { FeedPersistencePort } from '../ports/feedPersistencePort.js';
import type { RecommendationPort } from '../ports/recommendationPort.js';
import type { FeedQueuePort } from '../redis/feedQueue.js';
import { incrementMetric } from '../observability/metrics.js';
import { canonicalEntries } from './feedV2Service.js';
import { isMissingPersonaRecommendationError } from './mlService.js';
import type { PersonaRepairService } from './personaRepairService.js';

export interface IndexedFeedRefillPolicy { maxQueueDepth: number }
export interface FeedRefillRequest { expectedVersion: bigint; lowWatermark: number }

export type FeedGenerationOutcome =
  | { status: 'generated'; feedVersion: bigint; count: number }
  | { status: 'coalesced' | 'stale' | 'satisfied' | 'capacity'; feedVersion: bigint };

export interface FeedGenerationFence {
  feedVersion: bigint;
  isCurrent: () => Promise<boolean>;
}

export class FeedGenerationService {
  constructor(
    private readonly persistence: FeedPersistencePort,
    private readonly queue: FeedQueuePort,
    private readonly recommendations: RecommendationPort,
    private readonly queueTtlSeconds = 600,
    private readonly lockTtlMs = 15_000,
    private readonly personaRepair?: Pick<PersonaRepairService, 'repair'>,
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
    fence?: FeedGenerationFence,
    refill?: FeedRefillRequest,
  ): Promise<FeedGenerationOutcome> {
    const context = await this.persistence.getGenerationContext?.(userId);
    const feedVersion = context?.feedVersion ?? await this.persistence.getFeedVersion(userId);
    if (this.persistence.getGenerationContext && !context) return { status: 'stale', feedVersion };
    if (refill && (!this.indexedRefill || refill.expectedVersion !== feedVersion)) {
      return { status: 'stale', feedVersion };
    }
    const token = crypto.randomUUID();
    let generationId = crypto.randomUUID();
    const started = Date.now();
    const current = async () => {
      const latest = await this.persistence.getGenerationContext?.(userId);
      const unchanged = context
        ? latest?.feedVersion === feedVersion && latest.profileVersion === context.profileVersion && latest.delivered
        : await this.persistence.getFeedVersion(userId) === feedVersion;
      return unchanged && (!fence || (fence.feedVersion === feedVersion && await fence.isCurrent()));
    };
    if (fence && (fence.feedVersion !== feedVersion || !await fence.isCurrent())) return { status: 'stale', feedVersion };
    if (!await this.queue.acquireGenerationLock(userId, feedVersion, token, this.lockTtlMs)) {
      await this.persistence.recordGenerationAttempt?.({
        generation_id: generationId, user_id: userId, feed_version: feedVersion, mode,
        status: 'coalesced', latency_ms: Date.now() - started, result_count: 0,
      });
      return { status: 'coalesced', feedVersion };
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
      // Repair runs under the existing per-user/version generation lock and
      // heartbeat, so legacy first requests coalesce rather than fan out.
      if (context && !context.delivered) {
        if (!this.personaRepair) return { status: 'stale', feedVersion };
        const delivered = await this.personaRepair.repair(userId);
        if (delivered !== context.profileVersion) return { status: 'stale', feedVersion };
      }
      if (!await current()) return { status: 'stale', feedVersion };
      if (mode === 'prewarm') {
        // A lock collision is not success. Once we own the lock, either a
        // durable witness or the atomic Redis witness proves publication.
        const published = await this.persistence.hasPublishedGeneration?.(userId, feedVersion)
          || await this.queue.hasPublishedGeneration(userId, feedVersion);
        if (published) {
          if (!await current()) return { status: 'stale', feedVersion };
          await this.persistence.markGenerationPublished?.(userId, feedVersion);
          return { status: 'satisfied', feedVersion };
        }
        // A serve alone may be fallback or an ambiguous lost publication, not
        // proof of current-profile ML success. Preserve it without completing.
        if (await this.persistence.hasServedFeed?.(userId, feedVersion)) return { status: 'stale', feedVersion };
      }
      if (this.indexedRefill && (!this.queue.generationState || !this.queue.append)) {
        throw new Error('Indexed feed refill requires reservation-aware queue support.');
      }
      const state = this.indexedRefill ? await this.queue.generationState!(userId, feedVersion, token) : undefined;
      if (state === null) return { status: 'coalesced', feedVersion };
      const generationLimit = this.indexedRefill
        ? Math.max(0, Math.min(limit, this.indexedRefill.maxQueueDepth - state!.remainingDepth,
          500 - state!.occupiedCount)) : limit;
      if (generationLimit === 0) {
        await this.persistence.recordGenerationAttempt?.({
          generation_id: generationId, user_id: userId, feed_version: feedVersion, mode,
          status: 'coalesced', latency_ms: Date.now() - started, result_count: 0,
          error_code: 'FEED_RESERVATION_CAPACITY',
        });
        return { status: 'capacity', feedVersion };
      }
      if (refill && state!.remainingDepth >= refill.lowWatermark) return { status: 'coalesced', feedVersion };
      const history = await this.persistence.listExcludedRepositoryIds(userId, sessionId, 500);
      // Preserve every bounded snapshot/history exclusion locally even when
      // ML's 500-ID request limit cannot hold the complete union.
      const indexedExclusions = [
        ...(state?.excludedRepoIds ?? []), ...excludeRepoIds.slice(0, 500), ...history.slice(0, 500),
      ];
      const excludedIds = new Set(this.indexedRefill
        ? indexedExclusions : [...new Set([...excludeRepoIds, ...history])].slice(0, 500));
      const excluded = [...excludedIds].slice(0, 500);
      let socialRepoIds: string[] = [];
      try {
        socialRepoIds = await this.persistence.listFollowedRepositoryIds(userId, 500);
      } catch (error) {
        console.error('[FeedGenerationService] Failed to load followed-owner repositories:', error);
      }
      if (leaseLost || !await current()) return { status: 'stale', feedVersion };
      const request = {
        schema_version: 2,
        generation_id: generationId,
        user_id: userId,
        feed_version: Number(feedVersion),
        limit: generationLimit,
        exclude_repo_ids: excluded,
        social_repo_ids: socialRepoIds,
        context: { cold_start: false },
      } as const;
      let response: Awaited<ReturnType<RecommendationPort['generate']>>;
      try {
        response = await this.recommendations.generate(request);
      } catch (error) {
        if (!this.personaRepair || !isMissingPersonaRecommendationError(error)) throw error;
        incrementMetric('feed_v2_persona_repairs_total');
        const repaired = await this.personaRepair.repair(userId);
        if ((context && repaired !== context.profileVersion) || !await current()) return { status: 'stale', feedVersion };
        generationId = crypto.randomUUID();
        response = await this.recommendations.generate({
          ...request,
          generation_id: generationId,
        });
      }
      if (leaseLost || !await current()) {
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
      const activeRepoIds = new Set(projections.map((repo) => repo.repo_id));
      const usableItems = items.filter((item) => activeRepoIds.has(item.repo_id));
      const invalidCount = items.length - usableItems.length;
      for (let index = 0; index < invalidCount; index++) {
        incrementMetric('feed_v2_invalid_repository_recommendations_total');
      }
      if (items.length > 0 && usableItems.length === 0) throw new Error('ML returned no active canonical repositories.');
      // Profile updates advance the feed namespace in their source transaction;
      // a racing old builder can publish only under the obsolete namespace.
      if (leaseLost || !await current()) return { status: 'stale', feedVersion };
      // A durable serve/success may have appeared while ML was running (for
      // example a Redis-outage fallback). Preserve it rather than resetting it.
      if (mode === 'prewarm' && await this.persistence.hasPublishedGeneration?.(userId, feedVersion)) {
        await this.persistence.markGenerationPublished?.(userId, feedVersion);
        return { status: 'satisfied', feedVersion };
      }
      if (mode === 'prewarm' && await this.persistence.hasServedFeed?.(userId, feedVersion)) return { status: 'stale', feedVersion };
      const canonical = canonicalEntries(this.indexedRefill ? usableItems.slice(0, generationLimit) : usableItems,
        response.model_version, summaries, response.generation_id);
      // A nonempty ML batch filtered entirely by existing exclusions is not
      // proof of exhaustion either. Never publish it as a terminal empty page.
      if (this.indexedRefill && response.items.length > 0 && canonical.length === 0) {
        await this.persistence.recordGenerationAttempt?.({
          generation_id: generationId, user_id: userId, feed_version: feedVersion, mode,
          status: 'coalesced', latency_ms: Date.now() - started, result_count: 0,
          error_code: 'FEED_CANDIDATES_EXCLUDED',
        });
        return { status: 'capacity', feedVersion };
      }
      if (leaseLost || !await current()) return { status: 'stale', feedVersion };
      let published: boolean;
      let count = canonical.length;
      if (this.indexedRefill) {
        const appended = await this.queue.append!(userId, feedVersion, token, canonical,
          this.queueTtlSeconds, this.indexedRefill.maxQueueDepth, mode === 'prewarm');
        if (!appended || appended.status === 'capacity') {
          await this.persistence.recordGenerationAttempt?.({
            generation_id: generationId, user_id: userId, feed_version: feedVersion, mode,
            status: 'coalesced', latency_ms: Date.now() - started, result_count: 0,
          });
          return { status: appended ? 'capacity' : 'coalesced', feedVersion };
        }
        if (appended.status === 'satisfied') {
          await this.persistence.markGenerationPublished?.(userId, feedVersion);
          return { status: 'satisfied', feedVersion };
        }
        count = appended.count;
        published = true;
      } else {
        published = await this.queue.publishGeneration(userId, feedVersion, token, canonical,
          this.queueTtlSeconds, mode === 'prewarm');
      }
      // Redis already holds an eight-day witness if this SQL write crashes.
      if (published) await this.persistence.markGenerationPublished?.(userId, feedVersion);
      await this.persistence.recordGenerationAttempt?.({
        generation_id: generationId, user_id: userId, feed_version: feedVersion, mode,
        status: published ? 'completed' : 'stale', latency_ms: Date.now() - started, result_count: count,
      });
      return published ? { status: 'generated', feedVersion, count } : { status: 'stale', feedVersion };
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
