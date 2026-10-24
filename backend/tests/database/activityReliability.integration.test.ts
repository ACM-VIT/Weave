import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import type { InteractionEventV2 } from '../../contracts/interactions.v2.js';
import { assertDisposableDatabase } from './disposableDatabase.js';

const enabled = process.env.RUN_ACTIVITY_RELIABILITY_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();
const membershipEnabled = enabled || process.env.RUN_DATABASE_INTEGRATION === '1';
if (membershipEnabled) assertDisposableDatabase();
test.after(async()=>{if(enabled||membershipEnabled){const {sqlClient}=await import('../../db/index.js');await sqlClient.end({timeout:1});}});

test('accepted HTTP interactions survive process death, ML outages and replay without duplicate counters', {
  skip: !enabled, timeout: 30_000,
}, async t => {
  const [{ sqlClient }, { OutboxService }, { OutboxWorker }, { MlV2Client }] = await Promise.all([
    import('../../db/index.js'), import('../../services/outboxService.js'),
    import('../../workers/outboxWorker.js'), import('../../services/mlService.js'),
  ]);
  const user = randomUUID(); const repo = randomUUID(); const board = randomUUID();
  const fault = `fixture_activity_${user.replaceAll('-', '')}`;
  const serve = randomUUID(); const session = randomUUID();
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../fixtures/activityApiProcess.ts', import.meta.url))], {
    env: { ...process.env, JWT_SECRET: 'local-activity-reliability-key', DB_SCHEMA_V2_WRITES: 'true' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let mlServer: Server | undefined;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    if (mlServer) await new Promise<void>(resolve => { mlServer!.closeAllConnections(); mlServer!.close(() => resolve()); });
    await sqlClient.unsafe(`DROP TRIGGER IF EXISTS ${fault} ON telemetry.ml_outbox`);
    await sqlClient.unsafe(`DROP FUNCTION IF EXISTS telemetry.${fault}()`);
    await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${user}::uuid`;
    await sqlClient`DELETE FROM app.users WHERE user_id=${user}::uuid`;
    await sqlClient`DELETE FROM auth.users WHERE id=${user}::uuid`;
    await sqlClient`DELETE FROM app.repos WHERE repo_id=${repo}::uuid`;
  });
  const port = await new Promise<string>((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('Activity fixture did not start')), 10_000);
    child.stdout.on('data', chunk => { output += String(chunk); const match = /ACTIVITY_PORT=(\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]!); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Activity fixture exited early')); });
  });
  assert.equal(Number((await sqlClient`SELECT count(*) FROM telemetry.ml_outbox`)[0]!.count), 0, 'Use an empty dedicated fixture outbox');
  await sqlClient`INSERT INTO auth.users(id) VALUES(${user}::uuid)`;
  await sqlClient`INSERT INTO app.users(user_id,username,status) VALUES(${user}::uuid,${'reliability_' + user.replaceAll('-', '')},'active')`;
  await sqlClient`INSERT INTO app.user_stats(user_id) VALUES(${user}::uuid)`;
  await sqlClient`INSERT INTO app.user_feed_state(user_id) VALUES(${user}::uuid)`;
  await sqlClient`INSERT INTO app.repos(repo_id,github_id,full_name,owner,name,url,status)
    VALUES(${repo}::uuid,${Date.now()},${'fixture/' + repo},'fixture',${repo},${'https://github.com/fixture/' + repo},'active')`;
  await sqlClient`INSERT INTO app.repo_engagement(repo_id) VALUES(${repo}::uuid)`;
  await sqlClient`INSERT INTO app.boards(board_id,user_id,name,visibility) VALUES(${board}::uuid,${user}::uuid,'Tarun reliability List','private')`;
  await sqlClient`INSERT INTO app.board_repos(board_id,repo_id,added_by) VALUES(${board}::uuid,${repo}::uuid,${user}::uuid)`;
  await sqlClient`INSERT INTO telemetry.feed_serves(serve_id,feed_request_id,user_id,session_id,feed_version,source)
    VALUES(${serve}::uuid,${randomUUID()}::uuid,${user}::uuid,${session}::uuid,1,'reliability')`;
  await sqlClient`INSERT INTO telemetry.feed_serve_items(serve_id,position,repo_id,source) VALUES(${serve}::uuid,0,${repo}::uuid,'reliability')`;
  const event = (event_type: InteractionEventV2['event_type']): InteractionEventV2 => ({ event_id: randomUUID(), schema_version: 2,
    session_id: session, serve_id: serve, repo_id: repo, position: 0, event_type, dwell_ms: null,
    client_occurred_at: '2026-10-23T00:00:00Z', context: {} });
  const events = [event('like'), event('save')];
  const post = (batch: InteractionEventV2[]) => fetch(`http://127.0.0.1:${port}/api/v2/interactions/batch`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      authorization: `Bearer ${jwt.sign({ userId: user }, 'local-activity-reliability-key')}` },
    body: JSON.stringify({ events: batch }),
  });
  const counts = async () => {
    const [row] = await sqlClient`SELECT e.likes_count,e.saves_count,s.likes_given_count,s.saved_repos_count,
      (SELECT count(*)::int FROM telemetry.interaction_events WHERE user_id=${user}::uuid) AS events,
      (SELECT count(*)::int FROM telemetry.ml_outbox WHERE aggregate_id=${user}::uuid) AS jobs
      FROM app.repo_engagement e CROSS JOIN app.user_stats s WHERE e.repo_id=${repo}::uuid AND s.user_id=${user}::uuid`;
    return [row!.likes_count,row!.saves_count,row!.likes_given_count,row!.saved_repos_count,row!.events,row!.jobs].map(Number);
  };
  const accepted = await post(events); assert.equal(accepted.status, 202);
  assert.equal((await accepted.json() as { accepted: number }).accepted, 2);
  assert.deepEqual(await counts(), [1, 1, 1, 1, 2, 2]);
  const repeated = await post(events); assert.equal(repeated.status, 202);
  assert.equal((await repeated.json() as { duplicates: number }).duplicates, 2);
  const rejected = await post([event('unlike'), { ...event('save'), position: 99 }]);
  assert.equal(rejected.status, 409); assert.deepEqual(await counts(), [1, 1, 1, 1, 2, 2]);
  // This fixture UUID/identifier is generated here, never supplied by a caller.
  // Force a real SQL failure only after the same transaction changed the counter.
  await sqlClient.unsafe(`CREATE FUNCTION telemetry.${fault}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.aggregate_id='${user}'::uuid AND NEW.payload->>'event_type'='unlike' THEN
        IF (SELECT likes_count FROM app.repo_engagement WHERE repo_id='${repo}'::uuid)=0 THEN
          RAISE EXCEPTION 'fixture_outbox_failure_after_counter_write';
        ELSE RAISE EXCEPTION 'fixture_failed_before_counter_write'; END IF;
      END IF;
      RETURN NEW;
    END $$`);
  await sqlClient.unsafe(`CREATE TRIGGER ${fault} BEFORE INSERT ON telemetry.ml_outbox
    FOR EACH ROW EXECUTE FUNCTION telemetry.${fault}()`);
  const failedSql = await post([event('unlike'), event('github_open')]);
  assert.equal(failedSql.status, 409);
  assert.match((await failedSql.json() as { error: string }).error, /fixture_outbox_failure_after_counter_write/);
  assert.deepEqual(await counts(), [1, 1, 1, 1, 2, 2], 'SQL failure rolls back events, counters and outbox together');
  await sqlClient.unsafe(`DROP TRIGGER ${fault} ON telemetry.ml_outbox`);
  await sqlClient.unsafe(`DROP FUNCTION telemetry.${fault}()`);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  assert.equal(child.signalCode, 'SIGKILL'); assert.deepEqual(await counts(), [1, 1, 1, 1, 2, 2]);

  let mode = 'offline'; let timeoutAccepted!: () => void;
  const acceptedBeforeTimeout = new Promise<void>(resolve => { timeoutAccepted = resolve; });
  const durable = new Set<string>(); let requests = 0;
  mlServer = createServer((req, res) => {
    assert.equal(req.headers['x-internal-secret'], 'local-reliability-secret');
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests++;
      const batch = JSON.parse(Buffer.concat(chunks).toString('utf8')).events as Array<{ event_id: string }>;
      if (mode === 'offline') { res.writeHead(503, { 'retry-after': '1' }).end('unavailable'); return; }
      if (mode === 'terminal') { res.writeHead(400).end('invalid fixture delivery'); return; }
      const duplicates = batch.filter(value => durable.has(value.event_id)).length;
      batch.forEach(value => durable.add(value.event_id));
      if (mode === 'timeout') { timeoutAccepted(); return; }
      res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ durable: true,
        accepted: batch.length - duplicates, duplicates, acknowledged_event_ids: batch.map(value => value.event_id) }));
    });
  });
  await new Promise<void>(resolve => mlServer!.listen(0, '127.0.0.1', resolve));
  const address = mlServer.address(); assert.ok(address && typeof address === 'object');
  const options = { baseUrl: `http://127.0.0.1:${address.port}`, internalSecret: 'local-reliability-secret',
    timeoutMs: 1000, deliveryTimeoutMs: 1000, maxResponseBytes: 100_000 };
  const outbox = new OutboxService();
  const worker = () => new OutboxWorker(new OutboxService(), new MlV2Client(options));
  assert.equal(await worker().runOnce(50), 1);
  let status = await outbox.status(); assert.equal(status.pending, 2); assert.equal(status.retrying, 1); assert.equal(status.dead, 0);
  await sqlClient`UPDATE telemetry.ml_outbox SET available_at=now(),created_at=now()-interval '3 minutes' WHERE aggregate_id=${user}::uuid`;
  mode = 'timeout';
  const timingOut = new OutboxWorker(new OutboxService(), new MlV2Client({ ...options, deliveryTimeoutMs: 100 })).runOnce(1);
  await acceptedBeforeTimeout; assert.equal(await timingOut, 1);
  status = await outbox.status(); assert.equal(status.retry_attempts, 1); assert.equal(status.retrying, 1);
  assert.ok(status.oldest_pending_seconds >= 180); assert.deepEqual(await counts(), [1, 1, 1, 1, 2, 2]);
  await sqlClient`UPDATE telemetry.ml_outbox SET available_at=now() WHERE aggregate_id=${user}::uuid`;
  mode = 'terminal'; assert.equal(await worker().runOnce(50), 1);
  status = await outbox.status(); assert.equal(status.dead, 1); assert.equal(status.pending, 1);
  assert.equal(status.retry_attempts, 2); assert.deepEqual(await counts(), [1, 1, 1, 1, 2, 2]);
  const [dead] = await sqlClient`SELECT outbox_id,payload FROM telemetry.ml_outbox WHERE aggregate_id=${user}::uuid AND status='dead'`;
  assert.equal(dead!.payload.event_id, events[0]!.event_id);
  assert.equal(await outbox.replay(String(dead!.outbox_id)), true);
  mode = 'accept'; assert.equal(await worker().runOnce(50), 2);
  status = await outbox.status();
  assert.equal(status.delivered, 2); assert.equal(status.pending + status.claimed + status.dead + status.retrying, 0);
  assert.deepEqual([...durable].sort(), events.map(value => value.event_id).sort());
  assert.equal(requests, 5); assert.deepEqual(await counts(), [1, 1, 1, 1, 2, 2]);
});

test('List and Board deletion reconcile bounded SQL work, exact saves and ordered feedback atomically',{
  skip:!membershipEnabled,timeout:180_000,
},async t=>{
  Object.assign(process.env,{JWT_SECRET:'membership-batch-local-key',REDIS_URL:process.env.REDIS_DATABASE_TEST_URL??'redis://127.0.0.1:56348/15',
    SUPABASE_URL:'http://127.0.0.1:1',SUPABASE_KEY:'fixture',SUPABASE_SERVICE_ROLE_KEY:'fixture'});
  const [{default:express},{sqlClient},{default:router},{default:redis},{syncRepositoryLists}]=await Promise.all([
    import('express'),import('../../db/index.js'),import('../../routes/productV2Routes.js'),import('../../config/redis.js'),import('../../services/repositoryMembershipService.js'),
  ]);
  t.after(()=>redis.disconnect());
  const app=express();app.use(express.json());app.use('/api/v2',router);const server=app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.listening?resolve():server.once('listening',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('No membership HTTP address');
  const users:string[]=[],repos=Array.from({length:1000},()=>randomUUID()).sort();
  const fault='fixture_membership_'+randomUUID().replaceAll('-','');
  const previousDebug=sqlClient.options.debug;
  let measuring=false,statements=0,lockStarted=0;
  sqlClient.options.debug=(_connection,query)=>{if(measuring){statements++;if(!lockStarted&&query.includes('app.user_feed_state')&&query.includes('FOR UPDATE'))lockStarted=performance.now();}};
  const request=(user:string,kind:'collections'|'boards',id:string)=>fetch(`http://127.0.0.1:${address.port}/api/v2/${kind}/${id}`,{
    method:'DELETE',headers:{Authorization:`Bearer ${jwt.sign({userId:user},process.env.JWT_SECRET!,{expiresIn:'10m'})}`},
  });
  const list=async(user:string,kind:'collections'|'boards',ids:string[])=>{
    const id=randomUUID();
    if(kind==='collections'){
      await sqlClient`INSERT INTO app.board_collections(collection_id,user_id,name) VALUES(${id}::uuid,${user}::uuid,${id})`;
      if(ids.length)await sqlClient`INSERT INTO app.collection_repos(collection_id,repo_id,added_by) SELECT ${id}::uuid,unnest(${ids}::uuid[]),${user}::uuid`;
    } else {
      await sqlClient`INSERT INTO app.boards(board_id,user_id,name) VALUES(${id}::uuid,${user}::uuid,${id})`;
      if(ids.length)await sqlClient`INSERT INTO app.board_repos(board_id,repo_id,added_by) SELECT ${id}::uuid,unnest(${ids}::uuid[]),${user}::uuid`;
    }
    return id;
  };
  const owner=async(ids:string[])=>{
    const id=randomUUID();users.push(id);
    await sqlClient`INSERT INTO auth.users(id) VALUES(${id}::uuid)`;
    await sqlClient`INSERT INTO app.users(user_id,username,status) VALUES(${id}::uuid,${'deletion_'+id.replaceAll('-','')},'active')`;
    await sqlClient`INSERT INTO app.user_stats(user_id,saved_repos_count) VALUES(${id}::uuid,${ids.length})`;
    await sqlClient`INSERT INTO app.user_feed_state(user_id) VALUES(${id}::uuid)`;
    if(ids.length){
      await sqlClient`INSERT INTO app.saves(user_id,repo_id) SELECT ${id}::uuid,unnest(${ids}::uuid[])`;
      await sqlClient`UPDATE app.repo_engagement SET saves_count=saves_count+1 WHERE repo_id=ANY(${ids}::uuid[])`;
    }
    return id;
  };
  const state=async(user:string)=>(await sqlClient`SELECT s.saved_repos_count,f.feed_version,f.feedback_version,f.model_operation_version,
    (SELECT count(*) FROM app.saves WHERE user_id=${user}::uuid) AS saves,
    (SELECT count(*) FROM telemetry.interaction_events WHERE user_id=${user}::uuid) AS events,
    (SELECT count(*) FROM telemetry.ml_outbox WHERE aggregate_id=${user}::uuid) AS jobs
    FROM app.user_stats s JOIN app.user_feed_state f USING(user_id) WHERE s.user_id=${user}::uuid`)[0];
  const metrics:{kind:string;repositories:number;statements:number;milliseconds:number;lockWindowUpperBoundMs:number}[]=[];
  const publicCounts=async(ids:string[])=>
    (await sqlClient`SELECT repo_id,saves_count FROM app.repo_engagement WHERE repo_id=ANY(${ids}::uuid[]) ORDER BY repo_id`)
      .map(row=>({repo_id:String(row.repo_id),saves_count:Number(row.saves_count)}));
  try {
    const rows=repos.map((id,index)=>({repo_id:id,github_id:String(BigInt(Date.now())*10000n+BigInt(index)),name:id}));
    await sqlClient`INSERT INTO app.repos(repo_id,github_id,full_name,owner,name,url,status)
      SELECT repo_id,github_id,'fixture/'||name,'fixture',name,'https://github.com/fixture/'||name,'active'
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS input(repo_id uuid,github_id bigint,name text)`;
    await sqlClient`INSERT INTO app.repo_engagement(repo_id) SELECT unnest(${repos}::uuid[])`;
    for(const kind of ['collections','boards'] as const)for(const count of [1,100,1000]){
      const ids=repos.slice(0,count),user=await owner(ids),target=await list(user,kind,ids);
      const countersBefore=await publicCounts(ids);
      statements=0;lockStarted=0;measuring=true;const started=performance.now();let response:Response;
      try {response=await request(user,kind,target);await response.text();}finally{measuring=false;}
      const ended=performance.now();assert.equal(response.status,204);
      const row=await state(user);assert.equal(Number(row.saves),0);assert.equal(Number(row.saved_repos_count),0);
      assert.deepEqual(await publicCounts(ids),countersBefore.map(row=>({...row,saves_count:row.saves_count-1})),
        'every affected public counter changes once across all batches');
      assert.equal(String(row.feed_version),'2');assert.equal(Number(row.feedback_version),count);assert.equal(Number(row.events),count);assert.equal(Number(row.jobs),count);
      const events=await sqlClient`SELECT repo_id,event_type FROM telemetry.interaction_events WHERE user_id=${user}::uuid ORDER BY feedback_version`;
      assert.deepEqual(events.map(row=>String(row.repo_id)),ids);assert.ok(events.every(row=>row.event_type==='unsave'));
      const beforeRetry=await state(user);assert.equal((await request(user,kind,target)).status,404);assert.deepEqual(await state(user),beforeRetry);
      metrics.push({kind,repositories:count,statements,milliseconds:Math.round((ended-started)*100)/100,lockWindowUpperBoundMs:Math.round((ended-lockStarted)*100)/100});
      t.diagnostic(JSON.stringify(metrics.at(-1)));
    }
    const unchanged=await owner([repos[3]!]),redundant=await list(unchanged,'collections',[repos[3]!]);
    await list(unchanged,'boards',[repos[3]!]);const unchangedState=await state(unchanged);
    assert.equal((await request(unchanged,'collections',redundant)).status,204);assert.deepEqual(await state(unchanged),unchangedState);
    const empty=await list(unchanged,'collections',[]);
    assert.equal((await request(unchanged,'collections',empty)).status,204);assert.deepEqual(await state(unchanged),unchangedState);
    const ids=repos.slice(0,3),user=await owner(ids),target=await list(user,'collections',ids);
    const remaining=await list(user,'collections',[ids[1]!]),board=await list(user,'boards',[ids[2]!]);
    const peer=await owner([ids[0]!]),peerList=await list(peer,'collections',[ids[0]!]);
    assert.equal((await request(user,'collections',peerList)).status,404,'ownership is checked before deletion');
    assert.equal((await request(user,'collections',target)).status,204);
    let current=await state(user);assert.equal(Number(current.saves),2);assert.equal(Number(current.saved_repos_count),2);assert.equal(Number(current.events),1);
    assert.equal(Number((await sqlClient`SELECT saves_count FROM app.repo_engagement WHERE repo_id=${ids[0]}::uuid`)[0].saves_count),1,'another account retains its independent save');
    assert.equal((await request(user,'boards',board)).status,204);assert.equal((await request(user,'collections',remaining)).status,204);
    current=await state(user);assert.equal(Number(current.saves),0);assert.equal(Number(current.saved_repos_count),0);assert.equal(Number(current.events),3);
    assert.equal(Number((await state(peer)).saves),1);

    const drift=await owner(ids.slice(0,2)),driftList=await list(drift,'collections',ids.slice(0,2));await list(drift,'collections',[ids[1]!]);
    await sqlClient`DELETE FROM app.saves WHERE user_id=${drift}::uuid AND repo_id=${ids[1]}::uuid`;
    await sqlClient`UPDATE app.repo_engagement SET saves_count=saves_count-1 WHERE repo_id=${ids[1]}::uuid`;
    await sqlClient`UPDATE app.user_stats SET saved_repos_count=0 WHERE user_id=${drift}::uuid`;
    assert.equal((await request(drift,'collections',driftList)).status,204);
    current=await state(drift);assert.equal(Number(current.saves),1);assert.equal(Number(current.saved_repos_count),1,'preserve sorted sequential clamping through a remove then repair');
    assert.deepEqual((await sqlClient`SELECT event_type FROM telemetry.interaction_events WHERE user_id=${drift}::uuid ORDER BY feedback_version`).map(row=>row.event_type),['unsave','save']);

    const rollbackIds=repos.slice(0,300),rollback=await owner(rollbackIds),rollbackList=await list(rollback,'collections',rollbackIds),
      before=await state(rollback),beforeRollbackCounters=await publicCounts(rollbackIds);
    await sqlClient.unsafe(`CREATE FUNCTION telemetry.${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.aggregate_id='${rollback}'::uuid AND NEW.payload->>'event_type'='unsave' THEN
        IF EXISTS(SELECT 1 FROM app.saves WHERE user_id='${rollback}'::uuid)
          OR (SELECT saved_repos_count FROM app.user_stats WHERE user_id='${rollback}'::uuid)<>0 THEN RETURN NEW; END IF;
        RAISE EXCEPTION 'fixture_failed_after_reconciliation';
      END IF;RETURN NEW;END $$`);
    await sqlClient.unsafe(`CREATE TRIGGER ${fault} BEFORE INSERT ON telemetry.ml_outbox FOR EACH ROW EXECUTE FUNCTION telemetry.${fault}()`);
    assert.equal((await request(rollback,'collections',rollbackList)).status,500);assert.deepEqual(await state(rollback),before);
    assert.deepEqual(await publicCounts(rollbackIds),beforeRollbackCounters,'rollback restores every public counter across batches');
    assert.equal(Number((await sqlClient`SELECT count(*) FROM app.collection_repos WHERE collection_id=${rollbackList}::uuid`)[0].count),rollbackIds.length);
    await sqlClient.unsafe(`DROP TRIGGER ${fault} ON telemetry.ml_outbox`);await sqlClient.unsafe(`DROP FUNCTION telemetry.${fault}()`);
    assert.equal((await request(rollback,'collections',rollbackList)).status,204);assert.equal(Number((await state(rollback)).events),rollbackIds.length);

    const racing=await owner(ids.slice(0,2)),old=await list(racing,'collections',ids.slice(0,2)),next=await list(racing,'collections',[]);
    const gate=await sqlClient.reserve();let locked=false;const pending:Promise<unknown>[]=[];
    try {
      await gate`BEGIN`;locked=true;await gate`SELECT user_id FROM app.user_feed_state WHERE user_id=${racing}::uuid FOR UPDATE`;
      const blocked=async(count:number)=>{
        const deadline=performance.now()+5000;
        while(Number((await sqlClient`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='active'
          AND wait_event_type='Lock' AND query ILIKE '%FROM app.user_feed_state%FOR UPDATE%'`)[0].count)<count){
          if(performance.now()>deadline)throw new Error('Membership requests did not contend on the feed lock');await new Promise(resolve=>setTimeout(resolve,10));
        }
      };
      const deleting=request(racing,'collections',old);pending.push(deleting);await blocked(1);
      const saving=syncRepositoryLists(racing,ids[0]!,[next],[],{event_id:randomUUID(),schema_version:2,session_id:randomUUID(),serve_id:null,
        repo_id:ids[0]!,position:null,event_type:'save',dwell_ms:null,client_occurred_at:new Date().toISOString(),context:{}});
      pending.push(saving);await blocked(2);await gate`ROLLBACK`;locked=false;
      assert.equal((await deleting).status,204);assert.equal((await saving).saved,true);
      current=await state(racing);assert.equal(Number(current.saves),1);assert.equal(Number(current.saved_repos_count),1);assert.equal(Number(current.feedback_version),3);
    } finally {if(locked)await gate`ROLLBACK`;gate.release();await Promise.allSettled(pending);}

    // With a missing row in the second large batch, the short deletion used to
    // insert that row then wait on the first row, while the long deletion took
    // the first row then waited for that insert. Force both lock waits before
    // release; distinct owners deliberately bypass per-user serialization.
    const shared=repos.slice(0,257),shortIds=[shared[0]!,shared[256]!];
    const longOwner=await owner(shared),shortOwner=await owner(shortIds);
    const longList=await list(longOwner,'collections',shared),shortList=await list(shortOwner,'boards',shortIds);
    await sqlClient`DELETE FROM app.repo_engagement WHERE repo_id=${shared[256]}::uuid`;
    const counterGate=await sqlClient.reserve();let counterLocked=false;const deletions:Promise<Response>[]=[];
    try{
      await counterGate`BEGIN`;counterLocked=true;
      await counterGate`SELECT repo_id FROM app.repo_engagement WHERE repo_id=${shared[0]}::uuid FOR UPDATE`;
      const waitForCounters=async(count:number)=>{
        const deadline=performance.now()+5000;
        while(Number((await sqlClient`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='active'
          AND wait_event_type='Lock' AND query ILIKE '%app.repo_engagement%'`)[0].count)<count){
          assert.ok(performance.now()<deadline,'both cross-user deletions must reach the engagement lock barrier');
          await new Promise(resolve=>setTimeout(resolve,5));
        }
      };
      deletions.push(request(longOwner,'collections',longList));await waitForCounters(1);
      deletions.push(request(shortOwner,'boards',shortList));await waitForCounters(2);
      await counterGate`ROLLBACK`;counterLocked=false;
      for(const response of await Promise.all(deletions))assert.equal(response.status,204,await response.text());
      for(const id of [longOwner,shortOwner]){
        const stateAfter=await state(id);assert.equal(Number(stateAfter.saves),0);assert.equal(Number(stateAfter.saved_repos_count),0);
      }
    }finally{
      if(counterLocked)await counterGate`ROLLBACK`;counterGate.release();await Promise.allSettled(deletions);
    }

    const ordered=await owner(ids),orderedList=await list(ordered,'collections',ids);
    await sqlClient`UPDATE app.user_feed_state SET model_policy_sha256=${'a'.repeat(64)},model_initialized=true,
      model_policy_limits=${JSON.stringify({input_bytes:131072,max_sessions:2,generation_freshness_ms:10000,idle_expiry_ms:60000})}::jsonb WHERE user_id=${ordered}::uuid`;
    assert.equal((await request(ordered,'collections',orderedList)).status,204);
    const operations=await sqlClient`SELECT operation_json FROM telemetry.ml_outbox WHERE aggregate_id=${ordered}::uuid ORDER BY model_operation_version`;
    assert.deepEqual(operations.map(row=>JSON.parse(JSON.parse(String(row.operation_json)).operation.original_feedback_json).repo_id),ids);
    assert.equal(Number((await state(ordered)).model_operation_version),3);
    assert.ok(metrics.every(row=>row.statements<70),'SQL round trips must be bounded by batches, not repository count');
  } finally {
    measuring=false;sqlClient.options.debug=previousDebug;
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await sqlClient.unsafe(`DROP TRIGGER IF EXISTS ${fault} ON telemetry.ml_outbox`);await sqlClient.unsafe(`DROP FUNCTION IF EXISTS telemetry.${fault}()`);
    await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=ANY(${users}::uuid[])`;
    await sqlClient`DELETE FROM telemetry.interaction_events WHERE user_id=ANY(${users}::uuid[])`;
    await sqlClient`DELETE FROM app.users WHERE user_id=ANY(${users}::uuid[])`;await sqlClient`DELETE FROM auth.users WHERE id=ANY(${users}::uuid[])`;
    await sqlClient`DELETE FROM app.repos WHERE repo_id=ANY(${repos}::uuid[])`;
  }
});
