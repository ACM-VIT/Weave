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

test('accepted HTTP interactions survive process death, ML outages and replay without duplicate counters', {
  skip: !enabled, timeout: 30_000,
}, async t => {
  const [{ sqlClient }, { OutboxService }, { OutboxWorker }, { MlV2Client }] = await Promise.all([
    import('../../db/index.js'), import('../../services/outboxService.js'),
    import('../../workers/outboxWorker.js'), import('../../services/mlService.js'),
  ]);
  const user = randomUUID(); const repo = randomUUID(); const board = randomUUID();
  const serve = randomUUID(); const session = randomUUID();
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../fixtures/activityApiProcess.ts', import.meta.url))], {
    env: { ...process.env, JWT_SECRET: 'local-activity-reliability-key', DB_SCHEMA_V2_WRITES: 'true' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let mlServer: Server | undefined;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    if (mlServer) await new Promise<void>(resolve => { mlServer!.closeAllConnections(); mlServer!.close(() => resolve()); });
    try {
      await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${user}::uuid`;
      await sqlClient`DELETE FROM app.users WHERE user_id=${user}::uuid`;
      await sqlClient`DELETE FROM auth.users WHERE id=${user}::uuid`;
      await sqlClient`DELETE FROM app.repos WHERE repo_id=${repo}::uuid`;
    } finally { await sqlClient.end({ timeout: 1 }); }
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
  const timingOut = new OutboxWorker(new OutboxService(), new MlV2Client({ ...options, deliveryTimeoutMs: 100 })).runOnce(50);
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
