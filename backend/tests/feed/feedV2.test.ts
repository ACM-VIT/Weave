import assert from 'node:assert/strict';
import test from 'node:test';
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
  async commit() { this.committed++; return true; }
  async release() { this.released++; return true; }
  async replace() {}
  async renewGenerationLock() { return true; }
  async publishGeneration() { return true; }
  async depth() { return 0; }
  async acquireGenerationLock() { return true; }
  async releaseGenerationLock() {}
  async scanReservations() { return []; }
  async deleteStaleVersions() { return 0; }
}

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
  let refillCalls = 0;
  queue.reserve = async (_user, _version, requestId, _limit, token) => ({ requestId, token, items: [] });
  queue.refill = async (_user, _version, requestId, _limit, token) => {
    refillCalls++;
    return {
      requestId,
      token,
      items: refillCalls < 3 ? [] : [{
        repo_id: repo.repo_id, score: 1, source: 'semantic', model_version: 'm1', summary_id: null,
      }],
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
  const response = await service.getFeed(
    '00000000-0000-4000-8000-000000000030',
    {
      feed_request_id: '00000000-0000-4000-8000-000000000016',
      session_id: '00000000-0000-4000-8000-000000000020', limit: 10, cursor: null,
    },
  );
  assert.equal(response.source, 'personalized');
  assert.equal(response.items[0].repo_id, repo.repo_id);
  assert.equal(refillCalls, 3);
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
        user_id: input.user_id, feed_version: input.feed_version,
        model_version: 'test-heavy', embedding_version: 'test-embedding', items: [] }));
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
