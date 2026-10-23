import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { assertDisposableDatabase } from '../database/disposableDatabase.js';

const enabled = process.env.RUN_AUTHORIZATION_INTEGRATION === '1';
if (enabled) {
  assertDisposableDatabase();
  const redis = new URL(process.env.REDIS_URL ?? '');
  assert.equal(redis.protocol, 'redis:');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(redis.hostname));
  assert.equal(redis.pathname, '/15', 'Select a dedicated disposable Redis database 15.');
  assert.equal(redis.search + redis.hash, '');
}

test('registered HTTP authorization matrix rejects impersonation and preserves documented public exposure', { skip: !enabled, timeout: 30_000 }, async t => {
  Object.assign(process.env, { JWT_SECRET: 'local-authorization-jwt', INTERNAL_API_SECRET: 'abcd',
    INTERNAL_API_SECRET_PREVIOUS: 'rotated-local-secret', SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_KEY: 'local-anon-key', SUPABASE_SERVICE_ROLE_KEY: 'local-service-key',
    CLIENT_URL: 'http://127.0.0.1:8080', BACKEND_URL: 'http://127.0.0.1:5000',
    DB_SCHEMA_V2_READS: 'true', DB_SCHEMA_V2_WRITES: 'true', FEED_V2: 'true', FEED_RESERVATIONS: 'true',
    ML_V2_RECOMMENDATIONS: 'false', ML_FEEDBACK_OUTBOX: 'false', TRENDING_INGESTION: 'false' });
  const [{ sqlClient }, { default: redis }] = await Promise.all([
    import('../../db/index.js'), import('../../config/redis.js'),
  ]);
  t.after(async () => { redis.disconnect(); await sqlClient.end({ timeout: 1 }); });
  const { default: app } = await import('../../app.js');
  const owner = randomUUID(); const viewer = randomUUID(); const repo = randomUUID();
  const collection = randomUUID(); const board = randomUUID(); const comment = randomUUID();
  let server: Server | undefined;
  try {
    await sqlClient`INSERT INTO auth.users(id) VALUES(${owner}::uuid),(${viewer}::uuid)`;
    await sqlClient`INSERT INTO app.users(user_id,username,full_name,date_of_birth,status)
      VALUES(${owner}::uuid,${'owner_' + owner.replaceAll('-', '')},'Tarun Owner','1990-01-01','active'),
        (${viewer}::uuid,${'viewer_' + viewer.replaceAll('-', '')},'Tarun Viewer','1990-01-01','active')`;
    await sqlClient`INSERT INTO app.user_stats(user_id) VALUES(${owner}::uuid),(${viewer}::uuid)`;
    await sqlClient`INSERT INTO app.user_feed_state(user_id) VALUES(${owner}::uuid),(${viewer}::uuid)`;
    await sqlClient`INSERT INTO app.repos(repo_id,github_id,full_name,owner,name,url,status)
      VALUES(${repo}::uuid,${Date.now()},${'fixture/' + repo},'fixture',${repo},${'https://github.com/fixture/' + repo},'active')`;
    await sqlClient`INSERT INTO app.repo_content(repo_id,content_hash,description,readme)
      VALUES(${repo}::uuid,'authorization-fixture','Public description','# Public README')`;
    await sqlClient`INSERT INTO app.repo_engagement(repo_id) VALUES(${repo}::uuid)`;
    await sqlClient`INSERT INTO app.board_collections(collection_id,user_id,name) VALUES(${collection}::uuid,${owner}::uuid,'Private owner List')`;
    await sqlClient`INSERT INTO app.boards(board_id,user_id,name,visibility) VALUES(${board}::uuid,${owner}::uuid,'Private owner Board','private')`;
    await sqlClient`INSERT INTO app.collection_repos(collection_id,repo_id) VALUES(${collection}::uuid,${repo}::uuid)`;
    await sqlClient`INSERT INTO app.board_repos(board_id,repo_id,added_by) VALUES(${board}::uuid,${repo}::uuid,${owner}::uuid)`;
    await sqlClient`INSERT INTO app.saves(user_id,repo_id) VALUES(${owner}::uuid,${repo}::uuid)`;
    await sqlClient`INSERT INTO app.comments(comment_id,user_id,repo_id,body) VALUES(${comment}::uuid,${owner}::uuid,${repo}::uuid,'Owner comment')`;
    server = await new Promise<Server>(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const token = (id: string) => jwt.sign({ userId: id }, process.env.JWT_SECRET!);
    const request = (method: string, path: string, id?: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
      method, headers: { 'content-type': 'application/json', ...(id ? { authorization: `Bearer ${token(id)}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const replace = (path: string) => path.replaceAll(':repoId', repo).replaceAll(':userId', owner)
      .replaceAll(':profileId', randomUUID()).replaceAll(':collectionId', collection).replaceAll(':boardId', board)
      .replaceAll(':commentId', comment).replaceAll(':outboxId', randomUUID());
    let protectedRoutes = 0;
    for (const [file, prefix] of [['productV2Routes', '/api/v2'], ['feedV2Routes', '/api/v2'], ['activityV2Routes', '/api/v2'],
      ['ingestionRoutes', '/api/internal/v2/ingestion'], ['operationsRoutes', '/api/internal/v2/operations']]) {
      const source = readFileSync(new URL(`../../routes/${file}.ts`, import.meta.url), 'utf8');
      for (const match of source.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)) {
        if (match[2] === '/repositories/:repoId/share') continue;
        const response = await request(match[1]!.toUpperCase(), prefix + replace(match[2]!), undefined,
          ['post', 'patch', 'put'].includes(match[1]!) ? {} : undefined);
        assert.equal(response.status, 401, `${match[1]} ${prefix}${match[2]} requires authentication`);
        protectedRoutes++;
      }
    }
    assert.equal(protectedRoutes, 44); t.diagnostic(`${protectedRoutes} registered protected method/path pairs rejected anonymous access.`);
    for (const invalid of ['invalid-token', jwt.sign({ userId: owner }, process.env.JWT_SECRET!, { expiresIn: -1 })]) {
      assert.equal((await request('POST', '/api/v2/interactions/batch', undefined, {}, { authorization: `Bearer ${invalid}` })).status, 401);
    }
    const share = await request('GET', `/api/v2/repositories/${repo}/share`);
    assert.equal(share.status, 200);
    const shareData = (await share.json() as { data: Record<string, unknown> }).data;
    assert.deepEqual(Object.keys(shareData).sort(), ['description', 'full_name', 'name', 'repo_id', 'url']);
    for (const [method, path] of [
      ['POST', '/api/activity'], ['POST', '/api/repos/import'], ['POST', '/api/repos/sync'],
      ['GET', `/api/users/id/${owner}`], ['POST', `/api/repos/${repo}/sync`],
    ] as const) {
      assert.equal((await request(method, path, viewer, method === 'GET' ? undefined : { user_id: owner })).status, 404, `${method} ${path}`);
    }
    for (const path of ['/api/v2/collections', '/api/v2/boards', '/api/v2/repositories/saved']) {
      const response = await request('GET', `${path}?user_id=${owner}&userId=${owner}&viewerId=${owner}`, viewer);
      assert.equal(response.status, 200);
      const data = (await response.json() as { data: { items: unknown[] } }).data;
      assert.deepEqual(data.items, [], `${path} ignores forged viewer identity`);
    }
    for (const [method, path, body] of [
      ['GET', `/collections/${collection}/repositories`, undefined], ['PUT', `/collections/${collection}`, { name: 'Stolen' }],
      ['DELETE', `/collections/${collection}`, undefined], ['GET', `/boards/${board}/repositories`, undefined],
      ['PUT', `/boards/${board}`, { name: 'Stolen', visibility: 'public' }], ['DELETE', `/boards/${board}`, undefined],
      ['PATCH', `/comments/${comment}`, { body: 'Stolen' }], ['DELETE', `/comments/${comment}`, undefined],
      ['DELETE', `/boards/${board}/repositories/${repo}`, undefined],
    ] as const) assert.equal((await request(method, '/api/v2' + path, viewer, body)).status, 404, path);
    const event = (type: string) => ({ event_id: randomUUID(), schema_version: 2, session_id: randomUUID(),
      serve_id: null, repo_id: repo, position: null, event_type: type, dwell_ms: null,
      client_occurred_at: new Date().toISOString(), context: {} });
    assert.equal((await request('PUT', `/api/v2/boards/${board}/repositories/${repo}`, viewer, { event: event('save') })).status, 404);
    assert.equal((await request('POST', '/api/v2/collections/save', viewer, { repositoryId: repo, collectionIds: [collection], userId: owner })).status, 400);
    assert.equal((await request('PATCH', '/api/v2/users/me', viewer, { user_id: owner, bio: 'Stolen' })).status, 400);
    const ownEvent = event('like');
    assert.equal((await request('POST', '/api/v2/interactions/batch', viewer,
      { user_id: owner, events: [{ ...ownEvent, user_id: owner }] })).status, 202);
    const recorded = await sqlClient`SELECT user_id FROM telemetry.interaction_events WHERE event_id=${ownEvent.event_id}::uuid`;
    assert.equal(recorded[0]!.user_id, viewer);
    assert.equal(Number((await sqlClient`SELECT count(*) FROM app.reactions WHERE user_id=${owner}::uuid`)[0]!.count), 0);
    const served = randomUUID(); const session = randomUUID();
    await sqlClient`INSERT INTO telemetry.feed_serves(serve_id,feed_request_id,user_id,session_id,feed_version,source)
      VALUES(${served}::uuid,${randomUUID()}::uuid,${owner}::uuid,${session}::uuid,1,'authorization-test')`;
    await sqlClient`INSERT INTO telemetry.feed_serve_items(serve_id,position,repo_id,source) VALUES(${served}::uuid,0,${repo}::uuid,'authorization-test')`;
    // Compare durable state, rather than only HTTP status: a valid prefix must
    // never commit when a later event belongs to another account.
    const durableState = async () => {
      const users = [owner, viewer];
      const [events, reactions, counters, versions, jobs] = await Promise.all([
        sqlClient`SELECT * FROM telemetry.interaction_events WHERE user_id=ANY(${users}::uuid[]) ORDER BY event_id`,
        sqlClient`SELECT * FROM app.reactions WHERE user_id=ANY(${users}::uuid[]) ORDER BY user_id,repo_id`,
        sqlClient`SELECT * FROM app.repo_engagement WHERE repo_id=${repo}::uuid`,
        sqlClient`SELECT * FROM app.user_feed_state WHERE user_id=ANY(${users}::uuid[]) ORDER BY user_id`,
        sqlClient`SELECT * FROM telemetry.ml_outbox WHERE aggregate_id=ANY(${users}::uuid[]) ORDER BY outbox_id`,
      ]);
      return { events: [...events], reactions: [...reactions], counters: [...counters], versions: [...versions], jobs: [...jobs] };
    };
    for (const [actor, valid, invalid] of [
      [viewer, event('unlike'), { ...event('dislike'), serve_id: served, session_id: session, position: 0, user_id: owner }],
      [owner, event('like'), ownEvent],
    ] as const) {
      const before = await durableState();
      assert.equal((await request('POST', '/api/v2/interactions/batch', actor, { events: [valid, invalid] })).status, 409);
      assert.deepEqual(await durableState(), before, 'rejected mixed batch rolls back events, reactions, counters, versions and outbox');
      assert.equal(Number((await sqlClient`SELECT count(*) FROM telemetry.interaction_events WHERE event_id=${valid.event_id}::uuid`)[0]!.count), 0);
    }
    const created = await request('POST', `/api/v2/repositories/${repo}/comments`, viewer, { body: 'Viewer comment', user_id: owner });
    assert.equal(created.status, 201); assert.equal((await created.json() as { data: { user_id: string } }).data.user_id, viewer);
    const publicLikes = await request('GET', `/api/v2/users/${viewer}/likes-given`, owner);
    assert.equal(publicLikes.status, 200, 'positive likes are public social profile activity to authenticated viewers');
    const likedItems = (await publicLikes.json() as { data: { items: Array<{ repo_id: string }> } }).data.items;
    assert.deepEqual(likedItems.map(item => item.repo_id), [repo]);
    const actors = await sqlClient`SELECT user_id,reaction FROM app.reactions WHERE repo_id=${repo}::uuid ORDER BY user_id`;
    assert.deepEqual(actors.map(row => [row.user_id, row.reaction]), [[viewer, 'like']], 'forged user fields cannot change the public like actor');
    const malformed = await request('POST', '/api/internal/v2/ingestion/repositories/upsert', undefined, {}, { 'x-internal-secret': 'éabc' });
    assert.equal(malformed.status, 401);
    const rotated = await request('POST', '/api/internal/v2/ingestion/repositories/upsert', undefined, {}, { 'x-internal-secret': 'rotated-local-secret' });
    assert.equal(rotated.status, 400, 'valid previous secret reaches payload validation');
    assert.equal((await request('POST', '/api/auth/signup', undefined, { padding: 'x'.repeat(300 * 1024) })).status, 413);
    const invalidProvider = `/api/auth/oauth/invalid-${randomUUID()}`;
    for (let i = 0; i < 20; i++) assert.equal((await request('GET', invalidProvider)).status, 400);
    const rateLimited = await request('GET', invalidProvider); assert.equal(rateLimited.status, 429);
    assert.equal(rateLimited.headers.get('retry-after'), '60');
    assert.equal((await sqlClient`SELECT body FROM app.comments WHERE comment_id=${comment}::uuid`)[0]!.body, 'Owner comment');
    assert.equal(Number((await sqlClient`SELECT count(*) FROM app.saves WHERE user_id=${owner}::uuid AND repo_id=${repo}::uuid`)[0]!.count), 1);
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=ANY(${[owner, viewer]}::uuid[])`;
    await sqlClient`DELETE FROM app.users WHERE user_id=ANY(${[owner, viewer]}::uuid[])`;
    await sqlClient`DELETE FROM auth.users WHERE id=ANY(${[owner, viewer]}::uuid[])`;
    await sqlClient`DELETE FROM app.repos WHERE repo_id=${repo}::uuid`;
  }
});
