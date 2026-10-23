import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { FeedQueuePort } from '../../redis/feedQueue.js';

const enabled = process.env.RUN_NEGATIVE_PREFERENCE_INTEGRATION === '1';
if (enabled) {
  const target = new URL(process.env.DATABASE_URL ?? '');
  assert.notEqual(process.env.NODE_ENV, 'production');
  assert.ok(['postgres:', 'postgresql:'].includes(target.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
  assert.equal(target.pathname, '/weave_negative_preferences_test');
  assert.equal(target.search + target.hash, '');
}

test('durable recovery fills limited pages from older eligible history during Redis outage', {
  skip: !enabled, timeout: 30_000,
}, async t => {
  const [{ sqlClient: sql }, { PostgresFeedPersistence }, { FeedV2Service }] = await Promise.all([
    import('../../db/index.js'), import('../../adapters/postgresFeedPersistence.js'),
    import('../../services/feedV2Service.js'),
  ]);
  const viewer = randomUUID(), peer = randomUUID();
  const newest = randomUUID(), older = randomUUID();
  const users = [viewer, peer], repos = [newest, older];
  const persistence = new PostgresFeedPersistence();
  let service: InstanceType<typeof FeedV2Service> | undefined;
  try {
    for (const user of users) {
      await sql`INSERT INTO auth.users(id) VALUES(${user}::uuid)`;
      await sql`INSERT INTO app.users(user_id,username,status)
        VALUES(${user}::uuid,${'recovery_'+user.replaceAll('-', '')},'active')`;
      await sql`INSERT INTO app.user_feed_state(user_id,feed_version) VALUES(${user}::uuid,1)`;
    }
    for (const repo of repos) {
      await sql`INSERT INTO app.repos(repo_id,github_id,owner,name,full_name,url,status)
        VALUES(${repo}::uuid,${BigInt('0x'+repo.replaceAll('-', '').slice(0,13)).toString()}::bigint,
          'recovery',${repo},${'recovery/'+repo},${'https://github.com/recovery/'+repo},'active')`;
      await sql`INSERT INTO app.repo_content(repo_id,description,content_hash)
        VALUES(${repo}::uuid,'Owned recovery fixture','recovery-fixture')`;
    }
    for (const user of users) for (const [repo, created] of [
      [older, '2026-10-01T00:00:00Z'], [newest, '2026-10-02T00:00:00Z'],
    ]) {
      const serve = randomUUID();
      await sql`INSERT INTO telemetry.feed_serves(serve_id,feed_request_id,user_id,session_id,
        feed_version,source,model_version,created_at)
        VALUES(${serve}::uuid,${randomUUID()}::uuid,${user}::uuid,${randomUUID()}::uuid,
          1,'personalized','recovery-model',${created}::timestamptz)`;
      await sql`INSERT INTO telemetry.feed_serve_items(serve_id,position,repo_id,score,source,model_version)
        VALUES(${serve}::uuid,0,${repo}::uuid,1,'semantic','recovery-model')`;
    }
    await sql`INSERT INTO app.reactions(user_id,repo_id,reaction)
      VALUES(${viewer}::uuid,${newest}::uuid,'dislike'),(${peer}::uuid,${older}::uuid,'dislike')`;

    await t.test('current dislikes filter before newest-first LIMIT and stay viewer-bound', async () => {
      assert.deepEqual((await persistence.getRecentPersonalizedEntries(viewer,1n,1,[])).map(row=>row.repo_id),[older]);
      assert.deepEqual((await persistence.getRecentPersonalizedEntries(peer,1n,1,[])).map(row=>row.repo_id),[newest]);
      assert.deepEqual(await persistence.getRecentPersonalizedEntries(viewer,1n,1,[older]),[]);
    });
    await t.test('real feed service recovers the eligible page and preserves immutable replay', async () => {
      let reserves = 0;
      const unavailable = {
        reserve: async () => { reserves++; throw new Error('Controlled Redis outage'); },
        release: async () => false,
      } as unknown as FeedQueuePort;
      service = new FeedV2Service(persistence, unavailable);
      const request = {feed_request_id:randomUUID(),session_id:randomUUID(),limit:1,cursor:null};
      const page = await service.getFeed(viewer, request);
      assert.deepEqual(page.items.map(item=>item.repo_id),[older]);
      assert.equal(page.source,'personalized');
      assert.equal(reserves,1);
      assert.equal((await persistence.getServeByRequest(viewer,request.feed_request_id))?.serve_id,page.serve_id);
      await sql`INSERT INTO app.reactions(user_id,repo_id,reaction)
        VALUES(${viewer}::uuid,${older}::uuid,'dislike')`;
      const replay = await service.getFeed(viewer,request);
      assert.equal(replay.serve_id,page.serve_id,'same-request replay remains historical truth');
      assert.deepEqual(replay.items.map(item=>[item.repo_id,item.position,item.source]),
        page.items.map(item=>[item.repo_id,item.position,item.source]));
      assert.equal(reserves,1,'replay must not reserve or re-filter recovery history');
    });
  } finally {
    await service?.stop();
    try {
      await sql`DELETE FROM app.users WHERE user_id=ANY(${users}::uuid[])`;
      await sql`DELETE FROM app.repos WHERE repo_id=ANY(${repos}::uuid[])`;
      await sql`DELETE FROM auth.users WHERE id=ANY(${users}::uuid[])`;
    } finally { await sql.end({timeout:1}); }
  }
});
