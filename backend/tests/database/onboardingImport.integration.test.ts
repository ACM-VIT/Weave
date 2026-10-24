import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { assertDisposableDatabase } from './disposableDatabase.js';

const enabled = process.env.RUN_DATABASE_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();
const integration = enabled ? test : test.skip;

integration('registered onboarding persists stable taxonomy and batches topic writes atomically', async t => {
  const redisUrl = new URL(process.env.REDIS_DATABASE_TEST_URL ?? 'redis://127.0.0.1:56388/15');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(redisUrl.hostname) && redisUrl.pathname === '/15');
  Object.assign(process.env, { JWT_SECRET: 'onboarding-disposable-fixture-secret', REDIS_URL: redisUrl.toString(),
    SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_KEY: 'fixture', SUPABASE_SERVICE_ROLE_KEY: 'fixture' });
  const [{ default: express }, { default: jwt }, { sqlClient }, { default: router }, { default: redis }] = await Promise.all([
    import('express'), import('jsonwebtoken'), import('../../db/index.js'), import('../../routes/productV2Routes.js'), import('../../config/redis.js'),
  ]);
  const userId = crypto.randomUUID(), peerId = crypto.randomUUID();
  const completionUsers: string[] = [];
  const completionFault = 'fixture_completion_' + userId.replaceAll('-', '');
  const generatedTopics = new Set<string>();
  const app = express(); app.use(express.json()); app.use('/api/v2', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.listening ? resolve() : server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test HTTP address.');
  const token = jwt.sign({ userId, email: 'fixture@invalid.test' }, process.env.JWT_SECRET!, { expiresIn: '1m' });
  const taxonomy = { version: 1, skills: [{ id: 'data', label: 'Data Engineering & AI/ML Pipelines' }],
    interests: [{ id: 'c++', label: 'c++' }] };
  const send = (body: unknown, actorToken = token) => fetch(`http://127.0.0.1:${address.port}/api/v2/onboarding`, {
    method: 'PUT', headers: { Authorization: `Bearer ${actorToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    await sqlClient`INSERT INTO auth.users(id) VALUES(${userId}::uuid)`;
    await sqlClient`INSERT INTO app.users(user_id,username,full_name,date_of_birth,status)
      VALUES(${userId}::uuid,${'import_'+userId.replaceAll('-', '')},'Tarun','2005-01-01','active')`;
    await sqlClient`INSERT INTO app.user_stats(user_id) VALUES(${userId}::uuid)`;
    await sqlClient`INSERT INTO app.user_feed_state(user_id) VALUES(${userId}::uuid)`;
    const response = await send({ skills: ['data'], interests: ['cpp'], tech_stack: ['typescript'], taxonomy_selections: taxonomy });
    assert.equal(response.status, 200, await response.text());
    const [profile] = await sqlClient`SELECT skills,interests,onboarding_taxonomy,onboarding_completed,profile_version FROM app.users WHERE user_id=${userId}::uuid`;
    assert.deepEqual(profile.skills, ['Data Engineering & AI/ML Pipelines']);
    assert.deepEqual(profile.interests, ['c++']);
    assert.deepEqual(profile.onboarding_taxonomy, taxonomy);
    assert.equal(profile.onboarding_completed, true);
    const jobs = await sqlClient`SELECT payload,status FROM telemetry.ml_outbox WHERE aggregate_id=${userId}::uuid AND job_type='onboard'`;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, 'pending', 'onboarding acceptance does not claim asynchronous ML delivery');
    assert.deepEqual(jobs[0].payload.profile.skills, profile.skills);
    assert.deepEqual(jobs[0].payload.profile.interests, ['c++']);
    const invalid = await send({ skills: ['data'], interests: [], tech_stack: [], taxonomy_selections: {
      ...taxonomy, skills: [{ id: 'data', label: 'forged' }],
    } });
    assert.equal(invalid.status, 400);
    assert.equal(String((await sqlClient`SELECT profile_version FROM app.users WHERE user_id=${userId}::uuid`)[0].profile_version), String(profile.profile_version));
    assert.equal(Number((await sqlClient`SELECT count(*) FROM telemetry.ml_outbox WHERE aggregate_id=${userId}::uuid`)[0].count), 1);
    const measurements: Array<{ topics: number; statements: number; milliseconds: number }> = [];
    for (const count of [1, 20, 100]) {
      const slugs = Array.from({ length: count }, (_, index) => `batch-${userId.slice(0, 8)}-${index}`);
      for (const slug of slugs) generatedTopics.add(slug);
      if (count === 1) await sqlClient`INSERT INTO app.topics(slug,display_name) VALUES(${slugs[0]},'Existing display label')`;
      let statements = 0;
      const previousDebug = sqlClient.options.debug;
      sqlClient.options.debug = (_connection, query) => {
        if (/\b(?:INSERT INTO app\.(?:topics|user_topics)|DELETE FROM app\.user_topics)\b/i.test(query)) statements++;
      };
      const started = performance.now();
      try {
        const result = await send({ skills: slugs.slice(0, 50), interests: slugs.slice(50), tech_stack: [] });
        assert.equal(result.status, 200, await result.text());
      } finally { sqlClient.options.debug = previousDebug; }
      measurements.push({ topics: count, statements, milliseconds: Math.round((performance.now() - started) * 100) / 100 });
      const stored = await sqlClient`SELECT topic.slug FROM app.user_topics membership JOIN app.topics topic USING(topic_id)
        WHERE membership.user_id=${userId}::uuid ORDER BY topic.slug`;
      assert.deepEqual(stored.map(row => row.slug), [...slugs].sort());
      if (count === 1) assert.equal((await sqlClient`SELECT display_name FROM app.topics WHERE slug=${slugs[0]}`)[0].display_name,
        slugs[0], 'manual onboarding retains its existing display-name overwrite behavior');
    }
    t.diagnostic(JSON.stringify({ topicWrites: measurements }));
    assert.ok(measurements.every(row => row.statements === 3), 'topic synchronization stays at three statements as selections grow');
    await sqlClient`INSERT INTO auth.users(id) VALUES(${peerId}::uuid)`;
    await sqlClient`INSERT INTO app.users(user_id,username,full_name,date_of_birth,status)
      VALUES(${peerId}::uuid,${'import_'+peerId.replaceAll('-', '')},'Peer','2005-01-01','active')`;
    await sqlClient`INSERT INTO app.user_stats(user_id) VALUES(${peerId}::uuid)`;
    await sqlClient`INSERT INTO app.user_feed_state(user_id) VALUES(${peerId}::uuid)`;
    const peerToken = jwt.sign({ userId: peerId, email: 'peer@invalid.test' }, process.env.JWT_SECRET!, { expiresIn: '1m' });
    const shared = Array.from({ length: 50 }, (_, index) => `shared-${userId.slice(0, 8)}-${index}`);
    for (const slug of shared) generatedTopics.add(slug);
    const bodyFor = (topics: string[]) => ({ skills: topics.slice(0, 50), interests: topics.slice(50), tech_stack: [] });
    // Hold the first canonical topic row until both HTTP transactions are
    // blocked inside their topic upsert. Merely starting requests together can
    // miss lock contention; this also exposes inconsistent topic lock ordering.
    await sqlClient`INSERT INTO app.topics(slug,display_name) VALUES(${shared[0]},${shared[0]})`;
    const gate = await sqlClient.reserve();
    let concurrent: Promise<Response[]> | undefined;
    try {
      await gate`BEGIN`;
      await gate`SELECT topic_id FROM app.topics WHERE slug=${shared[0]} FOR UPDATE`;
      const deadline = Date.now() + 5_000;
      const waitForBlocked = async (count: number) => {
        while (true) {
          const [{ blocked }] = await sqlClient`SELECT count(*)::int AS blocked FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%INSERT INTO app.topics%'`;
          if (blocked === count) return;
          assert.ok(Date.now() < deadline, 'both requests must reach the blocked topic write');
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      };
      const first = send(bodyFor(shared));
      concurrent = Promise.all([first]); void concurrent.catch(() => undefined);
      await waitForBlocked(1);
      concurrent = Promise.all([first, send(bodyFor([...shared].reverse()), peerToken)]);
      void concurrent.catch(() => undefined);
      await waitForBlocked(2);
    } finally {
      try { await gate`ROLLBACK`; } finally { gate.release(); }
      if (concurrent) await Promise.allSettled([concurrent]);
    }
    for (const result of await concurrent!) assert.equal(result.status, 200, await result.text());
    for (const id of [userId, peerId]) {
      const rows = await sqlClient`SELECT topic.slug FROM app.user_topics membership JOIN app.topics topic USING(topic_id)
        WHERE membership.user_id=${id}::uuid ORDER BY topic.slug`;
      assert.deepEqual(rows.map(row => row.slug), [...shared].sort(), 'overlapping topic creation keeps both complete memberships');
    }
    const atomicId = crypto.randomUUID(); completionUsers.push(atomicId);
    await sqlClient`INSERT INTO auth.users(id) VALUES(${atomicId}::uuid)`;
    await sqlClient`INSERT INTO app.users(user_id,username,status) VALUES(${atomicId}::uuid,${'pending_'+atomicId.replaceAll('-','')},'active')`;
    await sqlClient`INSERT INTO app.user_stats(user_id) VALUES(${atomicId}::uuid)`;
    await sqlClient`INSERT INTO app.user_feed_state(user_id) VALUES(${atomicId}::uuid)`;
    const atomicToken = jwt.sign({ userId: atomicId }, process.env.JWT_SECRET!, { expiresIn: '5m' });
    const call = (path: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${address.port}/api/v2${path}`, {
      method, headers: { Authorization: `Bearer ${atomicToken}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const slug = 'atomic-' + atomicId.slice(0,8); generatedTopics.add(slug);
    const identity = { username: 'complete_'+atomicId.replaceAll('-',''), full_name: ' Atomic User ', date_of_birth: '2005-01-01', avatar_url: null };
    const completion = { profile: identity, bio: ' Rust ', skills: [slug], interests: [], tech_stack: [] };
    const snapshot = async () => (await call('/users/me')).json() as Promise<{data:Record<string,unknown>}>;
    const beforeAtomic = (await snapshot()).data;
    for (const profile of [{...identity, date_of_birth:'2005-02-30'},{...identity,full_name:''},{...identity,avatar_url:12},
      {...identity,username:'bad space'},{...identity,user_id:peerId}]) {
      assert.equal((await call('/onboarding/complete','PUT',{...completion,profile})).status,400);
    }
    assert.equal((await call('/onboarding/complete','PUT',{...completion,profile:{...identity,username:'import_'+peerId.replaceAll('-','')}})).status,409);
    assert.deepEqual((await snapshot()).data,beforeAtomic,'validation/username conflicts leave identity and completion untouched');
    const malformed = await call('/onboarding/complete','PUT',{...completion,taxonomy_selections:{version:1,skills:[{id:'data',label:'forged'}],interests:[]}});
    assert.equal(malformed.status,400);assert.deepEqual((await snapshot()).data,beforeAtomic);
    // Fail after profile, feed and topics changed, when queuing the ML delivery.
    await sqlClient.unsafe(`CREATE FUNCTION telemetry.${completionFault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.aggregate_id='${atomicId}'::uuid THEN RAISE EXCEPTION 'fixture_completion_outbox_failure'; END IF;RETURN NEW;END $$`);
    await sqlClient.unsafe(`CREATE TRIGGER ${completionFault} BEFORE INSERT ON telemetry.ml_outbox FOR EACH ROW EXECUTE FUNCTION telemetry.${completionFault}()`);
    assert.equal((await call('/onboarding/complete','PUT',completion)).status,500);
    assert.deepEqual((await snapshot()).data,beforeAtomic,'all onboarding writes roll back if durable delivery cannot be queued');
    assert.equal((await sqlClient`SELECT 1 FROM telemetry.ml_outbox WHERE aggregate_id=${atomicId}::uuid`).length,0);
    await sqlClient.unsafe(`DROP TRIGGER ${completionFault} ON telemetry.ml_outbox`);await sqlClient.unsafe(`DROP FUNCTION telemetry.${completionFault}()`);
    for (const ordered of [false,true]) {
      if(ordered) await sqlClient`UPDATE app.user_feed_state SET model_policy_sha256=${'a'.repeat(64)},
        model_policy_limits=${JSON.stringify({input_bytes:131072,max_sessions:2,generation_freshness_ms:10000,idle_expiry_ms:60000})}::jsonb WHERE user_id=${atomicId}::uuid`;
      const before=(await snapshot()).data;
      const response=await call('/onboarding/complete','PUT',completion);assert.equal(response.status,200,await response.clone().text());
      const result=(await response.json() as {data:{completed:boolean;viewer:Record<string,unknown>}}).data;
      assert.equal(result.completed,true);assert.deepEqual(result.viewer,(await snapshot()).data,'the transaction returns the same authoritative viewer projection as GET');
      assert.equal(result.viewer.onboarding_completed,true);assert.equal(result.viewer.full_name,'Atomic User');assert.equal(result.viewer.bio,'Rust');
      assert.equal(BigInt(String(result.viewer.profile_version)),BigInt(String(before.profile_version))+1n);
      assert.equal(BigInt(String(result.viewer.feed_version)),BigInt(String(before.feed_version))+1n);
      const deliveries=await sqlClient`SELECT job_type,payload,operation_json FROM telemetry.ml_outbox WHERE aggregate_id=${atomicId}::uuid ORDER BY created_at`;
      assert.equal(deliveries.length,ordered?2:1,'one atomic finish produces one delivery');
      const deliveredProfile=ordered?JSON.parse(deliveries.at(-1)!.operation_json).operation.original_profile_context:deliveries[0].payload.profile;
      assert.equal(deliveredProfile.full_name,'Atomic User');assert.deepEqual(deliveredProfile.skills,[slug]);
    }
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await sqlClient.unsafe(`DROP TRIGGER IF EXISTS ${completionFault} ON telemetry.ml_outbox`);
    await sqlClient.unsafe(`DROP FUNCTION IF EXISTS telemetry.${completionFault}()`);
    for (const id of [userId, peerId, ...completionUsers]) {
      await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${id}::uuid`;
      await sqlClient`DELETE FROM app.users WHERE user_id=${id}::uuid`;
      await sqlClient`DELETE FROM auth.users WHERE id=${id}::uuid`;
    }
    await sqlClient`DELETE FROM app.topics WHERE slug=ANY(${[...generatedTopics]}::text[])`;
    redis.disconnect(); await sqlClient.end({ timeout: 1 });
  }
});
