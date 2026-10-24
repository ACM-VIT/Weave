import { GitHubActivityImportClient, GitHubActivityImportError } from '../../services/githubActivityImport.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test, { describe } from 'node:test';
import { assertDisposableDatabase } from './disposableDatabase.js';

const enabled = process.env.RUN_DATABASE_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();
const integration = enabled ? test : test.skip;
type Preview = { snapshot_id: string; collected_at: string; repository_count: number; expires_in_seconds: number; suggestions: { skills: string[] } };
type Accepted = { repositories_created: number; profile_delivery: string; profile_version: string; replay: boolean };
type Status = { active: boolean; provenance: { source?: string; collected_at?: string } };
const data = async <T>(response: Awaited<ReturnType<typeof fetch>>): Promise<T> => ((await response.json()) as { data: T }).data;

integration('consented public import uses actual HTTP/SQL/Redis, rolls back failures and fences revocation/account races', async () => {
  const redisUrl = new URL(process.env.REDIS_DATABASE_TEST_URL ?? 'redis://127.0.0.1:56388/15');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(redisUrl.hostname) && redisUrl.pathname === '/15');
  Object.assign(process.env, { JWT_SECRET: 'github-consent-disposable-secret', REDIS_URL: redisUrl.toString(),
    SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_KEY: 'fixture', SUPABASE_SERVICE_ROLE_KEY: 'fixture' });
  const [{ default: express }, { default: jwt }, { sqlClient }, { default: redis }, { requireAuth },
    { createGithubImportRouter }, { GitHubImportConsentService }, { GitHubActivityImportClient }, { PostgresFeedPersistence }] = await Promise.all([
    import('express'), import('jsonwebtoken'), import('../../db/index.js'), import('../../config/redis.js'), import('../../middlewares/authMiddleware.js'),
    import('../../routes/githubImportRoutes.js'), import('../../services/githubImportConsentService.js'),
    import('../../services/githubActivityImport.js'), import('../../adapters/postgresFeedPersistence.js'),
  ]);
  const user = crypto.randomUUID(), peer = crypto.randomUUID();
  const githubId = String(crypto.randomInt(1_000_000_000, 2_000_000_000));
  const repoGithubId = String(crypto.randomInt(3_000_000_000, 4_000_000_000));
  const handle = `consent-${githubId}`;
  let providerRequests = 0;
  let hold = false, release!: () => void, arrived!: () => void;
  let blocked = Promise.resolve();
  let reached = Promise.resolve();
  const provider = http.createServer(async (request, response) => {
    providerRequests++;
    const url = new URL(request.url!, 'http://localhost');
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === `/users/${handle}`) response.end(JSON.stringify({ id: githubId, login: handle }));
    else if (url.pathname.endsWith('/repos')) {
      if (hold) { arrived(); await blocked; }
      response.end(JSON.stringify([{ id: repoGithubId, owner: { id: githubId, login: handle }, name: 'public-repo',
        full_name: `${handle}/public-repo`, html_url: `https://github.com/${handle}/public-repo`, private: false,
        visibility: 'public', fork: false, description: 'Sourced public repository', language: 'TypeScript', topics: ['typescript', 'testing'],
        updated_at: '2026-10-01T00:00:00Z', stargazers_count: 17, forks_count: 3, open_issues_count: 2 }]));
    } else if (url.pathname === '/graphql') response.end(JSON.stringify({ data: { user: { databaseId: githubId,
      repositoriesContributedTo: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }));
    else response.end('[]');
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerAddress = provider.address(); if (!providerAddress || typeof providerAddress === 'string') throw new Error('Missing provider address.');
  const collector = new GitHubActivityImportClient({ token: 'fixture-not-real', fetch: (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.github.com');
    return fetch(`http://127.0.0.1:${providerAddress.port}${url.pathname}${url.search}`, init);
  } });
  let pauseSnapshot = false, snapshotEntered!: () => void, releaseSnapshot!: () => void;
  let snapshotGate = Promise.resolve();
  const cache = {
    get: async (key: string) => {
      if (pauseSnapshot) { pauseSnapshot = false; snapshotEntered(); await snapshotGate; }
      return redis.get(key);
    },
    set: redis.set.bind(redis), del: redis.del.bind(redis),
  };
  const service = new GitHubImportConsentService(collector, cache);
  const app = express(); app.use(express.json()); app.use('/api/v2/onboarding/github-import', requireAuth, createGithubImportRouter(service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.listening ? resolve() : server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing API address.');
  const tokens = new Map([user, peer].map(id => [id, jwt.sign({ userId: id, email: 'fixture@invalid.test' }, process.env.JWT_SECRET!, { expiresIn: '1m' })]));
  const send = (path: string, method = 'GET', body?: unknown, actor = user) => fetch(`http://127.0.0.1:${address.port}/api/v2/onboarding/github-import${path}`, {
    method, headers: { Authorization: `Bearer ${tokens.get(actor)}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const functionName = `consent_failure_${user.replaceAll('-', '')}`;
  let triggerCreated = false;
  try {
    for (const id of [user, peer]) {
      await sqlClient`INSERT INTO auth.users(id) VALUES(${id}::uuid)`;
      await sqlClient`INSERT INTO app.users(user_id,username,full_name,date_of_birth,status,github_id,github_handle,github_identity_verified_at,interests,skills,tech_stack)
        VALUES(${id}::uuid,${'consent_'+id.replaceAll('-', '')},'Tarun','2005-01-01','active',
          ${id === user ? githubId : String(BigInt(githubId) + 1n)},${id === user ? handle : 'peer-'+githubId},now(),
          '["manual-interest"]'::jsonb,'["devops"]'::jsonb,'["rust"]'::jsonb)`;
      await sqlClient`INSERT INTO app.user_stats(user_id) VALUES(${id}::uuid)`;
      await sqlClient`INSERT INTO app.user_feed_state(user_id) VALUES(${id}::uuid)`;
    }
    assert.equal((await send('/preview', 'POST', { consent: false })).status, 400);
    assert.equal((await send('/preview', 'POST', { consent: true, user_id: peer })).status, 400);
    assert.equal(providerRequests, 0);
    for (const [suffix, method] of [['', 'GET'], ['/preview', 'POST'], ['/accept', 'POST'], ['', 'DELETE']]) {
      assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/v2/onboarding/github-import${suffix}`, { method })).status, 401);
    }
    const previewResponse = await send('/preview', 'POST', { consent: true });
    assert.equal(previewResponse.status, 200, await previewResponse.clone().text());
    const preview = await data<Preview>(previewResponse);
    assert.equal(providerRequests, 4);
    assert.equal(preview.repository_count, 1);
    assert.ok(preview.expires_in_seconds > 0 && preview.expires_in_seconds <= 300);
    assert.ok(preview.suggestions.skills.includes('Web / Frontend Frameworks'));
    const cached = await data<Preview>(await send('/preview', 'POST', { consent: true }));
    assert.equal(cached.snapshot_id, preview.snapshot_id);
    assert.equal(providerRequests, 4, 'fresh previews are cached without another GitHub collection');
    assert.equal((await send('/accept', 'POST', { snapshot_id: preview.snapshot_id }, peer)).status, 409);
    const cacheKey = `persona:github-import:v1:${user}:${preview.snapshot_id}`;
    const raw = await redis.get(cacheKey); assert.ok(raw);
    assert.ok((await redis.ttl(cacheKey)) > 0 && (await redis.ttl(cacheKey)) <= 300);
    await redis.set(cacheKey, raw.replace('typescript', 'forged-topic'), 'EX', 300);
    assert.equal((await send('/accept', 'POST', { snapshot_id: preview.snapshot_id })).status, 409);
    await redis.set(cacheKey, raw, 'EX', 300);

    // Fail AFTER canonical inserts/profile/outbox writes, proving one rollback.
    await sqlClient.unsafe(`CREATE FUNCTION app.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'disposable consent commit failure'; END $$`);
    await sqlClient.unsafe(`CREATE TRIGGER ${functionName} BEFORE UPDATE OF accepted_at ON app.user_github_imports FOR EACH ROW WHEN (NEW.user_id='${user}'::uuid AND NEW.accepted_at IS NOT NULL) EXECUTE FUNCTION app.${functionName}()`);
    triggerCreated = true;
    assert.equal((await send('/accept', 'POST', { snapshot_id: preview.snapshot_id })).status, 500);
    assert.equal(Number((await sqlClient`SELECT profile_version FROM app.users WHERE user_id=${user}::uuid`)[0].profile_version), 1);
    assert.equal(Number((await sqlClient`SELECT count(*) FROM app.repos WHERE github_id=${repoGithubId}::bigint`)[0].count), 0);
    assert.equal(Number((await sqlClient`SELECT count(*) FROM telemetry.ml_outbox WHERE aggregate_id=${user}::uuid`)[0].count), 0);
    await sqlClient.unsafe(`DROP TRIGGER ${functionName} ON app.user_github_imports; DROP FUNCTION app.${functionName}()`);
    triggerCreated = false;
    // Pause a contender after its durable unaccepted read. The winner accepts
    // and removes the expiring cache before the contender resumes its read.
    snapshotGate = new Promise<void>(resolve => { releaseSnapshot = resolve; });
    const snapshotReached = new Promise<void>(resolve => { snapshotEntered = resolve; });
    pauseSnapshot = true;
    const contender = send('/accept', 'POST', { snapshot_id: preview.snapshot_id });
    await snapshotReached;
    const acceptedResponse = await send('/accept', 'POST', { snapshot_id: preview.snapshot_id });
    releaseSnapshot();
    const concurrentReplay = await contender;
    assert.equal(concurrentReplay.status, 200, await concurrentReplay.clone().text());
    assert.equal((await data<Accepted>(concurrentReplay)).replay, true);
    assert.equal(acceptedResponse.status, 200, await acceptedResponse.clone().text());
    const accepted = await data<Accepted>(acceptedResponse);
    assert.equal(accepted.repositories_created, 1);
    assert.equal(accepted.profile_delivery, 'pending');
    const [profile] = await sqlClient`SELECT * FROM app.users WHERE user_id=${user}::uuid`;
    assert.equal(profile.interests[0], 'manual-interest');
    assert.equal(profile.skills[0], 'devops');
    assert.equal(profile.tech_stack[0], 'rust');
    assert.equal(profile.onboarding_completed, true);
    assert.equal((await new PostgresFeedPersistence().getGenerationContext(user))?.delivered, false);
    const status = await data<Status>(await send(''));
    assert.equal(status.active, true);
    assert.equal(status.provenance.source, 'github_public_activity_v1');
    assert.equal(status.provenance.collected_at, preview.collected_at);
    const replay = await data<Accepted>(await send('/accept', 'POST', { snapshot_id: preview.snapshot_id }));
    assert.equal(replay.replay, true);
    assert.equal(replay.profile_version, accepted.profile_version);
    assert.equal(Number((await sqlClient`SELECT count(*) FROM telemetry.ml_outbox WHERE aggregate_id=${user}::uuid AND job_type='onboard'`)[0].count), 1);
    assert.equal(await redis.get(cacheKey), null);

    await sqlClient`UPDATE app.users SET skills='["later-manual-edit"]'::jsonb WHERE user_id=${user}::uuid`;
    assert.equal((await send('', 'DELETE')).status, 200);
    const [revoked] = await sqlClient`SELECT interests,skills,tech_stack FROM app.users WHERE user_id=${user}::uuid`;
    assert.deepEqual(revoked.interests, ['manual-interest']);
    assert.deepEqual(revoked.skills, ['later-manual-edit']);
    assert.deepEqual(revoked.tech_stack, ['rust']);
    assert.equal((await send('/accept', 'POST', { snapshot_id: preview.snapshot_id })).status, 409);
    assert.equal((await data<Status>(await send(''))).active, false);
    assert.deepEqual((await data<Status>(await send('', 'GET', undefined, peer))).provenance, {});

    // Revoking during an actual provider request fences its late result.
    await sqlClient`UPDATE app.user_github_imports SET last_collected_at=now()-interval '2 minutes' WHERE user_id=${user}::uuid`;
    hold = true; blocked = new Promise<void>(resolve => { release = resolve; }); reached = new Promise<void>(resolve => { arrived = resolve; });
    const late = send('/preview', 'POST', { consent: true });
    await reached;
    assert.equal((await send('', 'DELETE')).status, 200);
    hold = false; release();
    assert.equal((await late).status, 409);
    assert.equal(Number((await sqlClient`SELECT count(*) FROM app.user_github_imports WHERE user_id=${user}::uuid AND snapshot_id IS NOT NULL`)[0].count), 0);
  } finally {
    releaseSnapshot?.(); release?.();
    server.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => provider.close(() => resolve()))]);
    if (triggerCreated) await sqlClient.unsafe(`DROP TRIGGER IF EXISTS ${functionName} ON app.user_github_imports; DROP FUNCTION IF EXISTS app.${functionName}()`);
    const cacheKeys = await redis.keys(`persona:github-import:v1:${user}:*`); if (cacheKeys.length) await redis.del(...cacheKeys);
    await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=ANY(${[user, peer]}::uuid[]) OR aggregate_id IN (SELECT repo_id FROM app.repos WHERE github_id=${repoGithubId}::bigint)`;
    await sqlClient`DELETE FROM app.repos WHERE github_id=${repoGithubId}::bigint`;
    await sqlClient`DELETE FROM app.social_profiles WHERE provider='github' AND provider_subject=${githubId}`;
    await sqlClient`DELETE FROM app.users WHERE user_id=ANY(${[user, peer]}::uuid[])`;
    await sqlClient`DELETE FROM auth.users WHERE id=ANY(${[user, peer]}::uuid[])`;
    redis.disconnect(); await sqlClient.end({ timeout: 1 });
  }
});


describe('GitHub import source acquisition',()=>{
function repository(id: number | string, overrides: Record<string, unknown> = {}) {
  return { id, owner: { id: '7', login: 'viewer' }, name: `repo${id}`, full_name: `viewer/repo${id}`,
    html_url: `https://github.com/viewer/repo${id}`, private: false, visibility: 'public', fork: false,
    description: 'Public repository', language: 'TypeScript', topics: ['testing'], updated_at: '2026-10-01T00:00:00Z',
    stargazers_count: 17, forks_count: 3, open_issues_count: 2, ...overrides };
}
function contribution(id: number) {
  return { databaseId: id, owner: { databaseId: 7, login: 'viewer' }, name: `repo${id}`, nameWithOwner: `viewer/repo${id}`,
    url: `https://github.com/viewer/repo${id}`, isPrivate: false, visibility: 'PUBLIC', isFork: false,
    description: 'Public repository', updatedAt: '2026-10-01T00:00:00Z', stargazerCount: 17, forkCount: 3, issues: { totalCount: 2 },
    primaryLanguage: { name: 'TypeScript' }, repositoryTopics: { nodes: [{ topic: { name: 'testing' } }] } };
}
function graph(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return { data: { user: { databaseId: 7, repositoriesContributedTo: { nodes, pageInfo: { hasNextPage, endCursor } } } } };
}
async function fixture(handler: (url: URL, body: Record<string, unknown>, response: http.ServerResponse) => void) {
  const requests: { url: string; body: Record<string, unknown>; auth?: string }[] = [];
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const url = new URL(request.url!, 'http://localhost');
    requests.push({ url: request.url!, body, auth: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/users/viewer') response.end(JSON.stringify({ id: 7, login: 'viewer' }));
    else handler(url, body, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address.');
  const transport: typeof fetch = (input, init) => {
    const requested = new URL(String(input));
    assert.equal(requested.origin, 'https://api.github.com');
    assert.equal(init?.redirect, 'error', 'credentials must never follow redirects');
    return fetch(`http://127.0.0.1:${address.port}${requested.pathname}${requested.search}`, init);
  };
  return { requests, transport, async stop() {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

test('real HTTP paginates public owned/starred/contributed sources and merges canonical IDs with provenance', async () => {
  const f = await fixture((url, body, response) => {
    if (url.pathname.endsWith('/repos')) response.end(JSON.stringify(url.searchParams.get('page') === '1'
      ? [repository(1), repository(2, { private: true })] : [repository(3)]));
    else if (url.pathname.endsWith('/starred')) response.end(JSON.stringify([repository(1)]));
    else {
      assert.match(String(body.query), /privacy:PUBLIC/);
      const variables = body.variables as { after: string | null; first: number };
      assert.equal(variables.first, 2);
      response.end(JSON.stringify(variables.after === null ? graph([contribution(4)], true, 'next') : graph([contribution(1)])));
    }
  });
  try {
    const result = await new GitHubActivityImportClient({ token: 'fixture-only', fetch: f.transport, pageSize: 2 }).collect({ githubId: '7', handle: 'viewer' });
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.repositories.map(row => row.github_id), ['1', '3', '4']);
    assert.deepEqual(result.repositories[0].sources, ['owned', 'starred', 'contributed']);
    assert.equal(result.repositories[0].owner_github_id, '7');
    assert.equal(result.repositories[0].updated_at, '2026-10-01T00:00:00Z', 'source update time is distinct from collection time');
    assert.equal(result.repositories[0].star_count, 17, 'canonical discovery receives actual observed statistics');
    assert.equal(result.sources.owned.pages, 2);
    assert.equal(result.sources.contributed.pages, 2);
    assert.equal(new Date(result.collected_at).toISOString(), result.collected_at);
    assert.ok(f.requests.every(request => request.auth === 'Bearer fixture-only'));
    assert.ok(!JSON.stringify(result).includes('fixture-only'));
  } finally { await f.stop(); }
});

test('resource limits produce an explicit truncated source rather than pretending the graph is complete', async () => {
  const f = await fixture((url, _body, response) => response.end(JSON.stringify(url.pathname === '/graphql'
    ? graph([]) : url.pathname.endsWith('/repos') ? [repository(Number(url.searchParams.get('page')))] : [])));
  try {
    const result = await new GitHubActivityImportClient({ token: 'fixture', fetch: f.transport, pageSize: 1, maxPages: 2 }).collect({ githubId: '7', handle: 'viewer' });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.sources.owned, { status: 'truncated', pages: 2, count: 2 });
    assert.equal(f.requests.filter(row => row.url.includes('/repos?')).length, 2);
  } finally { await f.stop(); }
});

test('rate limits and malformed pages remain explicit partial errors without discarding successful sources', async () => {
  const f = await fixture((url, _body, response) => {
    if (url.pathname.endsWith('/repos')) response.end(JSON.stringify([repository(1)]));
    else if (url.pathname.endsWith('/starred')) { response.writeHead(429, { 'Retry-After': '120' }); response.end('{}'); }
    else response.end(JSON.stringify(graph([contribution(2), { ...contribution(3), databaseId: Number.MAX_SAFE_INTEGER + 1 }])));
  });
  try {
    const result = await new GitHubActivityImportClient({ token: 'fixture', fetch: f.transport }).collect({ githubId: '7', handle: 'viewer' });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.repositories.map(row => row.github_id), ['1'], 'an invalid page never partly enters the snapshot');
    assert.equal(result.sources.starred.error_code, 'rate_limited');
    assert.equal(result.sources.starred.retry_after_seconds, 120);
    assert.equal(result.sources.contributed.error_code, 'invalid_numeric_identity');
  } finally { await f.stop(); }
});

test('a renamed/taken-over handle cannot select an unverified provider identity', async () => {
  const f = await fixture((_url, _body, response) => response.end('[]'));
  try {
    await assert.rejects(new GitHubActivityImportClient({ token: 'fixture', fetch: f.transport }).collect({ githubId: '8', handle: 'viewer' }),
      (error: unknown) => error instanceof GitHubActivityImportError && error.code === 'provider_identity_changed');
    assert.equal(f.requests.length, 1);
  } finally { await f.stop(); }
});

test('private/internal/unknown visibility is filtered even behind a privileged credential', async () => {
  const f = await fixture((url, _body, response) => response.end(JSON.stringify(url.pathname === '/graphql' ? graph([
    { ...contribution(5), isPrivate: true }, { ...contribution(6), visibility: 'INTERNAL' },
  ]) : url.pathname.endsWith('/repos') ? [repository(1, { private: true }), repository(2, { visibility: 'internal' }), repository(3, { private: undefined })] : [])));
  try {
    const result = await new GitHubActivityImportClient({ token: 'privileged-fixture', fetch: f.transport }).collect({ githubId: '7', handle: 'viewer' });
    assert.deepEqual(result.repositories, []);
    assert.equal(result.status, 'complete');
  } finally { await f.stop(); }
});

test('repeated contribution cursors and oversized bodies stop bounded acquisition', async () => {
  const f = await fixture((url, _body, response) => response.end(url.pathname === '/graphql'
    ? JSON.stringify(graph([contribution(1)], true, 'repeat')) : url.pathname.endsWith('/repos') ? ' '.repeat(2_001) : '[]'));
  try {
    const result = await new GitHubActivityImportClient({ token: 'fixture', fetch: f.transport, maxBodyBytes: 2_000 }).collect({ githubId: '7', handle: 'viewer' });
    assert.equal(result.sources.owned.error_code, 'response_too_large');
    assert.equal(result.sources.contributed.error_code, 'repeated_cursor');
    assert.equal(result.sources.contributed.pages, 1);
  } finally { await f.stop(); }
});

test('one overall deadline aborts a stalled source while independent channels retain completed work', async () => {
  const f = await fixture((url, _body, response) => {
    if (url.pathname.endsWith('/starred')) response.end(JSON.stringify([repository(2)]));
    else if (url.pathname === '/graphql') response.end(JSON.stringify(graph([contribution(3)])));
    // Owned HTTP remains open until the shared deadline aborts it.
  });
  try {
    const result = await new GitHubActivityImportClient({ token: 'fixture', fetch: f.transport, timeoutMs: 200 }).collect({ githubId: '7', handle: 'viewer' });
    assert.equal(result.status, 'partial');
    assert.equal(result.sources.owned.error_code,'deadline_exceeded');
    assert.deepEqual(result.repositories.map(row=>row.github_id),['2','3']);
    assert.equal(result.sources.starred.status,'complete');assert.equal(result.sources.contributed.status,'complete');
    assert.equal(f.requests.length,4,'only profile and one bounded request per source reached HTTP');
  } finally { await f.stop(); }
});

test('source concurrency is bounded, pagination stays sequential and metadata precedence survives response order',async t=>{
  let active=0,maximum=0;
  const inSource=new Map<string,number>();const completionOrder:string[]=[];
  const firstReplies=new Map<string,()=>void>();
  const f=await fixture((url,body,response)=>{
    const source=url.pathname==='/graphql'?'contributed':url.pathname.endsWith('/repos')?'owned':'starred';
    const page=source==='contributed'?(body.variables as {after:string|null}).after===null?1:2:Number(url.searchParams.get('page'));
    active++;maximum=Math.max(maximum,active);
    inSource.set(source,(inSource.get(source)??0)+1);assert.equal(inSource.get(source),1,'pages within a source must not overlap');
    const reply=()=>{
      active--;inSource.set(source,inSource.get(source)!-1);completionOrder.push(`${source}:${page}`);
      const rows=page===1?[source==='contributed'?{...contribution(1),description:'contributed'}:repository(1,{description:source})]:[];
      response.end(JSON.stringify(source==='contributed'?graph(rows,page===1,page===1?'next':null):rows));
    };
    if(page===1){
      firstReplies.set(source,reply);
      if(firstReplies.size===3){
        const replies=['contributed','starred','owned'].map(source=>firstReplies.get(source)!);firstReplies.clear();
        const emit=(index:number)=>{if(index<replies.length)setTimeout(()=>{replies[index]();emit(index+1);},20);};
        emit(0);
      }
    } else setTimeout(reply,source==='owned'?60:source==='starred'?40:20);
  });
  try {
    const started=performance.now();
    const result=await new GitHubActivityImportClient({token:'fixture',fetch:f.transport,pageSize:1}).collect({githubId:'7',handle:'viewer'});
    t.diagnostic(JSON.stringify({milliseconds:Math.round((performance.now()-started)*100)/100,maximumSourceRequests:maximum,completionOrder}));
    assert.equal(maximum,3);
    assert.equal(result.status,'complete');
    assert.equal(result.repositories[0].description,'owned');
    assert.deepEqual(result.repositories[0].sources,['owned','starred','contributed']);
    assert.ok(Object.values(result.sources).every(source=>source.pages===2&&source.count===1));
    assert.equal(f.requests.length,7,'profile plus two sequential pages per source');
    assert.deepEqual(completionOrder.filter(value=>value.endsWith(':1')),['contributed:1','starred:1','owned:1']);
  } finally {await f.stop();}
});

for (const laterFailure of [false,true]) test(`ordered merge rejects a conflicting page and its buffered ${laterFailure?'rate limit':'continuation'}`,async()=>{
  const f=await fixture((url,_body,response)=>{
    if(url.pathname==='/graphql'){response.end(JSON.stringify(graph([contribution(1)])));return;}
    const page=Number(url.searchParams.get('page'));
    if(url.pathname.endsWith('/repos')){
      setTimeout(()=>response.end(JSON.stringify([repository(1)])),30);return;
    }
    if(page===3&&laterFailure){response.writeHead(429,{'Retry-After':'120'});response.end('{}');return;}
    const rows=page===1?[repository(2),repository(3)]:page===2?
      [repository(4),repository(1,{owner:{id:'9',login:'viewer'}})]:[repository(5)];
    response.end(JSON.stringify(rows));
  });
  try {
    const result=await new GitHubActivityImportClient({token:'fixture',fetch:f.transport,pageSize:2}).collect({githubId:'7',handle:'viewer'});
    assert.deepEqual(result.repositories.map(row=>row.github_id),['1','2','3']);
    assert.deepEqual(result.repositories[0].sources,['owned','contributed']);
    assert.deepEqual(result.sources.starred,{status:'unavailable',pages:1,count:2,error_code:'conflicting_repository_identity'});
  } finally {await f.stop();}
});

test('cancelling active acquisition aborts all channels without starting later pages',async()=>{
  const controller=new AbortController();let sourcesStarted=0;
  const f=await fixture(()=>{if(++sourcesStarted===3)controller.abort();});
  try {
    const result=await new GitHubActivityImportClient({token:'fixture',fetch:f.transport,pageSize:1}).collect({githubId:'7',handle:'viewer'},controller.signal);
    assert.equal(f.requests.length,4);
    assert.deepEqual(result.repositories,[]);
    assert.ok(Object.values(result.sources).every(source=>source.status==='unavailable'&&source.error_code==='cancelled'&&source.pages===0));
  } finally {await f.stop();}
});

test('owned-source and conflicting immutable owner IDs cannot contaminate any accepted page', async () => {
  const f = await fixture((url, _body, response) => {
    const valid = repository(1);
    const conflicting = repository(1, { owner: { id: '9', login: 'viewer' } });
    response.end(JSON.stringify(url.pathname === '/graphql' ? graph([])
      : url.pathname.endsWith('/repos') ? [conflicting] : [valid, conflicting]));
  });
  try {
    const result = await new GitHubActivityImportClient({ token: 'fixture', fetch: f.transport }).collect({ githubId: '7', handle: 'viewer' });
    assert.deepEqual(result.repositories, []);
    assert.equal(result.sources.owned.error_code, 'invalid_owned_repository');
    assert.equal(result.sources.starred.error_code, 'conflicting_repository_identity');
  } finally { await f.stop(); }
});

test('actual redirects cannot forward the configured service credential', async () => {
  const f = await fixture((url, _body, response) => {
    if (url.pathname.endsWith('/repos')) { response.writeHead(302, { Location: '/credential-target' }); response.end(); }
    else response.end(JSON.stringify(url.pathname === '/graphql' ? graph([]) : []));
  });
  try {
    const result = await new GitHubActivityImportClient({ token: 'fixture', fetch: f.transport }).collect({ githubId: '7', handle: 'viewer' });
    assert.equal(result.sources.owned.error_code, 'transport_error');
    assert.equal(f.requests.some(request => request.url === '/credential-target'), false);
  } finally { await f.stop(); }
});

test('invalid resource settings fail before HTTP and pre-cancelled acquisition sends nothing', async () => {
  for (const options of [{ maxPages: 6 }, { pageSize: 101 }, { timeoutMs: 0 }, { maxBodyBytes: Infinity }]) {
    assert.throws(() => new GitHubActivityImportClient({ token: 'fixture', ...options }), /resource limit/);
  }
  const f = await fixture((_url, _body, response) => response.end('[]'));
  try {
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(new GitHubActivityImportClient({ token: 'fixture', fetch: f.transport }).collect({ githubId: '7', handle: 'viewer' }, cancelled.signal),
      (error: unknown) => error instanceof GitHubActivityImportError && error.code === 'cancelled');
    assert.equal(f.requests.length, 0);
  } finally { await f.stop(); }
});

});
