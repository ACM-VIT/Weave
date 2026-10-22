import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { sqlClient } from '../../db/index.js';
import { processInteractionBatchV2 } from '../../services/activityV2Service.js';
import type { InteractionEventV2 } from '../../contracts/interactions.v2.js';
import { assertDisposableDatabase } from './disposableDatabase.js';
const enabled = process.env.RUN_DATABASE_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();
const integration = enabled ? test : test.skip;
const fixtures: { users: string[]; repos: string[] }[] = [];
test.afterEach(async () => {
  for (const fixture of fixtures) {
    await sqlClient.begin(async tx => {
      await tx`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=ANY(${fixture.users}::uuid[])`;
      await tx`DELETE FROM app.users WHERE user_id=ANY(${fixture.users}::uuid[])`;
      await tx`DELETE FROM auth.users WHERE id=ANY(${fixture.users}::uuid[])`;
      await tx`DELETE FROM app.repos WHERE repo_id=ANY(${fixture.repos}::uuid[])`;
    });
  }
  fixtures.length = 0;
});
test.after(async () => { if (enabled) await sqlClient.end({ timeout: 1 }); });

async function fixture() {
  const users = [crypto.randomUUID(), crypto.randomUUID()];
  const repos = Array.from({ length: 10 }, () => crypto.randomUUID());
  // Register before the first write so failed setup and failed assertions clean up too.
  fixtures.push({ users, repos });
  const session = crypto.randomUUID(); const serve = crypto.randomUUID();
  await sqlClient`INSERT INTO auth.users(id) SELECT unnest(${users}::uuid[])`;
  await sqlClient`INSERT INTO app.users(user_id,username,status)
    SELECT id,'batch_' || replace(id::text,'-',''),'active' FROM unnest(${users}::uuid[]) AS id`;
  await sqlClient`INSERT INTO app.user_stats(user_id) SELECT unnest(${users}::uuid[])`;
  await sqlClient`INSERT INTO app.user_feed_state(user_id) SELECT unnest(${users}::uuid[])`;
  await sqlClient`INSERT INTO app.repos(repo_id,github_id,full_name,owner,name,url,status)
    SELECT id,${Date.now()*100}::bigint + position,'fixture/repo' || id,'fixture','repo' || position,
      'https://github.com/fixture/repo' || position,'active'
    FROM unnest(${repos}::uuid[]) WITH ORDINALITY AS input(id,position)`;
  await sqlClient`INSERT INTO telemetry.feed_serves(serve_id,feed_request_id,user_id,session_id,feed_version,source)
    VALUES(${serve}::uuid,${crypto.randomUUID()}::uuid,${users[0]}::uuid,${session}::uuid,1,'integration')`;
  await sqlClient`INSERT INTO telemetry.feed_serve_items(serve_id,position,repo_id,source)
    SELECT ${serve}::uuid,position-1,id,'integration'
    FROM unnest(${repos}::uuid[]) WITH ORDINALITY AS input(id,position)`;
  const event = (type: InteractionEventV2['event_type'], repo = 0): InteractionEventV2 => ({
    event_id: crypto.randomUUID(), schema_version: 2, session_id: session, serve_id: serve,
    repo_id: repos[repo], position: repo, event_type: type, dwell_ms: type === 'dwell' ? 4000 : null,
    client_occurred_at: '2026-10-20T12:00:00.000Z', context: { source: 'integration', flags: [1, true] },
  });
  return { users, repos, event };
}

// Activity save events reconcile the durable union of List memberships.
async function addMembership(userId: string, repoIds: string[]) {
  const boardId = crypto.randomUUID();
  await sqlClient`INSERT INTO app.boards(board_id,user_id,name,visibility)
    VALUES(${boardId}::uuid,${userId}::uuid,'Batch fixture','private')`;
  await sqlClient`INSERT INTO app.board_repos(board_id,repo_id,added_by)
    SELECT ${boardId}::uuid,id,${userId}::uuid FROM unnest(${repoIds}::uuid[]) AS id`;
}

integration('mixed client-ordered transitions retain exact counters, feedback ordering and duplicate identity', async () => {
  const f = await fixture();
  await addMembership(f.users[0], [f.repos[0]]);
  const events = ['like','dislike','undislike','save','unsave','save','impression','dwell','readme_open']
    .map(type => f.event(type as InteractionEventV2['event_type']));
  const result = await processInteractionBatchV2(f.users[0], events);
  assert.equal(result.accepted, 9);
  assert.deepEqual(result.results.map(row => row.feedback_version ?? null), ['1','2','3','4','5','6',null,'7','8']);
  const state = (await sqlClient`SELECT likes_count,dislikes_count,saves_count,views_count FROM app.repo_engagement WHERE repo_id=${f.repos[0]}::uuid`)[0];
  assert.deepEqual([state.likes_count,state.dislikes_count,state.saves_count,Number(state.views_count)], [0,0,1,1]);
  const engagement = (await sqlClient`SELECT impressions,readme_opens,total_dwell_ms FROM telemetry.user_repo_engagement
    WHERE user_id=${f.users[0]}::uuid AND repo_id=${f.repos[0]}::uuid`)[0];
  assert.deepEqual([engagement.impressions,engagement.readme_opens,Number(engagement.total_dwell_ms)], [1,1,4000]);
  const replay = await processInteractionBatchV2(f.users[0], events);
  assert.equal(replay.accepted, 0); assert.equal(replay.duplicates, 9);
  const feedback = await sqlClient`SELECT payload FROM telemetry.ml_outbox WHERE aggregate_id=${f.users[0]}::uuid ORDER BY (payload->>'feedback_version')::bigint`;
  assert.deepEqual(feedback.map(row => row.payload.event_type), ['like','dislike','undislike','save','unsave','save','dwell','readme_open']);
});

integration('duplicate IDs in one batch acknowledge only the first insertion and reject conflicting context atomically', async () => {
  const f = await fixture(); const first = f.event('impression');
  const result = await processInteractionBatchV2(f.users[0], [first, { ...first }]);
  assert.equal(result.accepted, 1); assert.equal(result.duplicates, 1);
  assert.deepEqual(result.results.map(row => row.status), ['accepted','duplicate']);
  await assert.rejects(processInteractionBatchV2(f.users[0], [f.event('like'), { ...first, context: { changed: true } }]), /different content/);
  assert.equal(Number((await sqlClient`SELECT count(*) FROM app.reactions WHERE user_id=${f.users[0]}::uuid`)[0].count), 0);
  const conflicting = f.event('save');
  await assert.rejects(processInteractionBatchV2(f.users[0], [conflicting, { ...conflicting, event_type: 'unsave' }]), /different content/);
  assert.equal(Number((await sqlClient`SELECT count(*) FROM app.saves WHERE user_id=${f.users[0]}::uuid`)[0].count), 0);
});

integration('a replay with different immutable context rolls back preceding state changes', async () => {
  const f = await fixture(); const first = f.event('impression');
  await processInteractionBatchV2(f.users[0], [first]);
  await assert.rejects(processInteractionBatchV2(f.users[0], [f.event('like'), { ...first, context: { changed: true } }]), /different content/);
  assert.equal(Number((await sqlClient`SELECT count(*) FROM app.reactions WHERE user_id=${f.users[0]}::uuid`)[0].count), 0);
});

integration('UUID case variants retain canonical identity and acknowledge the supplied event IDs', async () => {
  const f = await fixture(); const original = f.event('like');
  const upper = { ...original, event_id: original.event_id.toUpperCase(), repo_id: original.repo_id.toUpperCase(),
    session_id: original.session_id.toUpperCase(), serve_id: original.serve_id!.toUpperCase() };
  const result = await processInteractionBatchV2(f.users[0], [upper, original]);
  assert.deepEqual(result.results.map(row => [row.event_id,row.status]), [[upper.event_id,'accepted'],[original.event_id,'duplicate']]);
  assert.equal(result.accepted, 1);
  assert.equal(Number((await sqlClient`SELECT likes_count FROM app.repo_engagement WHERE repo_id=${f.repos[0]}::uuid`)[0].likes_count), 1);
});

integration('invalid serve owner, repo or position rolls back the whole batch and all feedback', async () => {
  const f = await fixture();
  for (const invalid of [{ ...f.event('save'), position: 9 }, { ...f.event('save'), repo_id: f.repos[1] }]) {
    await assert.rejects(processInteractionBatchV2(f.users[0], [f.event('like'), invalid]), /serve item/);
  }
  await assert.rejects(processInteractionBatchV2(f.users[1], [f.event('like')]), /serve item/);
  assert.equal(Number((await sqlClient`SELECT count(*) FROM telemetry.interaction_events WHERE user_id=ANY(${f.users}::uuid[])`)[0].count), 0);
  assert.equal(Number((await sqlClient`SELECT count(*) FROM telemetry.ml_outbox WHERE aggregate_id=ANY(${f.users}::uuid[])`)[0].count), 0);
});

integration('overlapping batches serialize same-user feedback and shared repository counters without deadlock', async () => {
  const f = await fixture();
  await addMembership(f.users[0], f.repos.slice(0, 2));
  await addMembership(f.users[1], [f.repos[1]]);
  const start = [f.event('like', 0), f.event('save', 1)];
  const duplicateResults = await Promise.all([processInteractionBatchV2(f.users[0], start), processInteractionBatchV2(f.users[0], start)]);
  assert.equal(duplicateResults.reduce((n, row) => n + row.accepted, 0), 2);
  await Promise.all([
    processInteractionBatchV2(f.users[0], [f.event('dislike', 1), f.event('save', 0)]),
    processInteractionBatchV2(f.users[1], [
      { ...f.event('save', 1), serve_id: null, position: null }, { ...f.event('like', 0), serve_id: null, position: null },
    ]),
  ]);
  const rows = await sqlClient`SELECT repo_id,likes_count,dislikes_count,saves_count FROM app.repo_engagement WHERE repo_id=ANY(${f.repos.slice(0,2)}::uuid[])`;
  const byRepo = new Map(rows.map(row => [String(row.repo_id), row]));
  assert.deepEqual([byRepo.get(f.repos[0])?.likes_count,byRepo.get(f.repos[0])?.saves_count], [2,1]);
  assert.deepEqual([byRepo.get(f.repos[1])?.dislikes_count,byRepo.get(f.repos[1])?.saves_count], [1,2]);
  const versions = await sqlClient`SELECT feedback_version FROM telemetry.interaction_events WHERE user_id=${f.users[0]}::uuid ORDER BY feedback_version`;
  assert.deepEqual(versions.map(row => String(row.feedback_version)), ['1','2','3','4']);
});

integration('commutative batches use bounded SQL statements rather than per-event round trips', async () => {
  const measures = [];
  for (const type of ['impression','dwell','github_open','like','save'] as const) {
    const f = await fixture(); const events = Array.from({ length: 40 }, (_, index) => f.event(type, index % 10));
    let statements = 0; const before = performance.now(); const oldDebug = sqlClient.options.debug;
    sqlClient.options.debug = () => { statements++; };
    try { await processInteractionBatchV2(f.users[0], events); }
    finally { sqlClient.options.debug = oldDebug; }
    const measure = { type, events: 40, repos: 10, statements, milliseconds: Math.round((performance.now()-before)*100)/100 };
    console.log(`BATCH_MEASURE ${JSON.stringify(measure)}`); measures.push(measure);
  }
  for (const row of measures.filter(row => ['impression','dwell','github_open'].includes(row.type))) {
    assert.ok(row.statements <= 16, `${row.type}: ${row.statements} statements`);
  }
});
