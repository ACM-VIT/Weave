import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { CreateServeInput } from '../../contracts/feed.v2.js';
import type { FeedQueuePort } from '../../redis/feedQueue.js';
import { assertDisposableDatabase } from './disposableDatabase.js';

test('seven-day cross-session exposure fences delivery beyond bounded hints and serializes concurrent serves', {
  skip: process.env.RUN_FEED_EXPOSURE_INTEGRATION !== '1', timeout: 30_000,
}, async t => {
  assertDisposableDatabase();
  const [{ sqlClient: sql }, { PostgresFeedPersistence }, { FeedV2Service, FeedRequestInProgressError }, errors] = await Promise.all([
    import('../../db/index.js'), import('../../adapters/postgresFeedPersistence.js'),
    import('../../services/feedV2Service.js'), import('../../ports/feedPersistencePort.js'),
  ]);
  const users = [randomUUID(), randomUUID()];
  const [viewer, peer] = users;
  const repos = Array.from({ length: 506 }, () => randomUUID());
  const [recent, expired, impressed, concurrent, fresh] = [repos[0], ...repos.slice(501)];
  const snapshot = randomUUID();
  const persistence = new PostgresFeedPersistence();
  const services: InstanceType<typeof FeedV2Service>[] = [];
  t.after(async () => {
    await Promise.all(services.map(service => service.stop()));
    try {
      await sql`DELETE FROM telemetry.feed_serves WHERE user_id IN
        (SELECT jsonb_array_elements_text(${JSON.stringify(users)}::text::jsonb)::uuid)`;
      await sql`DELETE FROM app.trending_snapshots WHERE snapshot_id=${snapshot}::uuid`;
      await sql`DELETE FROM app.users WHERE user_id IN
        (SELECT jsonb_array_elements_text(${JSON.stringify(users)}::text::jsonb)::uuid)`;
      await sql`DELETE FROM auth.users WHERE id IN
        (SELECT jsonb_array_elements_text(${JSON.stringify(users)}::text::jsonb)::uuid)`;
      await sql`DELETE FROM app.repos WHERE repo_id IN
        (SELECT jsonb_array_elements_text(${JSON.stringify(repos)}::text::jsonb)::uuid)`;
    } finally { await sql.end({ timeout: 1 }); }
  });
  for (const user of users) {
    await sql`INSERT INTO auth.users(id) VALUES(${user}::uuid)`;
    await sql`INSERT INTO app.users(user_id,username,status) VALUES(${user}::uuid,${'exposure_'+user.replaceAll('-', '')},'active')`;
    await sql`INSERT INTO app.user_feed_state(user_id,feed_version) VALUES(${user}::uuid,1)`;
  }
  const records = repos.map(repo_id => ({ repo_id, github_id: String(BigInt('0x' + repo_id.replaceAll('-', '').slice(0, 12)) + 500_000_000_000_000n) }));
  await sql`INSERT INTO app.repos(repo_id,github_id,owner,name,full_name,url,status)
    SELECT repo_id::uuid,github_id::bigint,'exposure',repo_id,'exposure/'||repo_id,'https://github.com/exposure/'||repo_id,'active'
    FROM jsonb_to_recordset(${JSON.stringify(records)}::text::jsonb) AS row(repo_id text,github_id text)`;
  await sql`INSERT INTO app.repo_content(repo_id,description,content_hash)
    SELECT repo_id::uuid,'Exposure fixture','exposure-fixture' FROM jsonb_to_recordset(${JSON.stringify(records)}::text::jsonb) AS row(repo_id text)`;
  async function history(ids: string[], days: number) {
    const id = randomUUID();
    await sql`INSERT INTO telemetry.feed_serves(serve_id,feed_request_id,user_id,session_id,feed_version,source,created_at)
      VALUES(${id}::uuid,${randomUUID()}::uuid,${viewer}::uuid,${randomUUID()}::uuid,1,'personalized',now()-(${days * 86400}::integer * interval '1 second'))`;
    await sql`INSERT INTO telemetry.feed_serve_items(serve_id,position,repo_id,score,source,model_version)
      SELECT ${id}::uuid,position,repo_id::uuid,1,'semantic','fixture' FROM
      jsonb_to_recordset(${JSON.stringify(ids.map((repo_id, position) => ({ repo_id, position })))}::text::jsonb) AS row(repo_id text,position smallint)`;
  }
  await history([recent], 6);
  for (let offset = 1; offset < 501; offset += 100) await history(repos.slice(offset, offset + 100), 1);
  await history([expired], 8);
  await sql`INSERT INTO telemetry.user_repo_engagement(user_id,repo_id,impressions)
    VALUES(${viewer}::uuid,${impressed}::uuid,1)`;

  async function serve(repo: string, user = viewer): Promise<CreateServeInput> {
    const [repository] = await persistence.listActiveRepositories([repo], user);
    return { feed_request_id: randomUUID(), user_id: user, session_id: randomUUID(), feed_version: 1n,
      generation_id: null, source: 'personalized', model_version: 'fixture', next_cursor: null,
      items: [{ repo_id: repo, score: 1, source: 'semantic', model_version: 'fixture', summary_id: null, position: 0, repository }] };
  }
  await t.test('exact checks reject an older recent card omitted by the 500-ID hint cap', async () => {
    const hinted = await persistence.listExcludedRepositoryIds(viewer, randomUUID(), 500);
    assert.equal(hinted.length, 500);
    assert.equal(hinted.includes(recent), false);
    assert.deepEqual(await persistence.listExposureEligibleRepositoryIds(viewer, [recent, expired, impressed]), [expired]);
    assert.deepEqual(new Set(await persistence.listExposureEligibleRepositoryIds(peer, [recent, impressed])), new Set([recent, impressed]));
    const blocked = await serve(recent);
    await assert.rejects(persistence.createServe(blocked), errors.FeedExposureChangedError);
    assert.equal(await persistence.getServeByRequest(viewer, blocked.feed_request_id), null);
    assert.deepEqual((await persistence.getRecentPersonalizedEntries(viewer, 1n, 1, [])).map(row => row.repo_id), [expired],
      'recovery must filter recent history before LIMIT to reach an older eligible card');
    await sql`INSERT INTO app.trending_snapshots(snapshot_id,period,source,computed_at,activated_at,complete,active)
      VALUES(${snapshot}::uuid,${'exposure_'+snapshot},'fixture',now(),now(),true,true)`;
    await sql`INSERT INTO app.trending_snapshot_items(snapshot_id,position,repo_id)
      VALUES(${snapshot}::uuid,0,${recent}::uuid),(${snapshot}::uuid,1,${repos[505]}::uuid)`;
    assert.deepEqual((await persistence.getTrendingFallback(1, [], viewer)).map(row => row.repo_id), [repos[505]],
      'fallback must also filter recent cards before LIMIT');
    assert.deepEqual((await persistence.getTrendingFallback(1, [], peer)).map(row => row.repo_id), [recent]);
    const reusable = await serve(expired);
    await sql`INSERT INTO app.reactions(user_id,repo_id,reaction) VALUES(${viewer}::uuid,${expired}::uuid,'dislike')`;
    await assert.rejects(persistence.createServe(reusable), errors.FeedPreferenceChangedError,
      'expiring exposure must never expire an explicit negative preference');
    await sql`DELETE FROM app.reactions WHERE user_id=${viewer}::uuid AND repo_id=${expired}::uuid`;
    assert.equal((await persistence.createServe(reusable)).items[0].repo_id, expired);
  });
  await t.test('two new sessions racing the same card create exactly one durable serve, while replay remains valid', async () => {
    const inputs = await Promise.all([serve(concurrent), serve(concurrent)]);
    const results = await Promise.allSettled(inputs.map(input => persistence.createServe(input)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof errors.FeedExposureChangedError);
    const winner = results.findIndex(result => result.status === 'fulfilled');
    const original = (results[winner] as PromiseFulfilledResult<Awaited<ReturnType<typeof persistence.createServe>>>).value;
    assert.equal((await persistence.createServe(inputs[winner])).serve_id, original.serve_id);
    assert.equal(Number((await sql`SELECT count(*) AS n FROM telemetry.feed_serve_items item
      JOIN telemetry.feed_serves header USING(serve_id) WHERE header.user_id=${viewer}::uuid AND item.repo_id=${concurrent}::uuid`)[0].n), 1);
  });
  await t.test('the real service drops recently served and duplicate cache entries before delivering fresh cards', async () => {
    const queue = { reserve: async (_user: string, _version: bigint, requestId: string, _limit: number, token: string) => ({
      requestId, token, remainingDepth: 0, items: [recent, fresh, fresh].map(repo_id => ({ repo_id, score: 1, source: 'semantic', model_version: 'fixture', summary_id: null })),
    }), commit: async () => true, release: async () => true } as unknown as FeedQueuePort;
    const service = new FeedV2Service(persistence, queue); services.push(service);
    const request = { feed_request_id: randomUUID(), session_id: randomUUID(), cursor: null, limit: 3 };
    const response = await service.getFeed(viewer, request);
    assert.deepEqual(response.items.map(item => item.repo_id), [fresh]);
    assert.equal(response.next_cursor, null);
    assert.equal((await service.getFeed(viewer, request)).serve_id, response.serve_id);
  });
  await t.test('an explicit empty generation terminates a small catalogue; filtering alone never fabricates exhaustion', async () => {
    let items = [recent].map(repo_id => ({ repo_id, score: 1, source: 'semantic', model_version: 'fixture', summary_id: null }));
    const reservation = async (_u: string, _v: bigint, requestId: string, _l: number, token: string) => ({ requestId, token, items, remainingDepth: 0 });
    const queue = { reserve: reservation, refill: reservation, commit: async () => true, release: async () => true } as unknown as FeedQueuePort;
    const service = new FeedV2Service(persistence, queue, async () => ({ status: 'generated', feedVersion: 1n, count: 0 })); services.push(service);
    const request = { feed_request_id: randomUUID(), session_id: randomUUID(), cursor: null, limit: 1 };
    await assert.rejects(service.getFeed(viewer, request), FeedRequestInProgressError);
    assert.equal(await persistence.getServeByRequest(viewer, request.feed_request_id), null);
    items = [];
    const empty = await service.getFeed(viewer, request);
    assert.deepEqual(empty.items, []); assert.equal(empty.next_cursor, null);
  });
});
