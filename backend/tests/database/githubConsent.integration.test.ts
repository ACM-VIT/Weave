import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
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
  const importTopic = `consent-topic-${githubId}`;
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
        visibility: 'public', fork: false, description: 'Sourced public repository', language: 'TypeScript', topics: ['typescript', importTopic],
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
    await sqlClient`INSERT INTO app.topics(slug,display_name) VALUES(${importTopic},'Preserved import label')`;
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
    assert.equal((await sqlClient`SELECT display_name FROM app.topics WHERE slug=${importTopic}`)[0].display_name,
      'Preserved import label', 'importing preferences preserves existing topic display labels');
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
    await sqlClient`DELETE FROM app.topics WHERE slug=${importTopic}`;
    redis.disconnect(); await sqlClient.end({ timeout: 1 });
  }
});
