import assert from 'node:assert/strict';
import test from 'node:test';

import type { CreateServeInput, RecommendationEntry, RepositoryProjection, StoredServe } from '../../contracts/feed.v2.js';
import type { MlRecommendationRequest, MlRecommendationResponse } from '../../contracts/ml.v2.js';
import type { FeedPersistencePort } from '../../ports/feedPersistencePort.js';
import type { RecommendationPort } from '../../ports/recommendationPort.js';
import type { FeedQueuePort } from '../../redis/feedQueue.js';
import { FeedGenerationService } from '../../services/feedGenerationService.js';

const userId = '00000000-0000-4000-8000-000000000001';
const socialRepoId = '00000000-0000-4000-8000-000000000002';
const otherRepoId = '00000000-0000-4000-8000-000000000003';

class GenerationPersistence implements FeedPersistencePort {
  identities: Array<Pick<RepositoryProjection, 'repo_id' | 'summary_id'>> = [
    { repo_id: otherRepoId, summary_id: null },
    { repo_id: socialRepoId, summary_id: '00000000-0000-4000-8000-000000000004' },
  ];
  validatedRepoIds: string[] = [];
  async getFeedVersion() { return 1n; }
  async listFollowedRepositoryIds() { return [socialRepoId]; }
  async listActiveRepositoryIdentities(repoIds: string[]) {
    this.validatedRepoIds = repoIds;
    return this.identities;
  }
  async listActiveRepositories(): Promise<RepositoryProjection[]> {
    throw new Error('Generation must not hydrate repository cards.');
  }
  async getServeByRequest(): Promise<StoredServe | null> { return null; }
  async createServe(_input: CreateServeInput): Promise<StoredServe> { throw new Error('unused'); }
  async getTrendingFallback(): Promise<RepositoryProjection[]> { return []; }
}

class GenerationQueue implements FeedQueuePort {
  replaced = false;
  entries: RecommendationEntry[] = [];
  released = false;
  async acquireGenerationLock() { return true; }
  async releaseGenerationLock() { this.released = true; }
  async replace(_userId: string, _version: bigint, entries: RecommendationEntry[]) {
    this.replaced = true;
    this.entries = entries;
  }
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
  assert.deepEqual(persistence.validatedRepoIds, [socialRepoId, otherRepoId]);
  assert.deepEqual(queue.entries.map(({ repo_id, summary_id, score, source, model_version }) => ({
    repo_id, summary_id, score, source, model_version,
  })), [
    { repo_id: socialRepoId, summary_id: persistence.identities[1].summary_id,
      score: 0.8, source: 'semantic', model_version: 'test-model' },
    { repo_id: otherRepoId, summary_id: null,
      score: 0.9, source: 'semantic', model_version: 'test-model' },
  ]);
});

test('feed generation rejects missing or inactive identities without replacing the queue', async () => {
  const persistence = new GenerationPersistence();
  persistence.identities = persistence.identities.slice(0, 1);
  const queue = new GenerationQueue();

  await assert.rejects(
    new FeedGenerationService(persistence, queue, new CapturingRecommendations()).generate(userId),
    /ML returned unknown or inactive repositories/,
  );
  assert.equal(queue.replaced, false);
  assert.equal(queue.released, true);
});

test('feed generation takes the current summary identity on each generation', async () => {
  const persistence = new GenerationPersistence();
  const queue = new GenerationQueue();
  const service = new FeedGenerationService(persistence, queue, new CapturingRecommendations());
  await service.generate(userId);
  assert.equal(queue.entries[0].summary_id, persistence.identities[1].summary_id);
  const currentSummary = '00000000-0000-4000-8000-000000000005';
  persistence.identities[1].summary_id = currentSummary;

  await service.generate(userId);
  assert.equal(queue.entries[0].summary_id, currentSummary);
});
