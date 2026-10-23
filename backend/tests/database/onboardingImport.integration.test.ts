import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { assertDisposableDatabase } from './disposableDatabase.js';

const enabled = process.env.RUN_DATABASE_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();
const integration = enabled ? test : test.skip;

integration('registered onboarding persists stable taxonomy separately and queues canonical ML context atomically', async () => {
  const redisUrl = new URL(process.env.REDIS_DATABASE_TEST_URL ?? 'redis://127.0.0.1:56388/15');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(redisUrl.hostname) && redisUrl.pathname === '/15');
  Object.assign(process.env, { JWT_SECRET: 'onboarding-disposable-fixture-secret', REDIS_URL: redisUrl.toString(),
    SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_KEY: 'fixture', SUPABASE_SERVICE_ROLE_KEY: 'fixture' });
  const [{ default: express }, { default: jwt }, { sqlClient }, { default: router }, { default: redis }] = await Promise.all([
    import('express'), import('jsonwebtoken'), import('../../db/index.js'), import('../../routes/productV2Routes.js'), import('../../config/redis.js'),
  ]);
  const userId = crypto.randomUUID();
  const app = express(); app.use(express.json()); app.use('/api/v2', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.listening ? resolve() : server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test HTTP address.');
  const token = jwt.sign({ userId, email: 'fixture@invalid.test' }, process.env.JWT_SECRET!, { expiresIn: '1m' });
  const taxonomy = { version: 1, skills: [{ id: 'data', label: 'Data Engineering & AI/ML Pipelines' }],
    interests: [{ id: 'c++', label: 'c++' }] };
  const send = (body: unknown) => fetch(`http://127.0.0.1:${address.port}/api/v2/onboarding`, {
    method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
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
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${userId}::uuid`;
    await sqlClient`DELETE FROM app.users WHERE user_id=${userId}::uuid`;
    await sqlClient`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    redis.disconnect(); await sqlClient.end({ timeout: 1 });
  }
});
