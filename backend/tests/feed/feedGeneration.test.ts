import assert from 'node:assert/strict';
import test from 'node:test';

import type { CreateServeInput, RecommendationEntry, RepositoryProjection, StoredServe } from '../../contracts/feed.v2.js';
import type { MlRecommendationRequest, MlRecommendationResponse } from '../../contracts/ml.v2.js';
import type { FeedPersistencePort } from '../../ports/feedPersistencePort.js';
import type { RecommendationPort } from '../../ports/recommendationPort.js';
import type { FeedQueuePort } from '../../redis/feedQueue.js';
import { FeedGenerationService } from '../../services/feedGenerationService.js';
import { MlRecommendationError } from '../../services/mlService.js';

const userId = '00000000-0000-4000-8000-000000000001';
const socialRepoId = '00000000-0000-4000-8000-000000000002';
const otherRepoId = '00000000-0000-4000-8000-000000000003';

class GenerationPersistence implements FeedPersistencePort {
  async listPreferenceEligibleRepositoryIds(_userId: string, repoIds: string[]) { return repoIds; }
  profileVersion = 1n;
  delivered = true;
  served = false;
  async getGenerationContext() {
    return { feedVersion: await this.getFeedVersion(), profileVersion: this.profileVersion, delivered: this.delivered };
  }
  async hasServedFeed() { return this.served; }
  inactive = new Set<string>();
  published = false;
  failPublicationRecord = false;
  async hasPublishedGeneration() { return this.published; }
  async markGenerationPublished() {
    if (this.failPublicationRecord) throw new Error('publication SQL unavailable');
    this.published = true;
  }
  identities: Array<Pick<RepositoryProjection, 'repo_id' | 'summary_id'>> = [
    { repo_id: otherRepoId, summary_id: null },
    { repo_id: socialRepoId, summary_id: '00000000-0000-4000-8000-000000000004' },
  ];
  validatedRepoIds: string[] = [];
  async getFeedVersion() { return 1n; }
  async listExcludedRepositoryIds(_user: string, _session: string | undefined, _limit: number): Promise<string[]> { return []; }
  async listFollowedRepositoryIds() { return [socialRepoId]; }
  async listActiveRepositoryIdentities(repoIds: string[]) {
    this.validatedRepoIds = repoIds;
    return this.identities.filter(row => repoIds.includes(row.repo_id) && !this.inactive.has(row.repo_id));
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
  owned = true;
  locked = false;
  published = false;
  async renewGenerationLock() { return this.owned; }
  async hasPublishedGeneration() { return this.published; }
  async publishGeneration(user: string, version: bigint, _token: string, entries: RecommendationEntry[], _ttl: number, onlyIfUnpublished = false) {
    if (!this.owned || (onlyIfUnpublished && this.published)) return false;
    await this.replace(user,version,entries); this.published = true; return true;
  }
  async acquireGenerationLock() { return !this.locked; }
  released = false;
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
      context_status: { cold_start_applied: false, locale: 'not_provided' },
      embedding_versions: [], served_ranker: 'heavy', heavy_ranker_selected: true,
      ranker_applied: true, fallback_code: null, fallback_reason: null, retrieval_mode: 'personalized',
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

  assert.deepEqual(result, { status: 'generated', feedVersion: 1n, count: 2 });
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

test('feed generation rejects an entirely missing or inactive set without replacing the queue', async () => {
  const persistence = new GenerationPersistence();
  persistence.identities = [];
  const queue = new GenerationQueue();

  await assert.rejects(
    new FeedGenerationService(persistence, queue, new CapturingRecommendations()).generate(userId),
    /ML returned no active canonical repositories/,
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

test('feed generation repairs a missing ML persona and retries exactly once', async () => {
  const persistence = new GenerationPersistence();
  const queue = new GenerationQueue();
  const recommendations = new CapturingRecommendations();
  let calls = 0;
  const originalGenerate = recommendations.generate.bind(recommendations);
  recommendations.generate = async (input) => {
    calls++;
    if (calls === 1) {
      throw new MlRecommendationError(
        'User vector unavailable', 503, 'persona_unavailable', 'User vector unavailable',
      );
    }
    return originalGenerate(input);
  };
  let repairs = 0;
  const records: Parameters<NonNullable<FeedPersistencePort['recordGenerationAttempt']>>[0][] = [];
  const auditedPersistence: FeedPersistencePort = Object.assign(persistence, {
    recordGenerationAttempt: async (record: typeof records[number]) => { records.push(record); },
  });

  const result = await new FeedGenerationService(
    auditedPersistence,
    queue,
    recommendations,
    600,
    15_000,
    { repair: async () => { repairs++; return 1n; } },
  ).generate(userId, 45);

  assert.equal(result.status, 'generated');
  assert.equal(calls, 2);
  assert.equal(repairs, 1);
  assert.equal(records[0].generation_id, recommendations.request?.generation_id);
  assert.ok(queue.entries.every(entry => entry.generation_id === records[0].generation_id));
});

test('feed generation drops stale ML repository IDs while preserving valid personalized ranking', async () => {
  const persistence = new GenerationPersistence();
  persistence.inactive.add(socialRepoId);
  const queue = new GenerationQueue();

  const result = await new FeedGenerationService(
    persistence,
    queue,
    new CapturingRecommendations(),
  ).generate(userId, 45);

  assert.equal(result.status, 'generated');
  assert.deepEqual(queue.entries.map((entry) => entry.repo_id), [otherRepoId]);
});

test('an expired generation cannot overwrite recommendations published by a newer owner',async()=>{
  const queue=new GenerationQueue();const recommendations=new CapturingRecommendations();
  const original=recommendations.generate.bind(recommendations);
  recommendations.generate=async input=>{queue.owned=false;queue.entries=[{...queue.entries[0],repo_id:'newer-owner-result'} as RecommendationEntry];return original(input);};
  const result=await new FeedGenerationService(new GenerationPersistence(),queue,recommendations).generate(userId);
  assert.equal(result.status,'stale');assert.equal(queue.replaced,false);
  assert.equal(queue.entries[0].repo_id,'newer-owner-result');
});

test('long persona repair renews its lease before publishing',async()=>{
  const queue=new GenerationQueue();let renewed!:()=>void;
  const renewal=new Promise<void>(resolve=>{renewed=resolve;});let renewals=0;
  queue.renewGenerationLock=async()=>{renewals++;renewed();return true;};
  const recommendations=new CapturingRecommendations();const original=recommendations.generate.bind(recommendations);let calls=0;
  recommendations.generate=async input=>{if(calls++===0)throw new MlRecommendationError('No persona',503,'persona_unavailable','User vector unavailable');return original(input);};
  // Keep this deterministic without depending on a 30-second provider request.
  const alive=setTimeout(()=>{},1000);
  try {
    const result=await new FeedGenerationService(new GenerationPersistence(),queue,recommendations,600,9,
      {repair:async()=>{await renewal;return 1n;}}).generate(userId);
    assert.equal(result.status,'generated');assert.ok(renewals>=1);assert.equal(queue.replaced,true);
    const atCompletion=renewals;await new Promise(resolve=>setTimeout(resolve,15));
    assert.equal(renewals,atCompletion,'Heartbeat stops when generation finishes');
  }finally{clearTimeout(alive);}
});

test('generation excludes actual exposure and current-session deliveries before enqueueing recommendations', async () => {
  const persistence = new GenerationPersistence();
  let historyArgs: unknown[] = [];
  Object.assign(persistence, {listExcludedRepositoryIds:async (...args:unknown[])=>{historyArgs=args;return [socialRepoId];}});
  const queue = new GenerationQueue(); let queued: string[] = [];
  let completedCount: number | undefined;
  Object.assign(persistence, { recordGenerationAttempt: async (attempt: {status: string; result_count: number}) => {
    if (attempt.status === 'completed') completedCount = attempt.result_count;
  } });
  queue.replace = async (...args: unknown[])=>{queued=(args[2] as {repo_id:string}[]).map(item=>item.repo_id);};
  const recommendations = new CapturingRecommendations();
  await new FeedGenerationService(persistence,queue,recommendations).generate(userId,45,[],'live','browsing-session');
  assert.deepEqual(historyArgs,[userId,'browsing-session',500]);
  assert.deepEqual(recommendations.request?.exclude_repo_ids,[socialRepoId]);
  assert.deepEqual(persistence.validatedRepoIds,[otherRepoId], 'validate only unexcluded identities without card hydration');
  assert.deepEqual(queued,[otherRepoId]);
  assert.equal(completedCount, 1, 'record the canonical items actually enqueued');
});

test('generation combines unique exclusions within the existing 500-ID ML contract',async()=>{
  const persistence = new GenerationPersistence();
  const history=Array.from({length:500},(_,i)=>`00000000-0000-4000-8000-${String(i+10).padStart(12,'0')}`);
  Object.assign(persistence,{listExcludedRepositoryIds:async()=>history});
  const recommendations = new CapturingRecommendations();
  await new FeedGenerationService(persistence,new GenerationQueue(),recommendations).generate(userId,45,[socialRepoId,socialRepoId]);
  assert.equal(recommendations.request?.exclude_repo_ids.length,500);
  assert.equal(new Set(recommendations.request?.exclude_repo_ids).size,500);
  assert.equal(recommendations.request?.exclude_repo_ids[0],socialRepoId);
});


test('prewarm preserves a successful same-version feed after every card was consumed', async () => {
  const persistence = new GenerationPersistence();
  const queue = new GenerationQueue();
  const recommendations = new CapturingRecommendations();
  const service = new FeedGenerationService(persistence, queue, recommendations);
  await service.generate(userId);
  const firstRequest = recommendations.request;
  queue.entries = []; // Page one consumed the generated list; depth is not success evidence.
  queue.replaced = false;
  assert.deepEqual(await service.generate(userId,45,[],'prewarm'), { status: 'satisfied', feedVersion: 1n });
  assert.equal(recommendations.request, firstRequest);
  assert.equal(queue.replaced, false);
  queue.published = false; // Lost Redis witness: durable success remains fail-closed.
  assert.equal((await service.generate(userId,45,[],'prewarm')).status, 'satisfied');
  assert.equal(queue.replaced, false);
});

test('prewarm recovers publication-before-SQL crash without replacing an empty successful feed', async () => {
  const persistence = new GenerationPersistence();
  persistence.failPublicationRecord = true;
  const queue = new GenerationQueue();
  const recommendations = new CapturingRecommendations();
  recommendations.generate = async input => ({ schema_version: 2, generation_id: input.generation_id,
    user_id: input.user_id, feed_version: input.feed_version, model_version: 'test', embedding_version: 'test', items: [],
    context_status: { cold_start_applied: false, locale: 'not_provided' },
    embedding_versions: [], served_ranker: 'heavy', heavy_ranker_selected: true,
    ranker_applied: true, fallback_code: null, fallback_reason: null, retrieval_mode: 'personalized' });
  const service = new FeedGenerationService(persistence, queue, recommendations);
  await assert.rejects(service.generate(userId,45,[],'prewarm'), /publication SQL unavailable/);
  assert.equal(queue.published, true);
  assert.deepEqual(queue.entries, []);
  queue.replaced = false;
  persistence.failPublicationRecord = false;
  assert.equal((await service.generate(userId,45,[],'prewarm')).status, 'satisfied');
  assert.equal(queue.replaced, false);
  assert.equal(persistence.published, true);
});

test('prewarm retries an unsuccessful lock holder but fences an obsolete claim before publication', async () => {
  const persistence = new GenerationPersistence();
  const queue = new GenerationQueue();
  const recommendations = new CapturingRecommendations();
  const service = new FeedGenerationService(persistence, queue, recommendations);
  queue.locked = true;
  assert.equal((await service.generate(userId,45,[],'prewarm')).status, 'coalesced');
  queue.locked = false;
  let current = true;
  const read = persistence.listActiveRepositoryIdentities.bind(persistence);
  persistence.listActiveRepositoryIdentities = async ids => { current = false; return read(ids); };
  assert.equal((await service.generate(userId,45,[],'prewarm',undefined, {
    feedVersion: 1n,isCurrent: async () => current,
  })).status, 'stale');
  assert.equal(queue.published, false);
  persistence.listActiveRepositoryIdentities = read;
  assert.equal((await service.generate(userId,45,[],'prewarm')).status, 'generated');
});


test('undelivered current profile cannot issue ML generation or publish', async () => {
  const persistence = new GenerationPersistence(); persistence.delivered = false;
  const queue = new GenerationQueue(); const recommendations = new CapturingRecommendations();
  const outcome = await new FeedGenerationService(persistence, queue, recommendations).generate(userId);
  assert.equal(outcome.status, 'stale');
  assert.equal(recommendations.request, null);
  assert.equal(queue.replaced, false);
});

test('legacy repair proves the exact profile before requesting recommendations', async () => {
  const persistence = new GenerationPersistence(); persistence.delivered = false;
  const queue = new GenerationQueue(); const recommendations = new CapturingRecommendations();
  const generation = new FeedGenerationService(persistence, queue, recommendations, 600, 15_000, {
    repair: async () => { persistence.delivered = true; return persistence.profileVersion; },
  });
  assert.equal((await generation.generate(userId)).status, 'generated');
  assert.notEqual(recommendations.request, null);
});

test('profile change during ML blocks publication even when a broken writer kept the feed version', async () => {
  const persistence = new GenerationPersistence(); const queue = new GenerationQueue();
  const recommendations = new CapturingRecommendations();
  const generate = recommendations.generate.bind(recommendations);
  recommendations.generate = async input => {
    const response = await generate(input); persistence.profileVersion = 2n; return response;
  };
  assert.equal((await new FeedGenerationService(persistence, queue, recommendations).generate(userId)).status, 'stale');
  assert.equal(queue.replaced, false);
});

test('serve-only ambiguity does not falsely complete prewarm as ML success', async () => {
  const persistence = new GenerationPersistence(); persistence.served = true;
  const queue = new GenerationQueue(); const recommendations = new CapturingRecommendations();
  const outcome = await new FeedGenerationService(persistence, queue, recommendations).generate(userId, 45, [], 'prewarm');
  assert.equal(outcome.status, 'stale');
  assert.equal(persistence.published, false);
  assert.equal(recommendations.request, null);
});

test('social projection is disabled by default and enabled evidence reaches only the authenticated ML request', async () => {
  const persistence = new GenerationPersistence();
  let lookups = 0;
  const evidence = [{ repo_id: socialRepoId, owner_github_id: '123', source: 'followed_owner' as const,
    support: 1, source_score: 0.25 }];
  const projected = Object.assign(persistence, { listSocialRepositoryCandidates: async (user: string, limit: number) => {
    assert.equal(user, userId); assert.equal(limit, 100); lookups++; return evidence;
  } });
  const disabled = new CapturingRecommendations();
  await new FeedGenerationService(projected, new GenerationQueue(), disabled).generate(userId);
  assert.equal(lookups, 0);
  assert.equal(disabled.request?.social_candidates, undefined);
  const enabled = new CapturingRecommendations();
  await new FeedGenerationService(projected, new GenerationQueue(), enabled, 600, 15000, undefined, undefined, true).generate(userId);
  assert.equal(lookups, 1);
  assert.deepEqual(enabled.request?.social_candidates, evidence);
  assert.deepEqual(enabled.request?.social_repo_ids, [socialRepoId], 'Legacy boost remains compatible.');
});

test('social projection failure releases generation without publishing an invented candidate set', async () => {
  const persistence = Object.assign(new GenerationPersistence(), {
    listSocialRepositoryCandidates: async () => { throw new Error('social projection unavailable'); },
  });
  const queue = new GenerationQueue(); const ml = new CapturingRecommendations();
  await assert.rejects(new FeedGenerationService(persistence, queue, ml, 600, 15000, undefined, undefined, true)
    .generate(userId), /social projection unavailable/);
  assert.equal(queue.released, true); assert.equal(queue.published, false); assert.equal(ml.request, null);
});

test('current explicit negatives filter every ML source independently of bounded exposure history', async () => {
  const persistence=new GenerationPersistence();
  let viewer: string | undefined;
  persistence.listPreferenceEligibleRepositoryIds=async (user, ids) => {viewer=user;return ids.filter(id=>id!==socialRepoId);};
  const queue=new GenerationQueue();
  const result=await new FeedGenerationService(persistence,queue,new CapturingRecommendations()).generate(userId);
  assert.equal(viewer,userId);
  assert.deepEqual(queue.entries.map(item=>item.repo_id),[otherRepoId]);
  assert.deepEqual(result,{status:'generated',feedVersion:1n,count:1});
});

test('an entirely preference-filtered ML batch remains retryable rather than publishing exhaustion', async () => {
  const persistence=new GenerationPersistence();
  persistence.listPreferenceEligibleRepositoryIds=async ()=>[];
  const queue=new GenerationQueue();
  const result=await new FeedGenerationService(persistence,queue,new CapturingRecommendations()).generate(userId);
  assert.deepEqual(result,{status:'capacity',feedVersion:1n});
  assert.equal(queue.published,false); assert.equal(queue.released,true);
});
