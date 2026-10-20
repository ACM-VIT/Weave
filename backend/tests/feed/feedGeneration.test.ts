import assert from 'node:assert/strict';
import test from 'node:test';

import type { CreateServeInput, RepositoryProjection, StoredServe } from '../../contracts/feed.v2.js';
import type { MlRecommendationRequest, MlRecommendationResponse } from '../../contracts/ml.v2.js';
import type { FeedPersistencePort } from '../../ports/feedPersistencePort.js';
import type { RecommendationPort } from '../../ports/recommendationPort.js';
import type { FeedQueuePort } from '../../redis/feedQueue.js';
import { FeedGenerationService } from '../../services/feedGenerationService.js';

const userId = '00000000-0000-4000-8000-000000000001';
const socialRepoId = '00000000-0000-4000-8000-000000000002';
const otherRepoId = '00000000-0000-4000-8000-000000000003';

function projection(repoId: string): RepositoryProjection {
  return {
    repo_id: repoId,
    full_name: `owner/${repoId}`,
    owner_user_id: null,
    owner_profile_id: null,
    owner_profile_claimed_user_id: null,
    owner_bio: null,
    description: null,
    primary_language: null,
    languages: [],
    topics: [],
    star_count: 0,
    fork_count: 0,
    likes_count: 0,
    comments_count: 0,
    views_count: 0,
    open_issues_count: 0,
    summary_id: null,
    summary: null,
    summary_highlights: [],
    summary_prompt_version: null,
    summary_model_version: null,
    summary_format_version: null,
    summary_source: null,
    readme_md: null,
    readme_source_path: null,
    readme_default_branch: null,
    readme_base_url: null,
    updated_at: null,
    viewer_reaction: null,
    viewer_saved: false,
    viewer_follows_owner: false,
    status: 'active',
  };
}

class GenerationPersistence implements FeedPersistencePort {
  async getFeedVersion() { return 1n; }
  async listFollowedRepositoryIds() { return [socialRepoId]; }
  async listActiveRepositories(repoIds: string[]) { return repoIds.map(projection); }
  async getServeByRequest(): Promise<StoredServe | null> { return null; }
  async createServe(_input: CreateServeInput): Promise<StoredServe> { throw new Error('unused'); }
  async getTrendingFallback(): Promise<RepositoryProjection[]> { return []; }
}

class GenerationQueue implements FeedQueuePort {
  replaced = false;
  async acquireGenerationLock() { return true; }
  async releaseGenerationLock() {}
  async replace() { this.replaced = true; }
  async reserve(): Promise<never> { throw new Error('unused'); }
  async refill(): Promise<never> { throw new Error('unused'); }
  async commit() { return true; }
  async release() { return true; }
  async depth() { return 0; }
  async scanReservations() { return []; }
  async deleteStaleVersions() { return 0; }
}

class CapturingRecommendations implements RecommendationPort {
  request: MlRecommendationRequest | null = null;
  async generate(input: MlRecommendationRequest): Promise<MlRecommendationResponse> {
    this.request = input;
    return {
      schema_version: 2,
      generation_id: input.generation_id,
      user_id: input.user_id,
      feed_version: input.feed_version,
      model_version: 'test-model',
      embedding_version: 'test-embedding',
      items: [
        { repo_id: socialRepoId, score: 0.8, source: 'semantic' },
        { repo_id: otherRepoId, score: 0.9, source: 'semantic' },
      ],
    };
  }
}

test('feed generation sends followed-owner repositories as bounded ML context', async () => {
  const persistence = new GenerationPersistence();
  const queue = new GenerationQueue();
  const recommendations = new CapturingRecommendations();
  const result = await new FeedGenerationService(
    persistence,
    queue,
    recommendations,
  ).generate(userId, 45);

  assert.equal(result, 'generated');
  assert.deepEqual(recommendations.request?.social_repo_ids, [socialRepoId]);
  assert.equal(queue.replaced, true);
});
