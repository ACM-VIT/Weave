import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { assertDisposableDatabase } from './disposableDatabase.js';

const enabled = process.env.RUN_DATABASE_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();
const integration = enabled ? test : test.skip;

integration('registered onboarding batches topic writes and skips unchanged profile deliveries', async t => {
  const redisUrl = new URL(process.env.REDIS_DATABASE_TEST_URL ?? 'redis://127.0.0.1:56388/15');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(redisUrl.hostname) && redisUrl.pathname === '/15');
  Object.assign(process.env, { JWT_SECRET: 'onboarding-disposable-fixture-secret', REDIS_URL: redisUrl.toString(),
    SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_KEY: 'fixture', SUPABASE_SERVICE_ROLE_KEY: 'fixture' });
  const [{ default: express }, { default: jwt }, { sqlClient }, { default: router }, { default: redis }] = await Promise.all([
    import('express'), import('jsonwebtoken'), import('../../db/index.js'), import('../../routes/productV2Routes.js'), import('../../config/redis.js'),
  ]);
  const userId = crypto.randomUUID(), peerId = crypto.randomUUID();
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
    {
    const patch = async (body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v2/users/me`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as {data: Record<string, unknown>} };
    };
    const frontier = async () => (await sqlClient`
      SELECT u.profile_version,u.updated_at::text AS user_updated,u.xmin::text AS user_revision,
        f.feed_version,f.model_operation_version,f.model_accepted_at_ms,f.updated_at::text AS feed_updated,
        (SELECT count(*) FROM telemetry.ml_outbox WHERE aggregate_id=u.user_id) AS jobs
      FROM app.users u JOIN app.user_feed_state f USING(user_id) WHERE user_id=${userId}::uuid
    `)[0];
    const measurements: {lane: string; before: Awaited<ReturnType<typeof frontier>>; after: Awaited<ReturnType<typeof frontier>>}[] = [];
    const username = 'import_'+userId.replaceAll('-', '');
    for (const lane of ['legacy','ordered']) {
      if (lane === 'ordered') await sqlClient`UPDATE app.user_feed_state SET model_policy_sha256=${'a'.repeat(64)},
        model_policy_limits=${JSON.stringify({input_bytes:131072,max_sessions:2,generation_freshness_ms:10000,idle_expiry_ms:60000})}::jsonb
        WHERE user_id=${userId}::uuid`;
      const before = await frontier(), started = performance.now();
      for (let index=0;index<20;index++) {
        const result = await patch(index%2 ? {username:` ${username} `,full_name:' Tarun ',date_of_birth:'2005-01-01',bio:null,avatar_url:null} : {});
        assert.equal(result.status,200,JSON.stringify(result.body));
        assert.deepEqual(Object.keys(result.body.data).sort(),['user_id','username','full_name','date_of_birth','bio','github_handle','avatar_url',
          'interests','skills','tech_stack','profile_version','updated_at'].sort());
      }
      const milliseconds = performance.now()-started, after = await frontier();
      measurements.push({lane,before,after});
      t.diagnostic(JSON.stringify({lane,unchangedSaves:20,milliseconds:Math.round(milliseconds*100)/100,
        profileWrites:Number(after.profile_version)-Number(before.profile_version),feedAdvances:Number(after.feed_version)-Number(before.feed_version),
        modelAdvances:Number(after.model_operation_version)-Number(before.model_operation_version),deliveries:Number(after.jobs)-Number(before.jobs)}));
    }
    for (const {lane,before,after} of measurements) assert.deepEqual(after,before,`${lane} no-ops preserve every frontier, timestamp and profile row revision`);

    const beforeEdit = await frontier(), editStarted = performance.now();
    const changed = await patch({bio:' New bio '});
    assert.equal(changed.status,200);assert.equal(changed.body.data.bio,'New bio');
    const afterEdit = await frontier();
    for (const key of ['profile_version','feed_version','model_operation_version','jobs']) {
      assert.equal(BigInt(afterEdit[key]),BigInt(beforeEdit[key])+1n,`${key} advances for a real edit`);
    }
    t.diagnostic(JSON.stringify({changedSaves:1,milliseconds:Math.round((performance.now()-editStarted)*100)/100,deliveries:1}));
    const nullable = await patch({full_name:null,avatar_url:'https://example.invalid/avatar.png'});
    assert.equal(nullable.status,200);assert.equal(nullable.body.data.full_name,null);assert.equal(nullable.body.data.bio,'New bio');
    assert.deepEqual((await patch({full_name:null})).body.data,nullable.body.data,'an explicit already-null value is unchanged');
    const empty = await patch({full_name:''});
    assert.equal(empty.status,200);assert.equal(empty.body.data.full_name,'');
    assert.equal(BigInt(String(empty.body.data.profile_version)),BigInt(String(nullable.body.data.profile_version))+1n,'null and empty text remain distinct');
    const cleared = await patch({avatar_url:null});
    assert.equal(cleared.status,200);assert.equal(cleared.body.data.avatar_url,null);
    assert.deepEqual((await patch({avatar_url:null})).body.data,cleared.body.data);
    const beforeCase=await frontier();
    const caseEdit=await patch({username:username.toUpperCase()});
    assert.equal(caseEdit.status,200);assert.equal(caseEdit.body.data.username,username.toUpperCase(),'citext storage still preserves display case');
    const afterCase=await frontier();
    for(const key of ['profile_version','feed_version','model_operation_version','jobs'])assert.equal(BigInt(afterCase[key]),BigInt(beforeCase[key])+1n);
    assert.deepEqual((await patch({username:username.toUpperCase()})).body.data,caseEdit.body.data,'an identical display-case retry is a no-op');
    assert.equal((await patch({username})).body.data.username,username);
    const beforeInvalid = await frontier();
    for (const body of [{date_of_birth:null},{date_of_birth:'2005-02-30'},{username:null},{full_name:'x'.repeat(101)},{unknown:true}]) {
      assert.equal((await patch(body)).status,400,'no-op detection cannot bypass existing validation');
    }
    assert.deepEqual(await frontier(),beforeInvalid);

    const gate = await sqlClient.reserve();let locked=false;
    const pending: ReturnType<typeof patch>[]=[];
    try {
      await gate`BEGIN`;locked=true;
      await gate`SELECT user_id FROM app.users WHERE user_id=${userId}::uuid FOR UPDATE`;
      const waitForBlocked = async (count: number) => {
        const deadline=performance.now()+5000;
        while(Number((await sqlClient`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
          AND state='active' AND wait_event_type='Lock' AND query ILIKE '%FROM app.users%FOR UPDATE%'`)[0].count)<count) {
          if(performance.now()>deadline)throw new Error('Concurrent profile requests did not reach the user lock');
          await new Promise(resolve=>setTimeout(resolve,10));
        }
      };
      const before = await frontier();
      pending.push(patch({full_name:'Concurrent name'}));await waitForBlocked(1);
      pending.push(patch({avatar_url:'https://example.invalid/concurrent.png'}));await waitForBlocked(2);
      await gate`ROLLBACK`;locked=false;
      const results=await Promise.all(pending);results.forEach(result=>assert.equal(result.status,200));
      const after=await frontier();
      for (const key of ['profile_version','feed_version','model_operation_version','jobs']) assert.equal(BigInt(after[key]),BigInt(before[key])+2n);
      const latest=(await patch({})).body.data;
      assert.equal(latest.full_name,'Concurrent name');assert.equal(latest.avatar_url,'https://example.invalid/concurrent.png');
      const sameBefore=await frontier();
      await gate`BEGIN`;locked=true;
      await gate`SELECT user_id FROM app.users WHERE user_id=${userId}::uuid FOR UPDATE`;
      pending.push(patch({bio:'Same concurrent edit'}));await waitForBlocked(1);
      pending.push(patch({bio:'Same concurrent edit'}));await waitForBlocked(2);
      await gate`ROLLBACK`;locked=false;
      const identical=await Promise.all(pending.slice(2));
      identical.forEach(result=>assert.equal(result.status,200));
      assert.equal(identical[0].body.data.profile_version,identical[1].body.data.profile_version);
      const sameAfter=await frontier();
      for (const key of ['profile_version','feed_version','model_operation_version','jobs']) assert.equal(BigInt(sameAfter[key]),BigInt(sameBefore[key])+1n);
    } finally {if(locked)await gate`ROLLBACK`;gate.release();await Promise.allSettled(pending);}
    }
    {
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
    }

  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const id of [userId, peerId]) {
      await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${id}::uuid`;
      await sqlClient`DELETE FROM app.users WHERE user_id=${id}::uuid`;
      await sqlClient`DELETE FROM auth.users WHERE id=${id}::uuid`;
    }
    await sqlClient`DELETE FROM app.topics WHERE slug=ANY(${[...generatedTopics]}::text[])`;
    redis.disconnect(); await sqlClient.end({ timeout: 1 });
  }
});
