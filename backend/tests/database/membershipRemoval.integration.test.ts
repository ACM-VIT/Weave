import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sqlClient } from '../../db/index.js';
import {
  deleteRepositoryBoard, deleteRepositoryList, removeRepositoryFromBoard, syncRepositoryLists,
} from '../../services/repositoryMembershipService.js';

const integration=process.env.RUN_DATABASE_INTEGRATION==='1'?test:test.skip;
test.after(async()=>{if(process.env.RUN_DATABASE_INTEGRATION==='1')await sqlClient.end({timeout:1});});
for(const route of ['board-repository','board','list'] as const)
for(const retained of [true,false])
integration(`${route} removal records unsave exactly once only for a final membership (retained=${retained})`,async()=>{
  const url=new URL(process.env.DATABASE_URL!);
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
  const user=randomUUID(),repo=randomUUID(),list=randomUUID(),board=randomUUID(),keeper=randomUUID();
  try{
    await sqlClient`INSERT INTO auth.users(id) VALUES(${user}::uuid)`;
    await sqlClient`INSERT INTO app.users(user_id,username) VALUES(${user}::uuid,${`member_${user}`})`;
    await sqlClient`INSERT INTO app.user_stats(user_id) VALUES(${user}::uuid)`;
    await sqlClient`INSERT INTO app.repos(repo_id,github_id,full_name,owner,name,url)
      VALUES(${repo}::uuid,${BigInt('0x'+repo.replaceAll('-','').slice(0,13)).toString()}::bigint,
        ${`membership/${repo}`},'membership',${repo},${`https://github.com/membership/${repo}`})`;
    await sqlClient`INSERT INTO app.repo_engagement(repo_id) VALUES(${repo}::uuid)`;
    await sqlClient`INSERT INTO app.board_collections(collection_id,user_id,name)
      VALUES(${list}::uuid,${user}::uuid,'List'),(${keeper}::uuid,${user}::uuid,'Keeper')`;
    await sqlClient`INSERT INTO app.boards(board_id,user_id,name) VALUES(${board}::uuid,${user}::uuid,'Board')`;
    await syncRepositoryLists(user,repo,
      [...(route==='list'?[list]:[]),...(retained?[keeper]:[])],route==='list'?[]:[board]);
    const before=(await sqlClient`SELECT feed_version,feedback_version FROM app.user_feed_state WHERE user_id=${user}::uuid`)[0];
    const remove=()=>route==='board-repository'?removeRepositoryFromBoard(user,board,repo)
      :route==='board'?deleteRepositoryBoard(user,board):deleteRepositoryList(user,list);
    assert.ok(await remove());
    assert.equal(await remove(),null,'Retrying an already-removed membership must not create another event');
    const events=await sqlClient`SELECT event_id,context FROM telemetry.interaction_events
      WHERE user_id=${user}::uuid AND repo_id=${repo}::uuid AND event_type='unsave'`;
    assert.equal(events.length,retained?0:1);
    if(events.length){
      assert.equal(events[0].context.save_state_source,'list_membership');
      const feedback=await sqlClient`SELECT payload FROM telemetry.ml_outbox WHERE idempotency_key=${`feedback:${events[0].event_id}`}`;
      assert.equal(feedback.length,1,'The same unsave must reach durable ML feedback');
    }
    const after=(await sqlClient`SELECT feed_version,feedback_version FROM app.user_feed_state WHERE user_id=${user}::uuid`)[0];
    assert.equal(BigInt(after.feed_version),BigInt(before.feed_version)+(retained?0n:1n));
    assert.equal(BigInt(after.feedback_version),BigInt(before.feedback_version)+(retained?0n:1n));
    assert.equal(Number((await sqlClient`SELECT saves_count FROM app.repo_engagement WHERE repo_id=${repo}::uuid`)[0].saves_count),retained?1:0);
    assert.equal(Number((await sqlClient`SELECT saved_repos_count FROM app.user_stats WHERE user_id=${user}::uuid`)[0].saved_repos_count),retained?1:0);
  }finally{
    await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${user}::uuid`;
    await sqlClient`DELETE FROM telemetry.interaction_events WHERE user_id=${user}::uuid`;
    await sqlClient`DELETE FROM telemetry.user_repo_engagement WHERE user_id=${user}::uuid`;
    await sqlClient`DELETE FROM app.repos WHERE repo_id=${repo}::uuid`;
    await sqlClient`DELETE FROM app.users WHERE user_id=${user}::uuid`;
    await sqlClient`DELETE FROM auth.users WHERE id=${user}::uuid`;
  }
});

integration('legacy List saves and subsequent client interactions record one event per transition', async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  const { processInteractionBatchV2 } = await import('../../services/activityV2Service.js');
  const user = randomUUID(), repo = randomUUID(), list = randomUUID();
  try {
    await sqlClient`INSERT INTO auth.users(id) VALUES(${user}::uuid)`;
    await sqlClient`INSERT INTO app.users(user_id,username) VALUES(${user}::uuid,${`legacy_${user}`})`;
    await sqlClient`INSERT INTO app.user_stats(user_id) VALUES(${user}::uuid)`;
    await sqlClient`INSERT INTO app.repos(repo_id,github_id,full_name,owner,name,url)
      VALUES(${repo}::uuid,${BigInt('0x'+repo.replaceAll('-','').slice(0,13)).toString()}::bigint,
        ${`legacy/${repo}`},'legacy',${repo},${`https://github.com/legacy/${repo}`})`;
    await sqlClient`INSERT INTO app.repo_engagement(repo_id) VALUES(${repo}::uuid)`;
    await sqlClient`INSERT INTO app.board_collections(collection_id,user_id,name)
      VALUES(${list}::uuid,${user}::uuid,'Legacy List')`;
    for (const saved of [true, false]) {
      const state = await syncRepositoryLists(user, repo, saved ? [list] : [], []);
      assert.equal(state.saved, saved);
      assert.equal(state.save_state_changed, true);
      const eventType = saved ? 'save' : 'unsave';
      const countEvents = () => sqlClient`SELECT event_id FROM telemetry.interaction_events
        WHERE user_id=${user}::uuid AND repo_id=${repo}::uuid AND event_type=${eventType}`;
      assert.equal((await countEvents()).length, 0, 'Legacy clients own their follow-up event');
      const event = {
        event_id: randomUUID(), schema_version: 2 as const, session_id: randomUUID(),
        serve_id: null, position: null, repo_id: repo, event_type: eventType as 'save' | 'unsave',
        dwell_ms: null, client_occurred_at: new Date().toISOString(), context: {},
      };
      await processInteractionBatchV2(user, [event]);
      await processInteractionBatchV2(user, [event]);
      assert.equal((await countEvents()).length, 1, 'The follow-up and retry create exactly one history row');
      assert.equal((await sqlClient`SELECT outbox_id FROM telemetry.ml_outbox
        WHERE idempotency_key=${`feedback:${event.event_id}`}`).length, 1);
      assert.equal(Number((await sqlClient`SELECT saves_count FROM app.repo_engagement
        WHERE repo_id=${repo}::uuid`)[0].saves_count), saved ? 1 : 0);
    }
    assert.equal(Number((await sqlClient`SELECT feedback_version FROM app.user_feed_state
      WHERE user_id=${user}::uuid`)[0].feedback_version), 2);
  } finally {
    await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${user}::uuid`;
    await sqlClient`DELETE FROM telemetry.interaction_events WHERE user_id=${user}::uuid`;
    await sqlClient`DELETE FROM telemetry.user_repo_engagement WHERE user_id=${user}::uuid`;
    await sqlClient`DELETE FROM app.repos WHERE repo_id=${repo}::uuid`;
    await sqlClient`DELETE FROM app.users WHERE user_id=${user}::uuid`;
    await sqlClient`DELETE FROM auth.users WHERE id=${user}::uuid`;
  }
});
