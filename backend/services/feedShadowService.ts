import crypto from 'node:crypto';

import type { FeedPersistencePort } from '../ports/feedPersistencePort.js';
import type { RecommendationPort } from '../ports/recommendationPort.js';
import { sqlClient } from '../db/index.js';

export class FeedShadowService {
  constructor(
    private readonly persistence: FeedPersistencePort,
    private readonly recommendations: RecommendationPort,
  ) {}

  async run(userId: string, baselineRepoIds: string[], limit = 45): Promise<void> {
    const generationId = crypto.randomUUID();
    const feedVersion = await this.persistence.getFeedVersion(userId);
    const started = Date.now();
    try {
      let socialRepoIds: string[] = [];
      try {
        socialRepoIds = await this.persistence.listFollowedRepositoryIds(userId, 500);
      } catch (error) {
        console.error('[FeedShadowService] Failed to load followed-owner repositories:', error);
      }
      const response = await this.recommendations.generate({
        schema_version: 2,
        generation_id: generationId,
        user_id: userId,
        feed_version: Number(feedVersion),
        limit,
        exclude_repo_ids: [],
        social_repo_ids: socialRepoIds,
        context: { cold_start: false },
      });
      const projections = await this.persistence.listActiveRepositories(response.items.map((item) => item.repo_id));
      if (projections.length !== response.items.length) throw new Error('unknown_repository_id');
      const baseline = new Set(baselineRepoIds);
      const overlap = response.items.filter((item) => baseline.has(item.repo_id)).length;
      await sqlClient`
        INSERT INTO telemetry.generation_attempts (
          generation_id,user_id,feed_version,mode,status,latency_ms,result_count
        ) VALUES (
          ${generationId}::uuid,${userId}::uuid,${feedVersion.toString()}::bigint,'shadow','completed',
          ${Date.now() - started},${response.items.length}
        )
      `;
      console.info(JSON.stringify({
        event: 'feed_v2_shadow', generation_id: generationId, user_id: userId,
        result_count: response.items.length, baseline_count: baseline.size, overlap,
        model_version: response.model_version, embedding_version: response.embedding_version,
        latency_ms: Date.now() - started,
      }));
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120);
      await sqlClient`
        INSERT INTO telemetry.generation_attempts (
          generation_id,user_id,feed_version,mode,status,latency_ms,result_count,error_code
        ) VALUES (
          ${generationId}::uuid,${userId}::uuid,${feedVersion.toString()}::bigint,'shadow','failed',
          ${Date.now() - started},0,${code}
        )
      `;
      console.error('[FeedShadowService] Shadow generation failed:', error);
    }
  }
}
