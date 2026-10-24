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
    const shared = Array.from({ length: 100 }, (_, index) => `shared-${userId.slice(0, 8)}-${index}`);
    const bodyFor = (topics: string[]) => ({ skills: topics.slice(0, 50), interests: topics.slice(50), tech_stack: [] });
    const concurrent = await Promise.all([send(bodyFor(shared)), send(bodyFor([...shared].reverse()), peerToken)]);
    for (const result of concurrent) assert.equal(result.status, 200, await result.text());
    for (const id of [userId, peerId]) {
      const rows = await sqlClient`SELECT topic.slug FROM app.user_topics membership JOIN app.topics topic USING(topic_id)
        WHERE membership.user_id=${id}::uuid ORDER BY topic.slug`;
      assert.deepEqual(rows.map(row => row.slug), [...shared].sort(), 'overlapping topic creation keeps both complete memberships');
    }
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const id of [userId, peerId]) {
      await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${id}::uuid`;
      await sqlClient`DELETE FROM app.users WHERE user_id=${id}::uuid`;
      await sqlClient`DELETE FROM auth.users WHERE id=${id}::uuid`;
    }
    redis.disconnect(); await sqlClient.end({ timeout: 1 });
  }
});
