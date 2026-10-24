import { IntentFeedGateway } from '../../services/intentFeedGateway.js';
import type { FeedIntentScope } from '../../contracts/feedIntent.js';
import type { FeedResponseV2 } from '../../contracts/feed.v2.js';
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { createServer } from 'node:http';
import { MlV2Client } from '../../services/mlService.js';
import { FeedGenerationService } from '../../services/feedGenerationService.js';

import type {
  CreateServeInput,
  RecommendationEntry,
  RepositoryProjection,
  StoredServe,
} from '../../contracts/feed.v2.js';
import type { FeedPersistencePort } from '../../ports/feedPersistencePort.js';
import type { FeedQueuePort, FeedReservation } from '../../redis/feedQueue.js';
import { ReservationOwnedError } from '../../redis/feedQueue.js';
import {
  FeedRequestInProgressError,
  FeedV2Service,
  PersonalizedFeedUnavailableError,
} from '../../services/feedV2Service.js';

function ordinaryFeedVersion(value: string | number): number {
  assert.equal(typeof value, 'number', 'This fixture implements only ordinary recommendation responses');
  assert.ok(Number.isSafeInteger(value));
  return value as number;
}

const repo: RepositoryProjection = {
  repo_id: '00000000-0000-4000-8000-000000000001', full_name: 'owner/repo', description: null,
  owner_user_id: null, owner_profile_id: null, owner_profile_claimed_user_id: null,
  owner_bio: null, viewer_follows_owner: false,
  primary_language: 'TypeScript', languages: ['TypeScript'], topics: [], star_count: 1, fork_count: 0,
  likes_count: 0, comments_count: 0, views_count: 0, open_issues_count: 0,
  summary_id: null, summary: null, summary_highlights: [], summary_prompt_version: null,
  summary_model_version: null, summary_format_version: null, summary_source: null,
  readme_md: null, readme_source_path: null, readme_default_branch: null,
  readme_base_url: null, updated_at: null, status: 'active',
  viewer_reaction: null, viewer_saved: false,
};

class FakePersistence implements FeedPersistencePort {
  async listPreferenceEligibleRepositoryIds(_userId: string, repoIds: string[]) { return repoIds; }
  serve: StoredServe | null = null;
  version = 3n;
  missesBeforeServe = 0;
  fallbackCalls = 0;
  fallbackViewerId: string | undefined;
  recentPersonalized: RecommendationEntry[] = [];
  async getFeedVersion() { return this.version; }
  async listExcludedRepositoryIds(_user: string, _session: string | undefined, _limit: number): Promise<string[]> { return []; }
  async listFollowedRepositoryIds() { return []; }
  async getServeByRequest(_userId?: string, requestId?: string) {
    if (this.missesBeforeServe > 0) { this.missesBeforeServe--; return null; }
    return this.serve?.feed_request_id === requestId ? this.serve : null;
  }
  async listActiveRepositories(repoIds: string[]) { return repoIds.map((repoId) => ({ ...repo, repo_id: repoId })); }
  async listActiveRepositoryIdentities(repoIds: string[]) {
    return repoIds.map(repoId => ({ repo_id: repoId, summary_id: repo.summary_id }));
  }
  async getTrendingFallback(_limit: number, _exclude: string[], viewerUserId?: string) {
    this.fallbackCalls++;
    this.fallbackViewerId = viewerUserId;
    return [repo];
  }
  async getRecentPersonalizedEntries() { return this.recentPersonalized; }
  async createServe(input: CreateServeInput) {
    this.serve = {
      ...input, serve_id: '00000000-0000-4000-8000-000000000099', created_at: new Date(0).toISOString(),
    };
    return this.serve;
  }
}

class FakeQueue implements FeedQueuePort {
  committed = 0; released = 0;
  async reserve(_u: string, _v: bigint, requestId: string, _l: number, token: string): Promise<FeedReservation> {
    return { requestId, token, items: [{ repo_id: repo.repo_id, score: 1, source: 'semantic', model_version: 'm1', summary_id: null }] };
  }
  async refill(_u: string, _v: bigint, requestId: string, _l: number, token: string): Promise<FeedReservation> {
    return this.reserve(_u, _v, requestId, _l, token);
  }
  async commit(_u: string, _v: bigint, _requestId: string, _token: string) { this.committed++; return true; }
  async release(_u: string, _v: bigint, _requestId: string, _token: string) { this.released++; return true; }
  async replace() {}
  async renewGenerationLock() { return true; }
  async hasPublishedGeneration() { return false; }
  async publishGeneration(_u: string, _v: bigint, _token: string, _entries: RecommendationEntry[], _ttl: number) { return true; }
  async depth() { return 0; }
  async acquireGenerationLock() { return true; }
  async releaseGenerationLock() {}
  async scanReservations() { return []; }
  async deleteStaleVersions() { return 0; }
}

test('fresh delivery drops recent and repeated queued cards without changing immutable replay', async () => {
  const persistence = new FakePersistence();
  const other = '00000000-0000-4000-8000-000000000002';
  const checked: string[][] = [];
  Object.assign(persistence, { listExposureEligibleRepositoryIds: async (_user: string, ids: string[]) => {
    checked.push(ids); return ids.filter(id => id === other);
  } });
  const queue = new FakeQueue();
  queue.reserve = async (_user, _version, requestId, _limit, token) => ({ requestId, token, remainingDepth: 0,
    items: [repo.repo_id, other, other].map(repo_id => ({ repo_id, score: 1, source: 'semantic', model_version: 'm1', summary_id: null })) });
  const service = new FeedV2Service(persistence, queue);
  const request = { feed_request_id: '00000000-0000-4000-8000-000000000010',
    session_id: '00000000-0000-4000-8000-000000000020', limit: 10, cursor: null };
  const page = await service.getFeed('00000000-0000-4000-8000-000000000030', request);
  assert.deepEqual(page.items.map(item => item.repo_id), [other]);
  assert.equal(page.next_cursor, null);
  await service.getFeed('00000000-0000-4000-8000-000000000030', request);
  assert.equal(checked.length, 1, 'replay retains the durable serve without filtering it again');
});

test('a raced exposure discards its reservation and remains retryable without creating a duplicate serve', async () => {
  const { FeedExposureChangedError } = await import('../../ports/feedPersistencePort.js');
  const persistence = new FakePersistence();
  persistence.createServe = async () => { throw new FeedExposureChangedError(); };
  const queue = new FakeQueue();
  const service = new FeedV2Service(persistence, queue);
  await assert.rejects(service.getFeed('00000000-0000-4000-8000-000000000030', {
    feed_request_id: '00000000-0000-4000-8000-000000000010',
    session_id: '00000000-0000-4000-8000-000000000020', limit: 10, cursor: null,
  }), FeedRequestInProgressError);
  assert.equal(queue.committed, 1);
  assert.equal(queue.released, 0, 'stale cards must not cycle back into the queue');
  assert.equal(persistence.serve, null);
});

test('v2 feed reserves, persists, commits, and replays the same serve', async () => {
  const persistence = new FakePersistence();
  const queue = new FakeQueue();
  const service = new FeedV2Service(persistence, queue);
  const request = {
    feed_request_id: '00000000-0000-4000-8000-000000000010',
    session_id: '00000000-0000-4000-8000-000000000020', limit: 10, cursor: null,
  };
  const first = await service.getFeed('00000000-0000-4000-8000-000000000030', request);
  const replay = await service.getFeed('00000000-0000-4000-8000-000000000030', request);
  assert.equal(first.serve_id, replay.serve_id);
  assert.equal(first.feed_version, '3');
  assert.equal(queue.committed, 1);
  assert.equal(queue.released, 0);
});

test('v2 feed omits private persistence fields from creation and durable replay', async () => {
  const persistence = new FakePersistence();
  const originalCreate = persistence.createServe.bind(persistence);
  persistence.createServe = async input => {
    const stored = await originalCreate(input);
    Object.assign(stored.items[0], {
      scoring_reference: { generation_id: 'private', record_digest: 'private-digest' },
      legacy_generation_hint: '00000000-0000-4000-8000-000000000090',
      scoring_context: { user_vector_sha256: 'private-context' },
      scored_input: { input_base64: 'PRIVATE_PACKET' },
    });
    return stored;
  };
  const request = {
    feed_request_id: '00000000-0000-4000-8000-000000000010',
    session_id: '00000000-0000-4000-8000-000000000020', limit: 10, cursor: null,
  };
  const service = new FeedV2Service(persistence, new FakeQueue());
  for (const response of [await service.getFeed('00000000-0000-4000-8000-000000000030', request),
    await service.getFeed('00000000-0000-4000-8000-000000000030', request)]) {
    assert.deepEqual(Object.keys(response.items[0]).sort(),
      ['model_version', 'position', 'repo_id', 'repository', 'score', 'source', 'summary_id']);
    assert.doesNotMatch(JSON.stringify(response), /PRIVATE_PACKET|private-context|private-digest/);
    assert.equal(response.items[0].repository.full_name, repo.full_name);
  }
  assert.ok(persistence.serve && 'scoring_reference' in persistence.serve.items[0]);
});

test('v2 feed replaces a stale queued summary id with the current persisted projection', async () => {
  const persistence = new FakePersistence();
  const queue = new FakeQueue();
  const currentSummaryId = '00000000-0000-4000-8000-000000000091';
  persistence.listActiveRepositories = async (repoIds: string[]) => repoIds.map((repoId) => ({
    ...repo,
    repo_id: repoId,
    summary_id: currentSummaryId,
    summary: 'Current persisted summary.',
  }));
  queue.reserve = async (_user, _version, requestId, _limit, token) => ({
    requestId,
    token,
    items: [{
      repo_id: repo.repo_id,
      score: 1,
      source: 'semantic',
      model_version: 'm1',
      summary_id: '00000000-0000-4000-8000-000000000090',
    }],
  });

  const response = await new FeedV2Service(persistence, queue).getFeed(
    '00000000-0000-4000-8000-000000000030',
    {
      feed_request_id: '00000000-0000-4000-8000-000000000018',
      session_id: '00000000-0000-4000-8000-000000000020',
      limit: 10,
      cursor: null,
    },
  );
  assert.equal(response.items[0].summary_id, currentSummaryId);
  assert.equal(persistence.serve?.items[0].summary_id, currentSummaryId);
});

test('v2 feed reuses only current-version personalized entries when Redis is unavailable', async () => {
  const persistence = new FakePersistence();
  const queue = new FakeQueue();
  persistence.recentPersonalized = [{
    repo_id: repo.repo_id,
    score: 0.9,
    source: 'semantic',
    model_version: 'm1',
    summary_id: null,
    generation_id: '00000000-0000-4000-8000-000000000098',
  }];
  queue.reserve = async () => { throw new Error('redis offline'); };
  const response = await new FeedV2Service(persistence, queue).getFeed(
    '00000000-0000-4000-8000-000000000030',
    { feed_request_id: '00000000-0000-4000-8000-000000000011',
      session_id: '00000000-0000-4000-8000-000000000020', limit: 10, cursor: null },
  );
  assert.equal(response.source, 'personalized');
  assert.equal(response.items[0].repo_id, repo.repo_id);
  assert.equal(persistence.fallbackCalls, 0);
  assert.equal(queue.committed, 0);
});

test('v2 feed fails closed instead of showing generic repositories', async () => {
  const persistence = new FakePersistence();
  const queue = new FakeQueue();
  queue.reserve = async () => { throw new Error('redis offline'); };
  await assert.rejects(
    new FeedV2Service(persistence, queue).getFeed(
      '00000000-0000-4000-8000-000000000030',
      { feed_request_id: '00000000-0000-4000-8000-000000000017',
        session_id: '00000000-0000-4000-8000-000000000020', limit: 10, cursor: null },
    ),
    PersonalizedFeedUnavailableError,
  );
  assert.equal(persistence.fallbackCalls, 0);
});

test('reservation ownership waits for and replays the durable serve', async () => {
  const persistence = new FakePersistence();
  const queue = new FakeQueue();
  persistence.serve = {
    feed_request_id: '00000000-0000-4000-8000-000000000013',
    user_id: '00000000-0000-4000-8000-000000000030',
    session_id: '00000000-0000-4000-8000-000000000020',
    feed_version: 3n,
    generation_id: null,
    source: 'personalized',
    model_version: 'm1',
    next_cursor: null,
    items: [{ repo_id: repo.repo_id, score: 1, source: 'semantic', model_version: 'm1', summary_id: null,
      position: 0, repository: repo }],
    serve_id: '00000000-0000-4000-8000-000000000099',
    created_at: new Date(0).toISOString(),
  };
  persistence.missesBeforeServe = 1;
  queue.reserve = async () => { throw new ReservationOwnedError(); };

  const response = await new FeedV2Service(persistence, queue, undefined, false, 10, 0).getFeed(
    persistence.serve.user_id,
    { feed_request_id: persistence.serve.feed_request_id, session_id: persistence.serve.session_id, limit: 10, cursor: null },
  );
  assert.equal(response.serve_id, persistence.serve.serve_id);
  assert.equal(persistence.fallbackCalls, 0);
});

test('reservation ownership never falls back or creates a competing serve', async () => {
  const persistence = new FakePersistence();
  const queue = new FakeQueue();
  queue.reserve = async () => { throw new ReservationOwnedError(); };
  await assert.rejects(
    new FeedV2Service(persistence, queue, undefined, false, 1, 0).getFeed(
      '00000000-0000-4000-8000-000000000030',
      { feed_request_id: '00000000-0000-4000-8000-000000000014',
        session_id: '00000000-0000-4000-8000-000000000020', limit: 10, cursor: null },
    ),
    FeedRequestInProgressError,
  );
  assert.equal(persistence.fallbackCalls, 0);
  assert.equal(queue.committed, 0);
  assert.equal(queue.released, 0);
});

test('generation keeps reservation ownership and concurrent retries replay personalized serve', async () => {
  const persistence = new FakePersistence();
  const queue = new FakeQueue();
  let owner: string | null = null;
  let generationStarted!: () => void;
  let finishGeneration!: () => void;
  const started = new Promise<void>((resolve) => { generationStarted = resolve; });
  const finish = new Promise<void>((resolve) => { finishGeneration = resolve; });

  queue.reserve = async (_user, _version, requestId, _limit, token) => {
    if (owner && owner !== token) throw new ReservationOwnedError();
    owner = token;
    return { requestId, token, items: [] };
  };
  queue.refill = async (_user, _version, requestId, _limit, token) => {
    if (owner !== token) throw new ReservationOwnedError();
    return { requestId, token, items: [{
      repo_id: repo.repo_id, score: 1, source: 'semantic', model_version: 'm1', summary_id: null,
    }] };
  };
  queue.commit = async () => {
    if (!owner) return false;
    owner = null;
    queue.committed++;
    return true;
  };

  const service = new FeedV2Service(persistence, queue, async () => {
    generationStarted();
    await finish;
    return { status: 'generated', feedVersion: 3n, count: 1 };
  }, true, 1_000, 1);
  const userId = '00000000-0000-4000-8000-000000000030';
  const request = {
    feed_request_id: '00000000-0000-4000-8000-000000000015',
    session_id: '00000000-0000-4000-8000-000000000020', limit: 10, cursor: null,
  };

  const original = service.getFeed(userId, request);
  await started;
  const retry = service.getFeed(userId, request);
  finishGeneration();
  const [originalResponse, retryResponse] = await Promise.all([original, retry]);

  assert.equal(originalResponse.source, 'personalized');
  assert.deepEqual(retryResponse, originalResponse);
  assert.equal(persistence.fallbackCalls, 0);
  assert.equal(queue.released, 0);
  assert.equal(queue.committed, 1);
});

test('coalesced generation waits for the lock owner to populate the queue', async () => {
  const persistence = new FakePersistence();
  const queue = new FakeQueue();
  const available: FeedReservation['items'] = [];
  let observeEmptyQueue!: () => void;
  const waitingForQueue = new Promise<void>(resolve => { observeEmptyQueue = resolve; });
  let refillCalls = 0;
  queue.reserve = async (_user, _version, requestId, _limit, token) => ({ requestId, token, items: [] });
  queue.depth = async () => {
    const depth = available.length;
    observeEmptyQueue();
    return depth;
  };
  queue.refill = async (_user, _version, requestId, limit, token) => {
    refillCalls++;
    return {
      requestId,
      token,
      items: available.splice(0, limit),
    };
  };
  const service = new FeedV2Service(
    persistence,
    queue,
    async () => ({ status: 'coalesced', feedVersion: 3n }),
    true,
    1_500,
    1,
    'unit-test-feed-cursor-secret',
    100,
  );
  const responsePromise = service.getFeed(
    '00000000-0000-4000-8000-000000000030',
    {
      feed_request_id: '00000000-0000-4000-8000-000000000016',
      session_id: '00000000-0000-4000-8000-000000000020', limit: 10, cursor: null,
    },
  );
  await waitingForQueue;
  // Model the independent lock owner publishing items, not a refill side effect.
  available.push({
    repo_id: repo.repo_id, score: 1, source: 'semantic', model_version: 'm1', summary_id: null,
  });
  const response = await responsePromise;
  assert.equal(response.source, 'personalized');
  assert.equal(response.items[0].repo_id, repo.repo_id);
  assert.equal(refillCalls, 2);
  assert.equal(persistence.fallbackCalls, 0);
});

test('signed cursor consumes remaining queue pages and preserves global positions', async () => {
  const persistence = new FakePersistence();
  const queue = new FakeQueue();
  const available = [1, 2, 3].map((index) => ({
    repo_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    score: index, source: 'semantic', model_version: 'm1', summary_id: null,
  }));
  queue.reserve = async (_user, _version, requestId, limit, token) => ({
    requestId, token, items: available.splice(0, limit),
  });
  queue.depth = async () => available.length;
  const service = new FeedV2Service(
    persistence, queue, undefined, false, 1_500, 25, 'unit-test-feed-cursor-secret',
  );
  const userId = '00000000-0000-4000-8000-000000000030';
  const sessionId = '00000000-0000-4000-8000-000000000020';
  const firstRequest = {
    feed_request_id: '00000000-0000-4000-8000-000000000021', session_id: sessionId, limit: 2, cursor: null,
  };
  const first = await service.getFeed(userId, firstRequest);
  assert.deepEqual(first.items.map((item) => item.position), [0, 1]);
  assert.ok(first.next_cursor);
  assert.deepEqual(await service.getFeed(userId, firstRequest), first);

  const second = await service.getFeed(userId, {
    feed_request_id: '00000000-0000-4000-8000-000000000022',
    session_id: sessionId, limit: 2, cursor: first.next_cursor,
  });
  assert.deepEqual(second.items.map((item) => item.position), [2]);
  assert.equal(second.next_cursor, null);
});

test('feed cursor rejects tampering and stale feed versions', async () => {
  const persistence = new FakePersistence();
  const queue = new FakeQueue();
  const remaining = [{ repo_id: repo.repo_id, score: 1, source: 'semantic', model_version: 'm1', summary_id: null }];
  queue.reserve = async (_user, _version, requestId, _limit, token) => ({ requestId, token, items: remaining.splice(0, 1) });
  queue.depth = async () => 1;
  const service = new FeedV2Service(
    persistence, queue, undefined, false, 1_500, 25, 'unit-test-feed-cursor-secret',
  );
  const userId = '00000000-0000-4000-8000-000000000030';
  const sessionId = '00000000-0000-4000-8000-000000000020';
  const first = await service.getFeed(userId, {
    feed_request_id: '00000000-0000-4000-8000-000000000023', session_id: sessionId, limit: 1, cursor: null,
  });
  assert.ok(first.next_cursor);
  const tampered = `${first.next_cursor.slice(0, -1)}${first.next_cursor.endsWith('A') ? 'B' : 'A'}`;
  await assert.rejects(service.getFeed(userId, {
    feed_request_id: '00000000-0000-4000-8000-000000000024', session_id: sessionId, limit: 1, cursor: tampered,
  }), /invalid or stale/);
  persistence.version = 4n;
  await assert.rejects(service.getFeed(userId, {
    feed_request_id: '00000000-0000-4000-8000-000000000025', session_id: sessionId, limit: 1, cursor: first.next_cursor,
  }), /invalid or stale/);
});

test('feed replay cache-hit service p95 stays below 250ms', async () => {
  const persistence = new FakePersistence();
  const queue = new FakeQueue();
  const service = new FeedV2Service(persistence, queue);
  const request = { feed_request_id: '00000000-0000-4000-8000-000000000012',
    session_id: '00000000-0000-4000-8000-000000000020', limit: 10, cursor: null };
  await service.getFeed('00000000-0000-4000-8000-000000000030', request);
  const samples: number[] = [];
  for (let index = 0; index < 250; index++) {
    const started = performance.now();
    await service.getFeed('00000000-0000-4000-8000-000000000030', request);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  assert.ok(samples[Math.floor(samples.length * 0.95)] < 250);
});

test('depleting one generated batch keeps a cursor and refills with the same browsing session',async()=>{
  const persistence=new FakePersistence(); const queue=new FakeQueue(); let generationArgs:unknown[]=[];
  let available=true;
  queue.reserve=async(_u,_v,requestId,_limit,token)=>({requestId,token,items:available?[{repo_id:repo.repo_id,score:1,source:'semantic',model_version:'m1',summary_id:null}]:[]});
  queue.refill=async(_u,_v,requestId,_limit,token)=>({requestId,token,items:[]});
  const service=new FeedV2Service(persistence,queue,async(...args:unknown[])=>{generationArgs=args;return {status:'generated',feedVersion:3n,count:0};},false,1500,25,'cursor-secret');
  const request={feed_request_id:'00000000-0000-4000-8000-000000000081',session_id:'00000000-0000-4000-8000-000000000082',limit:10,cursor:null};
  const viewer='00000000-0000-4000-8000-000000000083';
  const first=await service.getFeed(viewer,request);
  assert.ok(first.next_cursor,'queue depletion must not prematurely end a personalized feed');
  available=false;
  const end=await service.getFeed(viewer,{...request,feed_request_id:'00000000-0000-4000-8000-000000000084',cursor:first.next_cursor});
  assert.deepEqual(generationArgs,[viewer,10,[],request.session_id]);
  assert.deepEqual(end.items,[]);
  assert.equal(end.next_cursor,null);
});

test('configured fallback also excludes viewed and current-session repositories',async()=>{
  const persistence=new FakePersistence();const queue=new FakeQueue();let received:string[]=[];
  const viewed='00000000-0000-4000-8000-000000000097';
  persistence.listExcludedRepositoryIds=async()=>[viewed];
  persistence.getTrendingFallback=async(_limit,excluded)=>{received=excluded;return [repo];};
  queue.reserve=async()=>{throw new Error('offline');};
  const response=await new FeedV2Service(persistence,queue,undefined,true).getFeed('00000000-0000-4000-8000-000000000030',{
    feed_request_id:'00000000-0000-4000-8000-000000000096',session_id:'00000000-0000-4000-8000-000000000095',limit:10,cursor:null,
  });
  assert.equal(response.source,'fallback');
  assert.deepEqual(received,[viewed]);
});

for (const failureStage of ['reserve', 'generate', 'refill', 'coalesced', 'stale', 'version-race', 'consumed'] as const) {
  test(`continuation ${failureStage} failure stays retryable without persisting exhaustion`, async () => {
    const persistence = new FakePersistence();
    const queue = new FakeQueue();
    let fail = false;
    let recovered = false;
    const reserve = queue.reserve.bind(queue);
    queue.reserve = async (...args) => {
      if (fail && !recovered && failureStage === 'reserve') throw new Error('redis unavailable');
      if (fail) return { requestId: args[2], token: args[4], items: [] };
      return reserve(...args);
    };
    queue.refill = async (...args) => {
      if (!recovered && failureStage === 'refill') throw new Error('refill unavailable');
      return recovered ? reserve(...args) : { requestId: args[2], token: args[4], items: [] };
    };
    const service = new FeedV2Service(persistence, queue, async () => {
      if (recovered) return { status: 'generated', feedVersion: 3n, count: 1 };
      if (failureStage === 'generate') throw new Error('ml unavailable');
      if (failureStage === 'version-race') return { status: 'generated', feedVersion: 4n, count: 1 };
      if (failureStage === 'consumed') return { status: 'generated', feedVersion: 3n, count: 45 };
      return { status: failureStage === 'stale' ? 'stale' : failureStage === 'coalesced' ? 'coalesced' : 'generated', feedVersion: 3n, count: 0 };
    }, true, 1, 1, 'cursor-secret', 1);
    const viewer = '00000000-0000-4000-8000-000000000030';
    const request = { feed_request_id: '00000000-0000-4000-8000-000000000090',
      session_id: '00000000-0000-4000-8000-000000000020', limit: 10, cursor: null };
    const first = await service.getFeed(viewer, request);
    const continuation = { ...request, feed_request_id: '00000000-0000-4000-8000-000000000091', cursor: first.next_cursor };
    fail = true;
    await assert.rejects(service.getFeed(viewer, continuation),
      ['coalesced', 'stale', 'version-race', 'consumed'].includes(failureStage) ? FeedRequestInProgressError : /unavailable/);
    assert.equal(persistence.serve?.feed_request_id, request.feed_request_id);
    assert.equal(persistence.fallbackCalls, 0);
    assert.ok(queue.released > 0, 'release only this request token so a same-id retry can proceed');
    recovered = true;
    const next = await service.getFeed(viewer, continuation);
    assert.equal(next.items.length, 1);
    assert.equal(next.items[0].position, 1);
    assert.equal(persistence.serve?.feed_request_id, continuation.feed_request_id);
  });
}

test('validated empty ML success ends continuation without opening the circuit', async () => {
  let calls = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      calls++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ schema_version: 2, generation_id: input.generation_id,
        user_id: input.user_id, feed_version: ordinaryFeedVersion(input.feed_version),
        model_version: 'test-heavy', embedding_version: 'test-embedding', items: [],
        embedding_versions: [], served_ranker: 'heavy', heavy_ranker_selected: true, ranker_applied: true,
        fallback_code: null, fallback_reason: null, retrieval_mode: 'personalized',
        context_status: { cold_start_applied: input.context.cold_start, locale: 'not_provided' } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const ml = new MlV2Client({ baseUrl: `http://127.0.0.1:${address.port}`, internalSecret: 'test', timeoutMs: 500, maxResponseBytes: 10_000 });
    const persistence = new FakePersistence();
    const queue = new FakeQueue();
    const generation = new FeedGenerationService(persistence, queue, ml);
    const service = new FeedV2Service(persistence, queue,
      (userId, limit, excluded, session) => generation.generate(userId, limit, excluded, 'live', session),
      false, 1, 1, 'cursor-secret');
    const viewer = '00000000-0000-4000-8000-000000000030';
    const request = { feed_request_id: '00000000-0000-4000-8000-000000000093',
      session_id: '00000000-0000-4000-8000-000000000020', limit: 10, cursor: null };
    const first = await service.getFeed(viewer, request);
    queue.reserve = async (_u, _v, requestId, _l, token) => ({ requestId, token, items: [] });
    queue.refill = queue.reserve;
    const next = { ...request, feed_request_id: '00000000-0000-4000-8000-000000000094', cursor: first.next_cursor };
    const empty = await service.getFeed(viewer, next);
    assert.deepEqual(empty.items, []);
    assert.equal(empty.next_cursor, null);
    assert.deepEqual(await service.getFeed(viewer, next), empty);
    // A valid empty result is not a dependency failure, including after the circuit threshold.
    for (let index = 0; index < 6; index++) {
      await service.getFeed(viewer, { ...next, feed_request_id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}` });
    }
    assert.equal(calls, 7);
    assert.equal(persistence.fallbackCalls, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

for (const fallbackEnabled of [false, true]) {
  test(`successful empty first-page generation does not replay history or fallback (${fallbackEnabled})`, async () => {
    const persistence = new FakePersistence();
    persistence.recentPersonalized = [{ repo_id: repo.repo_id, score: 1, source: 'semantic', model_version: 'old', summary_id: null }];
    let historyReads = 0;
    persistence.getRecentPersonalizedEntries = async () => { historyReads++; return persistence.recentPersonalized; };
    const queue = new FakeQueue();
    queue.reserve = async (_u, _v, requestId, _l, token) => ({ requestId, token, items: [] });
    const service = new FeedV2Service(persistence, queue,
      async () => ({ status: 'generated', feedVersion: 3n, count: 0 }), fallbackEnabled);
    const request = { feed_request_id: '00000000-0000-4000-8000-000000000071',
      session_id: '00000000-0000-4000-8000-000000000020', limit: 10, cursor: null };
    const result = await service.getFeed('00000000-0000-4000-8000-000000000030', request);
    assert.deepEqual(result.items, []);
    assert.equal(result.next_cursor, null);
    assert.equal(historyReads, 0);
    assert.equal(persistence.fallbackCalls, 0);
    assert.deepEqual(await service.getFeed('00000000-0000-4000-8000-000000000030', request), result);
  });
}

test('fallback serves reuse only the freshly hydrated cards for the requesting viewer',async()=>{
  const persistence=new FakePersistence();
  const queue=new FakeQueue();
  queue.reserve=async(_u,_v,requestId,_l,token)=>({requestId,token,items:[]});
  let extraHydrations=0;
  persistence.listActiveRepositories=async()=>{extraHydrations++;throw new Error('Duplicate fallback hydration');};
  const service=new FeedV2Service(persistence,queue,undefined,true);
  const viewer='00000000-0000-4000-8000-000000000030';
  const result=await service.getFeed(viewer,{
    feed_request_id:'00000000-0000-4000-8000-000000000090',
    session_id:'00000000-0000-4000-8000-000000000020',limit:10,cursor:null,
  });
  assert.equal(result.source,'fallback');
  assert.equal(persistence.fallbackViewerId,viewer);
  assert.equal(persistence.fallbackCalls,1);
  assert.equal(extraHydrations,0);
  assert.equal(result.items[0].repo_id,repo.repo_id);
});

test('foreground budget expires while one real generation continues, coalesces retries, and drains', async () => {
  const { snapshotMetrics } = await import('../../observability/metrics.js');
  const metricKey = 'feed_v2_generation_after_wait_total:[["outcome","generated"]]';
  const before = (snapshotMetrics().counters as Record<string, number>)[metricKey] ?? 0;
  const persistence = new FakePersistence();
  const queue = new FakeQueue();
  queue.reserve = async (_u, _v, requestId, _limit, token) => ({ requestId, token, items: [] });
  let ready = false;
  queue.refill = async (_u, _v, requestId, _limit, token) => ({ requestId, token,
    items: ready ? [{ repo_id: repo.repo_id, score: 1, source: 'semantic', model_version: 'm1', summary_id: null }] : [],
  });
  let finish!: () => void;
  const dependency = new Promise<void>(resolve => { finish = resolve; });
  let calls = 0;
  const service = new FeedV2Service(persistence, queue, async () => {
    calls++;
    await dependency;
    ready = true;
    return { status: 'generated', feedVersion: 3n, count: 1 };
  }, true, 1500, 1, 'test-secret', 5);
  const request = { feed_request_id: 'request-0', session_id: 'session', limit: 10, cursor: null };
  try {
    for (let index = 0; index < 12; index++) {
      const response = await service.getFeed('viewer', { ...request, feed_request_id: `request-${index}` });
      assert.equal(response.source, 'fallback');
    }
    assert.equal(calls, 1, 'observer expiry cannot launch another generation');
    // Inspect bounded ownership, not implementation-specific timer counts.
    const records = (service as unknown as { generations: Map<string, { observers: Set<unknown> }> }).generations;
    assert.equal(records.size, 1);
    assert.equal([...records.values()][0].observers.size, 0, 'expired observers must not accumulate on stuck work');
    let drained = false;
    const stop = service.stop().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false, 'shutdown owns actual work after every observer returned');
    finish();
    await stop;
    assert.equal(ready, true);
    assert.equal(records.size, 0);
    assert.equal((snapshotMetrics().counters as Record<string, number>)[metricKey] - before, 1,
      'late work is counted once per actual generation, not once per expired observer');
  } finally { finish(); await service.stop(); }
});

test('background generation admission stays bounded after foreground callers time out', async () => {
  const persistence = new FakePersistence();
  persistence.getServeByRequest = async () => null;
  const queue = new FakeQueue();
  queue.reserve = async (_u, _v, requestId, _limit, token) => ({ requestId, token, items: [] });
  let finish!: () => void;
  const dependency = new Promise<void>(resolve => { finish = resolve; });
  let calls = 0;
  const service = new FeedV2Service(persistence, queue, async () => {
    calls++; await dependency; return { status: 'generated', feedVersion: 3n, count: 0 };
  }, false, 1500, 1, 'test-secret', 2);
  try {
    const results = await Promise.allSettled(Array.from({ length: 129 }, (_unused, index) => service.getFeed(`viewer-${index}`, {
      feed_request_id: `request-${index}`, session_id: 'session', limit: 10, cursor: null,
    })));
    assert.ok(results.every(result => result.status === 'rejected' && result.reason instanceof PersonalizedFeedUnavailableError));
    assert.equal(calls, 128, 'the unobserved generation must retain its admission slot');
  } finally { finish(); await service.stop(); }
});

test('continuation generation wait expiry remains retryable and never falls back', async () => {
  const persistence = new FakePersistence();
  const queue = new FakeQueue();
  let finish!: () => void;
  const dependency = new Promise<void>(resolve => { finish = resolve; });
  const service = new FeedV2Service(persistence, queue, async () => {
    await dependency; return { status: 'generated', feedVersion: 3n, count: 0 };
  }, true, 1500, 1, 'test-secret', 2);
  const request = { feed_request_id: 'first-page', session_id: 'session', limit: 10, cursor: null };
  try {
    const first = await service.getFeed('viewer', request);
    assert.ok(first.next_cursor);
    queue.reserve = async (_u, _v, requestId, _limit, token) => ({ requestId, token, items: [] });
    await assert.rejects(service.getFeed('viewer', { ...request, feed_request_id: 'continuation', cursor: first.next_cursor }),
      FeedRequestInProgressError);
    assert.equal(persistence.fallbackCalls, 0);
    assert.equal(persistence.serve?.feed_request_id, request.feed_request_id);
    assert.ok(queue.released > 0);
  } finally { finish(); await service.stop(); }
});

for (const publishBeforeRecoveryCommit of [false, true]) {
  test(`durable recovery cannot repeat after a late generation publishes (${publishBeforeRecoveryCommit ? 'publication races recovery commit' : 'publication follows recovery'})`, async () => {
    const recoveredId = repo.repo_id;
    const freshId = '00000000-0000-4000-8000-000000000002';
    const recoveryEntry = { repo_id: recoveredId, score: 1, source: 'semantic', model_version: 'old', summary_id: null };
    const serves = new Map<string, StoredServe>();
    const persistence = new FakePersistence();
    persistence.recentPersonalized = [recoveryEntry];
    persistence.getServeByRequest = async (_user, requestId) => serves.get(requestId!) ?? null;
    Object.assign(persistence, { listServedRepositoryIds: async (user: string, session: string, ids: string[]) => {
      const candidates = new Set(ids);
      return [...serves.values()].filter(serve => serve.user_id === user && serve.session_id === session)
        .flatMap(serve => serve.items.map(item => item.repo_id)).filter(id => candidates.has(id));
    } });
    let recoveryStarted!: () => void;
    const recovering = new Promise<void>(resolve => { recoveryStarted = resolve; });
    let commitRecovery!: () => void;
    const recoveryGate = new Promise<void>(resolve => { commitRecovery = resolve; });
    const createServe = persistence.createServe.bind(persistence);
    persistence.createServe = async input => {
      if (input.feed_request_id === 'recovery') {
        recoveryStarted();
        if (publishBeforeRecoveryCommit) await recoveryGate;
      }
      const stored = await createServe(input);
      serves.set(input.feed_request_id, stored);
      return stored;
    };
    const queued: RecommendationEntry[] = [];
    const reservations = new Map<string, RecommendationEntry[]>();
    const queue = new FakeQueue();
    queue.reserve = async (_u, _v, requestId, limit, token) => {
      if (!reservations.has(token)) reservations.set(token, queued.splice(0, limit));
      return { requestId, token, items: reservations.get(token)!, remainingDepth: queued.length };
    };
    queue.refill = async (_u, _v, requestId, limit, token, discarded: string[] = []) => {
      const held = reservations.get(token)!.filter(entry => !discarded.includes(entry.repo_id));
      reservations.set(token, held);
      held.push(...queued.splice(0, limit));
      return { requestId, token, items: held, remainingDepth: queued.length };
    };
    queue.commit = async (_u, _v, _requestId, token) => { queue.committed++; return reservations.delete(token); };
    queue.release = async (_u, _v, _requestId, token) => {
      const held = reservations.get(token);
      if (!held) return false;
      queued.unshift(...held); return reservations.delete(token);
    };
    let published!: () => void;
    const publication = new Promise<void>(resolve => { published = resolve; });
    queue.publishGeneration = async (_u, _v, _token, entries) => {
      queued.splice(0, queued.length, ...entries); published(); return true;
    };
    let finishModel!: () => void;
    const modelGate = new Promise<void>(resolve => { finishModel = resolve; });
    const generation = new FeedGenerationService(persistence, queue, { async generate(input) {
      assert.deepEqual(input.exclude_repo_ids, [], 'the running generation predates recovery delivery');
      await modelGate;
      return { schema_version: 2, generation_id: input.generation_id, user_id: input.user_id,
        feed_version: ordinaryFeedVersion(input.feed_version), model_version: 'new', embedding_version: 'test',
        embedding_versions: ['test'], served_ranker: 'hybrid', heavy_ranker_selected: false, ranker_applied: false,
        fallback_code: null, fallback_reason: null, retrieval_mode: 'hybrid',
        context_status: { cold_start_applied: false, locale: 'not_provided' },
        items: [recoveredId, freshId].map(repo_id => ({ repo_id, score: 1, source: 'semantic' })),
      };
    } });
    const service = new FeedV2Service(persistence, queue,
      (user, limit, excluded, session) => generation.generate(user, limit, excluded, 'live', session),
      false, 1500, 1, 'test-secret', 5);
    const request = { feed_request_id: 'recovery', session_id: 'session', limit: 1, cursor: null };
    try {
      const recoveringPage = service.getFeed('viewer', request);
      await recovering;
      if (publishBeforeRecoveryCommit) { finishModel(); await publication; commitRecovery(); }
      const first = await recoveringPage;
      assert.deepEqual(first.items.map(item => item.repo_id), [recoveredId]);
      assert.ok(first.next_cursor);
      finishModel(); await publication;
      const next = await service.getFeed('viewer', { ...request, feed_request_id: 'continuation', cursor: first.next_cursor });
      assert.deepEqual(next.items.map(item => item.repo_id), [freshId]);
      assert.equal(next.items[0].position, 1, 'discarding duplicate queue entries must not advance the cursor');
      assert.deepEqual(await service.getFeed('viewer', { ...request, feed_request_id: 'continuation', cursor: first.next_cursor }), next);
      assert.equal(queue.committed, 2, 'discard/refill retains ownership until the fresh continuation commits');
    } finally { finishModel(); commitRecovery(); await service.stop(); }
  });
}

test('all-duplicate queue batches are retired with bounded work and never persist a false end', async () => {
  const persistence = new FakePersistence();
  Object.assign(persistence, { listServedRepositoryIds: async (_u: string, _s: string, ids: string[]) => ids });
  const queue = new FakeQueue();
  let refills = 0;
  queue.refill = async (...args) => { refills++; return queue.reserve(...args); };
  const service = new FeedV2Service(persistence, queue, undefined, false, 1500, 1, 'test-secret');
  await assert.rejects(service.getFeed('viewer', { feed_request_id: 'duplicate-batches', session_id: 'session', limit: 1, cursor: null }),
    FeedRequestInProgressError);
  assert.equal(refills, 4);
  assert.equal(queue.committed, 0, 'bounded filtering retains the same reservation ownership');
  assert.equal(persistence.serve, null, 'filtered nonempty input is not evidence of exhaustion');
});

test('final durable delivery overlap stays retryable and releases only its reservation', async () => {
  const { FeedServeOverlapError } = await import('../../ports/feedPersistencePort.js');
  const persistence = new FakePersistence();
  persistence.createServe = async () => { throw new FeedServeOverlapError(); };
  const queue = new FakeQueue();
  await assert.rejects(new FeedV2Service(persistence, queue).getFeed('viewer', {
    feed_request_id: 'overlap', session_id: 'session', limit: 1, cursor: null,
  }), FeedRequestInProgressError);
  assert.equal(queue.committed, 0);
  assert.equal(queue.released, 1);
});

test('losing reservation ownership during duplicate retirement waits for the durable same-ID serve', async () => {
  const persistence = new FakePersistence();
  const queue = new FakeQueue();
  const request = { feed_request_id: 'same-id', session_id: 'session', limit: 1, cursor: null };
  await persistence.createServe({ ...request, user_id: 'viewer', feed_version: 3n, generation_id: null,
    source: 'personalized', model_version: 'test', next_cursor: null,
    items: [{ repo_id: repo.repo_id, score: 1, source: 'semantic', model_version: 'test', summary_id: null,
      position: 0, repository: repo }],
  });
  persistence.missesBeforeServe = 1;
  Object.assign(persistence, { listServedRepositoryIds: async (_u: string, _s: string, ids: string[]) => ids });
  queue.refill = async () => { throw new ReservationOwnedError(); };
  const result = await new FeedV2Service(persistence, queue, undefined, false, 100, 1).getFeed('viewer', request);
  assert.equal(result.serve_id, persistence.serve?.serve_id);
  assert.equal(queue.committed, 0);
});

test('session membership compares UUID identities rather than their serialized case', async () => {
  const persistence = new FakePersistence();
  const delivered = 'aaaaaaaa-0000-4000-8000-000000000001';
  Object.assign(persistence, { listServedRepositoryIds: async (_u: string, _s: string, ids: string[]) =>
    ids.some(id => id.toLowerCase() === delivered) ? [delivered] : [],
  });
  const queue = new FakeQueue();
  queue.reserve = async (_u, _v, requestId, _limit, token) => ({ requestId, token,
    items: [{ repo_id: delivered.toUpperCase(), score: 1, source: 'semantic', model_version: 'test', summary_id: null }],
  });
  queue.refill = async (_u, _v, requestId, _limit, token, discarded: string[] = []) => {
    assert.deepEqual(discarded, [delivered.toUpperCase()], 'Redis retires the exact stored representation');
    return { requestId, token, items: [{ repo_id: repo.repo_id, score: 1, source: 'semantic', model_version: 'test', summary_id: null }] };
  };
  const page = await new FeedV2Service(persistence, queue).getFeed('viewer', {
    feed_request_id: 'uuid-alias', session_id: 'session', limit: 1, cursor: null,
  });
  assert.deepEqual(page.items.map(item => item.repo_id), [repo.repo_id]);
});

for (const source of ['queued','durable','fallback'] as const) {
  test(`current dislikes exclude ${source} entries without creating a terminal empty serve`, async()=>{
    const persistence=new FakePersistence();const queue=new FakeQueue();
    persistence.listPreferenceEligibleRepositoryIds=async()=>[];
    if(source!=='queued')queue.reserve=async()=>{throw new Error('owned fixture Redis outage');};
    if(source==='durable')persistence.recentPersonalized=[{repo_id:repo.repo_id,score:1,source:'semantic',model_version:'m1',summary_id:null}];
    const service=new FeedV2Service(persistence,queue,undefined,source==='fallback');
    await assert.rejects(service.getFeed('00000000-0000-4000-8000-000000000030',{
      feed_request_id:'00000000-0000-4000-8000-000000000010',session_id:'00000000-0000-4000-8000-000000000020',limit:10,cursor:null,
    }),FeedRequestInProgressError);
    assert.equal(persistence.serve,null);
  });
}

test('historical same-request replay bypasses current-negative eligibility reads',async()=>{
  const persistence=new FakePersistence();const queue=new FakeQueue();
  const service=new FeedV2Service(persistence,queue);
  const request={feed_request_id:'00000000-0000-4000-8000-000000000010',session_id:'00000000-0000-4000-8000-000000000020',limit:10,cursor:null};
  const first=await service.getFeed('00000000-0000-4000-8000-000000000030',request);
  persistence.listPreferenceEligibleRepositoryIds=async()=>{throw new Error('Replay must not consult current preferences');};
  assert.deepEqual(await service.getFeed('00000000-0000-4000-8000-000000000030',request),first);
});

test('late empty generation is retained for the same request and session retry', async () => {
  const persistence = new FakePersistence(); const queue = new FakeQueue();
  queue.reserve = async (_u, _v, requestId, _l, token) => ({ requestId, token, items: [] });
  queue.refill = queue.reserve;
  let finish!: () => void; let calls = 0;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const service = new FeedV2Service(persistence, queue, async () => {
    calls++; await held; return { status: 'generated', feedVersion: 3n, count: 0 };
  }, false, 100, 1, 'test', 5);
  const request = { feed_request_id: 'late-empty', session_id: 'session', limit: 10, cursor: null };
  try {
    await assert.rejects(service.getFeed('viewer', request));
    finish(); await new Promise(resolve => setImmediate(resolve));
    const result = await service.getFeed('viewer', request);
    assert.deepEqual(result.items, []); assert.equal(result.next_cursor, null);
    assert.equal(calls, 1);
  } finally { finish(); await service.stop(); }
});

test('an empty generation shared from another session remains retryable', async () => {
  const persistence = new FakePersistence(); const queue = new FakeQueue();
  queue.reserve = async (_u, _v, requestId, _l, token) => ({ requestId, token, items: [] });
  queue.refill = queue.reserve;
  let finish!: () => void; let calls = 0;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const service = new FeedV2Service(persistence, queue, async () => {
    calls++; if (calls === 1) await held;
    return { status: 'generated', feedVersion: 3n, count: 0 };
  }, false, 100, 1, 'test', 100);
  const first = service.getFeed('viewer', {
    feed_request_id: 'session-a-request', session_id: 'session-a', limit: 10, cursor: null,
  });
  const second = service.getFeed('viewer', {
    feed_request_id: 'session-b-request', session_id: 'session-b', limit: 10, cursor: null,
  });
  try {
    finish();
    assert.deepEqual((await first).items, []);
    await assert.rejects(second, FeedRequestInProgressError);
    assert.equal(persistence.serve?.feed_request_id, 'session-a-request');
    const retried = await service.getFeed('viewer', {
      feed_request_id: 'session-b-request', session_id: 'session-b', limit: 10, cursor: null,
    });
    assert.deepEqual(retried.items, []);
    assert.equal(calls, 2, 'the second session must generate against its own delivery history');
  } finally { finish(); await service.stop(); }
});

test('a negative preference winning at durable creation maps to a retryable feed response',async()=>{
  const {FeedPreferenceChangedError}=await import('../../ports/feedPersistencePort.js');
  const persistence=new FakePersistence();const queue=new FakeQueue();
  persistence.createServe=async()=>{throw new FeedPreferenceChangedError();};
  await assert.rejects(new FeedV2Service(persistence,queue).getFeed('00000000-0000-4000-8000-000000000030',{
    feed_request_id:'00000000-0000-4000-8000-000000000010',session_id:'00000000-0000-4000-8000-000000000020',limit:10,cursor:null,
  }),FeedRequestInProgressError);
  assert.equal(queue.committed,0);assert.equal(queue.released,1);
});

for (const failure of ['redis', 'generation'] as const) {
  test(`empty eligible fallback after ${failure} failure stays unavailable without a durable empty serve`, async () => {
    const persistence = new FakePersistence();
    persistence.getTrendingFallback = async () => [];
    const queue = new FakeQueue();
    queue.reserve = async (_u, _v, requestId, _l, token) => {
      if (failure === 'redis') throw new Error('offline');
      return { requestId, token, items: [] };
    };
    const service = new FeedV2Service(persistence, queue,
      async () => { throw new Error('ML offline'); }, true);
    await assert.rejects(service.getFeed('00000000-0000-4000-8000-000000000030', {
      feed_request_id: '00000000-0000-4000-8000-000000000096',
      session_id: '00000000-0000-4000-8000-000000000095', limit: 10, cursor: null,
    }), PersonalizedFeedUnavailableError);
    assert.equal(persistence.serve, null);
  });
}

test('capture-required cohorts retire plain queued entries but preserve pre-existing immutable replay', async () => {
  const persistence=new FakePersistence(), queue=new FakeQueue();
  const user='00000000-0000-4000-8000-000000000030';
  const request={feed_request_id:'00000000-0000-4000-8000-000000000010',
    session_id:'00000000-0000-4000-8000-000000000020',limit:10,cursor:null};
  const required=new FeedV2Service(persistence,queue,undefined,false,1500,25,undefined,5000,undefined,()=>true);
  await assert.rejects(required.getFeed(user,request),FeedRequestInProgressError);
  assert.equal(persistence.serve,null,'uncaptured candidates must never become a new captured-cohort serve');
  assert.equal(queue.committed,1,'retire the plain reservation so retry can request a captured generation');
  const original=await new FeedV2Service(persistence,new FakeQueue()).getFeed(user,request);
  assert.deepEqual(await required.getFeed(user,request),original,'capture activation cannot rewrite historical same-request replay');
});


describe('intent scope retirement admission',()=>{
const owner='00000000-0000-4000-8000-000000000001',session='00000000-0000-4000-8000-000000000002';
const snapshot={generationFreshnessMs:60000,userId:owner,sessionId:session,feedVersion:'1',profileVersion:'1',acceptedOperationVersion:'2',feedbackVersion:'0',
 epoch:'1',epochStartedMs:'1',witnessSha256:'a'.repeat(64),policySha256:'b'.repeat(64)};
const scope:FeedIntentScope={...snapshot,queueScope:'c'.repeat(64),context:{schema_version:1,session_id:session,epoch:'1',as_of_ms:'1',
 policy_sha256:snapshot.policySha256,minimum_applied_operation_version:'2',required_profile_version:'1'},
 applied:{schema_version:1,user_id:owner,session_id:session,epoch:'1',as_of_ms:'1',policy_sha256:snapshot.policySha256,profile_version:'1',
  applied_operation_version:'2',applied_feedback_version:'0',state_sha256:'d'.repeat(64),head:'e'.repeat(64),effective_vector_sha256:'f'.repeat(64),
  session_witness_sha256:snapshot.witnessSha256,valid_until_ms:String(Date.now()+60000),explicit_negative_repo_ids:[]}};
const response:FeedResponseV2={serve_id:owner,session_id:session,feed_version:'1',source:'personalized',model_version:'fixture',items:[],next_cursor:null};
const request={feed_request_id:owner,session_id:session,limit:2,cursor:null};
function cryptoId(index:number){return `00000000-0000-4000-8000-${String(index+100).padStart(12,'0')}`;}
function scoped(index:number):FeedIntentScope {
 const user=cryptoId(index),sessionId=cryptoId(index+1000);
 return {...scope,userId:user,sessionId,queueScope:(index+1).toString(16).padStart(64,'0'),
  context:{...scope.context,session_id:sessionId},applied:{...scope.applied,user_id:user,session_id:sessionId}};
}
test('expired scope drainage does not block an unrelated ready request or escape shutdown', async t => {
 const expired=scoped(200),ready=scoped(201),byUser=new Map([expired,ready].map(value=>[value.userId,value]));
 let release!:()=>void;const drain=new Promise<void>(resolve=>{release=resolve;});let drained=false,delivered=false,stopped=false;
 const gateway=new IntentFeedGateway({getFeed:async()=>response,stop:async()=>{}},{getServeByRequest:async()=>null},{
  snapshot:async userId=>({...snapshot,...byUser.get(userId)!}),restoreCursor:async()=>scope.applied,resolve:async userId=>byUser.get(userId)!,
 },value=>({getFeed:async()=>response,stop:async()=>{if(value===expired){await drain;drained=true;}}}));
 await gateway.getFeed(expired.userId,{...request,session_id:expired.sessionId});
 expired.applied.valid_until_ms='0';
 const started=performance.now();
 const pending=gateway.getFeed(ready.userId,{...request,session_id:ready.sessionId}).then(value=>{delivered=true;return value;});
 let stopping:Promise<void>|undefined;
 try {
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(delivered,true,'a ready user must not await an unrelated expired scope stop');
  assert.equal(drained,false);
  t.diagnostic(JSON.stringify({readyMilliseconds:Math.round((performance.now()-started)*100)/100,retirementStillPending:!drained}));
  stopping=gateway.stop().then(()=>{stopped=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false,'shutdown still owns the detached drain');
 } finally {release();await pending;await (stopping??gateway.stop());}
 assert.equal(drained,true);
});

test('retiring scopes retain capacity while admission waits are bounded and cancellable',async()=>{
 const scopes=Array.from({length:129},(_,index)=>scoped(index+500)),byUser=new Map(scopes.map(value=>[value.userId,value]));
 let release!:()=>void;const drain=new Promise<void>(resolve=>{release=resolve;});let created=0;
 const gateway=new IntentFeedGateway({getFeed:async()=>response,stop:async()=>{}},{getServeByRequest:async()=>null},{
  snapshot:async userId=>({...snapshot,...byUser.get(userId)!}),restoreCursor:async()=>scope.applied,resolve:async userId=>byUser.get(userId)!,
 },()=>{created++;return {getFeed:async()=>response,stop:async()=>{await drain;}};},undefined,40);
 try {
  for(const value of scopes.slice(0,128))await gateway.getFeed(value.userId,{...request,session_id:value.sessionId});
  for(const value of scopes.slice(0,128))value.applied.valid_until_ms='0';
  const next=scopes[128],input={...request,session_id:next.sessionId};
  await assert.rejects(gateway.getFeed(next.userId,input),/MODEL_FEED_CAPACITY/);
  const waiters=(gateway as unknown as {capacityWaiters:Set<()=>void>}).capacityWaiters;
  assert.equal(waiters.size,0,'timed out requests must release their capacity subscription');
  assert.equal(created,128,'pending retirements must not free slots prematurely');
  const controller=new AbortController();const pending=gateway.getFeed(next.userId,input,controller.signal);
  const cancelled=assert.rejects(pending,/cancelled capacity wait/);
  await new Promise(resolve=>setImmediate(resolve));controller.abort(new Error('cancelled capacity wait'));await cancelled;
  assert.equal(waiters.size,0,'cancelled requests must release their capacity subscription');
  assert.equal(created,128);
  release();await new Promise(resolve=>setImmediate(resolve));
  await gateway.getFeed(next.userId,input);assert.equal(created,129);
 } finally {release();await gateway.stop();}
});
test('admission wakes when any retirement finishes, including an earlier expired scope',async()=>{
 const scopes=Array.from({length:129},(_,index)=>scoped(index+1500)),byUser=new Map(scopes.map(value=>[value.userId,value]));
 let releaseFirst!:()=>void,releaseOthers!:()=>void;
 const firstDrain=new Promise<void>(resolve=>{releaseFirst=resolve;}),otherDrain=new Promise<void>(resolve=>{releaseOthers=resolve;});
 let created=0,delivered=false;
 const gateway=new IntentFeedGateway({getFeed:async()=>response,stop:async()=>{}},{getServeByRequest:async()=>null},{
  snapshot:async userId=>({...snapshot,...byUser.get(userId)!}),restoreCursor:async()=>scope.applied,resolve:async userId=>byUser.get(userId)!,
 },value=>{created++;return {getFeed:async()=>response,stop:async()=>{await (value===scopes[0]?firstDrain:otherDrain);}};});
 let pending:Promise<FeedResponseV2>|undefined;
 try {
  for(const value of scopes.slice(0,128))await gateway.getFeed(value.userId,{...request,session_id:value.sessionId});
  scopes[0].applied.valid_until_ms='0';
  const next=scopes[128];pending=gateway.getFeed(next.userId,{...request,session_id:next.sessionId}).then(value=>{delivered=true;return value;});
  await new Promise(resolve=>setImmediate(resolve));releaseFirst();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(delivered,true,'an earlier drain frees room even while the newly selected idle service is still stopping');
  assert.equal(created,129);
 } finally {releaseFirst();releaseOthers();await pending;await gateway.stop();}
});
test('competing admissions share one timeout budget across lost capacity races',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let now=0;t.mock.method(performance,'now',()=>now);
 const scopes=Array.from({length:130},(_,index)=>scoped(index+1800)),byUser=new Map(scopes.map(value=>[value.userId,value]));
 let releaseFirst!:()=>void,releaseOthers!:()=>void,releaseActive!:()=>void,created=0;
 const firstDrain=new Promise<void>(resolve=>{releaseFirst=resolve;}),otherDrain=new Promise<void>(resolve=>{releaseOthers=resolve;});
 const active=new Promise<void>(resolve=>{releaseActive=resolve;});let rejected=0;
 const gateway=new IntentFeedGateway({getFeed:async()=>response,stop:async()=>{}},{getServeByRequest:async()=>null},{
  snapshot:async userId=>({...snapshot,...byUser.get(userId)!}),restoreCursor:async()=>scope.applied,resolve:async userId=>byUser.get(userId)!,
 },value=>{created++;return {getFeed:async()=>{if(value===scopes[128]||value===scopes[129])await active;return response;},
  stop:async()=>{await (value===scopes[0]?firstDrain:otherDrain);}};},undefined,100);
 const pending:Promise<FeedResponseV2>[]=[];
 try {
  for(const value of scopes.slice(0,128))await gateway.getFeed(value.userId,{...request,session_id:value.sessionId});
  for(const value of scopes.slice(0,128))value.applied.valid_until_ms='0';
  for(const value of scopes.slice(128)){
   const operation=gateway.getFeed(value.userId,{...request,session_id:value.sessionId});pending.push(operation);
   void operation.catch(error=>{assert.match(String(error),/MODEL_FEED_CAPACITY/);rejected++;});
  }
  await new Promise(resolve=>setImmediate(resolve));now=90;t.mock.timers.tick(90);releaseFirst();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(created,129);assert.equal(rejected,0);
  now=100;t.mock.timers.tick(10);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(rejected,1,'the losing waiter retains only the original 10ms budget');
 } finally {releaseFirst();releaseOthers();releaseActive();await Promise.allSettled(pending);await gateway.stop();}
});

});
