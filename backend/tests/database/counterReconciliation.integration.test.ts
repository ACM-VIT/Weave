import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import postgres from 'postgres';
import { sqlClient } from '../../db/index.js';
import { DataReconciliationService } from '../../services/dataReconciliationService.js';
import { processInteractionBatchV2InTransaction } from '../../services/activityV2Service.js';
import { assertDisposableDatabase } from './disposableDatabase.js';

const enabled = process.env.RUN_RECONCILIATION_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();
const integration = enabled ? test : test.skip;
const users: string[] = [];
const repos: string[] = [];
let fixturePrefix = randomUUID().slice(0, 24);
const id = (index: number) => `${fixturePrefix}${index.toString().padStart(12, '0')}`;

test.beforeEach(async () => {
  if (!enabled) return;
  const [existing] = await sqlClient`SELECT
    (SELECT count(*) FROM app.users)+(SELECT count(*) FROM app.repos) AS count`;
  assert.equal(Number(existing.count), 0, 'Run alone in an otherwise empty disposable database.');
  fixturePrefix = randomUUID().slice(0, 24);
  await resetProgress();
});
test.afterEach(async () => {
  if (!enabled) return;
  await sqlClient.begin(async tx => {
    await tx`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=ANY(${users}::uuid[])`;
    await tx`DELETE FROM app.users WHERE user_id=ANY(${users}::uuid[])`;
    await tx`DELETE FROM auth.users WHERE id=ANY(${users}::uuid[])`;
    await tx`DELETE FROM app.repos WHERE repo_id=ANY(${repos}::uuid[])`;
  });
  users.length = repos.length = 0;
  await resetProgress();
});
test.after(async () => { if (enabled) await sqlClient.end({ timeout: 1 }); });

async function resetProgress() {
  await sqlClient`UPDATE telemetry.counter_reconciliation_progress
    SET last_id=NULL,upper_id=NULL,completed_sweeps=0`;
}

async function fixture(count = 5) {
  users.push(...Array.from({ length: count }, (_, n) => id(n + 100)));
  repos.push(...Array.from({ length: count }, (_, n) => id(n + 1000)));
  await sqlClient`INSERT INTO auth.users(id) SELECT unnest(${users}::uuid[])`;
  await sqlClient`INSERT INTO app.users(user_id,username,status)
    SELECT u,'reconcile_' || replace(u::text,'-',''),'active' FROM unnest(${users}::uuid[]) u`;
  await sqlClient`INSERT INTO app.user_stats(user_id) SELECT unnest(${users}::uuid[])`;
  await sqlClient`INSERT INTO app.user_feed_state(user_id) SELECT unnest(${users}::uuid[])`;
  await sqlClient`INSERT INTO app.repos(repo_id,github_id,owner,full_name,name,url,status)
    SELECT r,n,'reconcile','reconcile/' || n,'repo' || n,'https://github.com/reconcile/' || n,'active'
    FROM unnest(${repos}::uuid[]) WITH ORDINALITY input(r,n)`;
  await sqlClient`INSERT INTO app.repo_engagement(repo_id) SELECT unnest(${repos}::uuid[])`;
}

async function drain(batchSize = 2) {
  const results = [];
  for (let n = 0; n < 100; n++) {
    // Deliberately recreate the service each time: the database owns progress.
    const result = await new DataReconciliationService(sqlClient, batchSize).reconcileCounters();
    results.push(result);
    if (!result.hasMore) return results;
  }
  throw new Error('Reconciliation did not finish a sweep.');
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

async function waitFor(check: () => Promise<boolean>) {
  const deadline = performance.now() + 2000;
  while (!await check()) {
    assert.ok(performance.now() < deadline, 'Timed out waiting for the database synchronization point.');
    await delay(5);
  }
}

integration('bounded batches resume after restart, repair all aggregates and leave correct rows untouched', async () => {
  await fixture();
  await sqlClient`INSERT INTO app.reactions(user_id,repo_id,reaction) VALUES
    (${users[0]}::uuid,${repos[0]}::uuid,'like'),(${users[1]}::uuid,${repos[0]}::uuid,'dislike')`;
  await sqlClient`INSERT INTO app.saves(user_id,repo_id) VALUES (${users[0]}::uuid,${repos[0]}::uuid)`;
  await sqlClient`INSERT INTO app.comments(user_id,repo_id,body) VALUES (${users[0]}::uuid,${repos[0]}::uuid,'test')`;
  await sqlClient`INSERT INTO telemetry.user_repo_engagement(user_id,repo_id,impressions)
    VALUES (${users[0]}::uuid,${repos[0]}::uuid,3),(${users[1]}::uuid,${repos[0]}::uuid,4)`;
  await sqlClient`UPDATE app.repo_engagement SET likes_count=9,updated_at='2000-01-01T00:00:00Z' WHERE repo_id=${repos[4]}::uuid`;
  await sqlClient`UPDATE app.user_stats SET following_count=7,followers_count=8,updated_at='2000-01-01T00:00:00Z'`;
  await sqlClient`UPDATE app.repo_engagement SET updated_at='2000-01-01T00:00:00Z' WHERE repo_id=${repos[1]}::uuid`;

  const first = await new DataReconciliationService(sqlClient, 2).reconcileCounters();
  assert.equal(first.repositories.scanned, 2);
  assert.equal(first.repositories.updated, 1);
  assert.equal(first.hasMore, true);
  const [cursor] = await sqlClient`SELECT last_id,upper_id FROM telemetry.counter_reconciliation_progress WHERE scope='repositories'`;
  assert.deepEqual([cursor.last_id,cursor.upper_id], [repos[1],repos[4]]);
  const batches = await drain();
  assert.ok(batches.every(batch => batch.repositories.scanned <= 2 && batch.users.scanned <= 2));
  assert.equal(batches.reduce((n, batch) => n + batch.repositories.scanned, 0), 3);
  const [counts] = await sqlClient`SELECT * FROM app.repo_engagement WHERE repo_id=${repos[0]}::uuid`;
  assert.deepEqual([counts.likes_count,counts.dislikes_count,counts.saves_count,counts.comments_count,Number(counts.views_count)], [1,1,1,1,7]);
  assert.equal((await sqlClient`SELECT likes_count FROM app.repo_engagement WHERE repo_id=${repos[4]}::uuid`)[0].likes_count, 0);
  const stats = await sqlClient`SELECT * FROM app.user_stats ORDER BY user_id`;
  assert.deepEqual([stats[0].likes_given_count,stats[0].saved_repos_count], [1,1]);
  assert.ok(stats.every(row => row.following_count === 7 && row.followers_count === 8));
  assert.equal(new Date(stats[1].updated_at).toISOString(), '2000-01-01T00:00:00.000Z');
  assert.equal(new Date((await sqlClient`SELECT updated_at FROM app.repo_engagement WHERE repo_id=${repos[1]}::uuid`)[0].updated_at).toISOString(), '2000-01-01T00:00:00.000Z');
  assert.ok((await drain()).every(batch => batch.repositories.updated === 0 && batch.users.updated === 0));
});

integration('a later bounded audit catches drift behind the cursor and newly inserted lower IDs without dirty markers', async () => {
  await fixture();
  await new DataReconciliationService(sqlClient, 2).reconcileCounters();
  await sqlClient`UPDATE app.repo_engagement SET saves_count=5 WHERE repo_id=${repos[0]}::uuid`;
  const lower = id(999); repos.push(lower);
  await sqlClient`INSERT INTO app.repos(repo_id,github_id,owner,full_name,name,url,status)
    VALUES (${lower}::uuid,999,'reconcile','reconcile/lower','lower','https://github.com/reconcile/lower','active')`;
  await sqlClient`INSERT INTO app.repo_engagement(repo_id,views_count) VALUES (${lower}::uuid,9)`;
  const higher = id(2000); repos.push(higher);
  await sqlClient`INSERT INTO app.repos(repo_id,github_id,owner,full_name,name,url,status)
    VALUES (${higher}::uuid,2000,'reconcile','reconcile/higher','higher','https://github.com/reconcile/higher','active')`;
  await sqlClient`INSERT INTO app.repo_engagement(repo_id,views_count) VALUES (${higher}::uuid,9)`;
  await drain();
  assert.equal((await sqlClient`SELECT saves_count FROM app.repo_engagement WHERE repo_id=${repos[0]}::uuid`)[0].saves_count, 5);
  assert.equal(Number((await sqlClient`SELECT views_count FROM app.repo_engagement WHERE repo_id=${higher}::uuid`)[0].views_count), 9);
  await drain();
  assert.equal((await sqlClient`SELECT saves_count FROM app.repo_engagement WHERE repo_id=${repos[0]}::uuid`)[0].saves_count, 0);
  assert.equal(Number((await sqlClient`SELECT views_count FROM app.repo_engagement WHERE repo_id=${lower}::uuid`)[0].views_count), 0);
  assert.equal(Number((await sqlClient`SELECT views_count FROM app.repo_engagement WHERE repo_id=${higher}::uuid`)[0].views_count), 0);
});

integration('different scope sizes finish one shared sweep without restarting the smaller scope', async () => {
  await fixture();
  await sqlClient`DELETE FROM app.users WHERE user_id=ANY(${users.slice(3)}::uuid[])`;
  const first = await new DataReconciliationService(sqlClient, 2).reconcileCounters();
  const second = await new DataReconciliationService(sqlClient, 2).reconcileCounters();
  const third = await new DataReconciliationService(sqlClient, 2).reconcileCounters();
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, true);
  assert.equal(second.users.sweepComplete, true);
  assert.equal(third.hasMore, false);
  assert.equal(third.users.scanned, 0);
  const progress = await sqlClient`SELECT completed_sweeps FROM telemetry.counter_reconciliation_progress`;
  assert.ok(progress.every(row => Number(row.completed_sweeps) === 1));
});

integration('foreground interaction locks are skipped without losing committed increments or scanning beyond the batch', async t => {
  await fixture();
  const ready = gate(); const release = gate();
  const writer = sqlClient.begin(async tx => {
    await processInteractionBatchV2InTransaction(tx, users[0], [{
      event_id: randomUUID(),schema_version: 2,session_id: randomUUID(),serve_id: null,
      repo_id: repos[0],position: null,event_type: 'like',dwell_ms: null,
      client_occurred_at: new Date().toISOString(),context: {},
    }]);
    ready.open(); await release.promise;
  });
  // postgres.js transactions are lazy until awaited / then is attached.
  const running = Promise.resolve(writer);
  try {
    await Promise.race([ready.promise,running]);
    const started = performance.now();
    const result = await new DataReconciliationService(sqlClient, 1).reconcileCounters();
    t.diagnostic(`Locked foreground row: reconciliation returned in ${(performance.now()-started).toFixed(1)} ms without waiting.`);
    assert.equal(result.repositories.scanned, 1);
    assert.equal(result.repositories.skipped, 1);
    assert.equal(result.users.skipped, 1);
    assert.equal(result.hasMore, true);
  } finally { release.open(); await running; }
  assert.equal((await sqlClient`SELECT likes_count FROM app.repo_engagement WHERE repo_id=${repos[0]}::uuid`)[0].likes_count, 1);
  await drain(1);
  assert.equal((await sqlClient`SELECT likes_given_count FROM app.user_stats WHERE user_id=${users[0]}::uuid`)[0].likes_given_count, 1);
});

integration('a writer arriving after counter locks keeps its increment after repair commits', async () => {
  await fixture();
  await sqlClient`UPDATE app.repo_engagement SET likes_count=8 WHERE repo_id=${repos[0]}::uuid`;
  const blocker = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  const ready = gate(); const release = gate();
  const holding = Promise.resolve(blocker.begin(async tx => {
    await tx`LOCK TABLE app.saves IN ACCESS EXCLUSIVE MODE`;
    ready.open(); await release.promise;
  }));
  let repair: Promise<unknown> | undefined;
  let write: Promise<unknown> | undefined;
  try {
    await Promise.race([ready.promise,holding]);
    repair = Promise.resolve(new DataReconciliationService(sqlClient, 1).reconcileCounters());
    await waitFor(async () => (await sqlClient`SELECT 1 FROM pg_stat_activity
      WHERE wait_event_type='Lock' AND query LIKE '%WITH reactions AS (%'`).length > 0);
    write = Promise.resolve(sqlClient.begin(async tx => {
      await processInteractionBatchV2InTransaction(tx, users[0], [{
        event_id: randomUUID(),schema_version: 2,session_id: randomUUID(),serve_id: null,
        repo_id: repos[0],position: null,event_type: 'like',dwell_ms: null,
        client_occurred_at: new Date().toISOString(),context: {},
      }]);
    }));
    await waitFor(async () => (await sqlClient`SELECT 1 FROM pg_stat_activity
      WHERE wait_event_type='Lock' AND query LIKE '%FOR UPDATE%' AND query LIKE '%app.repo_engagement%'`).length > 0);
  } finally {
    release.open(); await holding;
    await Promise.all([repair,write]); await blocker.end();
  }
  assert.equal((await sqlClient`SELECT likes_count FROM app.repo_engagement WHERE repo_id=${repos[0]}::uuid`)[0].likes_count, 1);
});

integration('failed checkpoint writes roll back repairs and restarting retries the same range', async () => {
  await fixture();
  await sqlClient`UPDATE app.repo_engagement SET likes_count=9`;
  await sqlClient`UPDATE telemetry.counter_reconciliation_progress SET completed_sweeps=9223372036854775807`;
  await assert.rejects(new DataReconciliationService(sqlClient, 10).reconcileCounters(), { code: '22003' });
  assert.equal((await sqlClient`SELECT likes_count FROM app.repo_engagement ORDER BY repo_id LIMIT 1`)[0].likes_count, 9);
  assert.equal((await sqlClient`SELECT last_id FROM telemetry.counter_reconciliation_progress WHERE scope='repositories'`)[0].last_id, null);
  await sqlClient`UPDATE telemetry.counter_reconciliation_progress SET completed_sweeps=0`;
  assert.equal((await new DataReconciliationService(sqlClient, 10).reconcileCounters()).repositories.updated, 5);
});

integration('another maintenance owner is skipped and an empty audit completes', async () => {
  const ready = gate(); const release = gate();
  const holding = Promise.resolve(sqlClient.begin(async tx => {
    await tx`SELECT scope FROM telemetry.counter_reconciliation_progress FOR UPDATE`;
    ready.open(); await release.promise;
  }));
  try {
    await Promise.race([ready.promise,holding]);
    const result = await new DataReconciliationService().reconcileCounters();
    assert.equal(result.hasMore, true);
    assert.equal(result.repositories.busy, true);
    assert.equal(result.users.busy, true);
  } finally { release.open(); await holding; }
  const result = await new DataReconciliationService().reconcileCounters();
  assert.equal(result.hasMore, false);
  assert.equal(result.repositories.scanned, 0);
  assert.equal(result.users.scanned, 0);
});

integration('lock timeouts roll back the batch and transaction-local settings do not leak into pooled sessions', async () => {
  await fixture();
  const client = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  const originalStatement = (await client`SHOW statement_timeout`)[0].statement_timeout;
  const originalLock = (await client`SHOW lock_timeout`)[0].lock_timeout;
  const ready = gate(); const release = gate();
  const holding = Promise.resolve(sqlClient.begin(async tx => {
    await tx`LOCK TABLE app.saves IN ACCESS EXCLUSIVE MODE`;
    ready.open(); await release.promise;
  }));
  try {
    await Promise.race([ready.promise,holding]);
    await assert.rejects(new DataReconciliationService(client, 1).reconcileCounters(), { code: '55P03' });
    const [progress] = await sqlClient`SELECT last_id,upper_id,completed_sweeps
      FROM telemetry.counter_reconciliation_progress WHERE scope='repositories'`;
    assert.deepEqual([progress.last_id,progress.upper_id,Number(progress.completed_sweeps)], [null,null,0]);
    assert.equal((await client`SHOW statement_timeout`)[0].statement_timeout, originalStatement);
    assert.equal((await client`SHOW lock_timeout`)[0].lock_timeout, originalLock);
  } finally { release.open(); await holding; await client.end(); }
  await drain();
});

integration('unchanged data avoids whole-table rewrites: report touched rows, WAL and bounded batch duration', async t => {
  await fixture(600);
  const wal = async () => String((await sqlClient`SELECT pg_current_wal_insert_lsn() AS lsn`)[0].lsn);
  const bytesSince = async (lsn: string) => Number((await sqlClient`SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),${lsn}::pg_lsn) AS bytes`)[0].bytes);
  // Original maintenance statements, on the same isolated, already-correct data.
  const before = await wal();
  const start = performance.now();
  const rewritten = await sqlClient.begin(async tx => {
    const repositories = await tx`UPDATE app.repo_engagement e SET
      likes_count=(SELECT count(*) FROM app.reactions WHERE repo_id=e.repo_id AND reaction='like'),
      dislikes_count=(SELECT count(*) FROM app.reactions WHERE repo_id=e.repo_id AND reaction='dislike'),
      saves_count=(SELECT count(*) FROM app.saves WHERE repo_id=e.repo_id),
      comments_count=(SELECT count(*) FROM app.comments WHERE repo_id=e.repo_id),
      views_count=(SELECT COALESCE(sum(impressions),0) FROM telemetry.user_repo_engagement WHERE repo_id=e.repo_id),updated_at=now()
      RETURNING repo_id`;
    const userRows = await tx`UPDATE app.user_stats s SET
      likes_given_count=(SELECT count(*) FROM app.reactions WHERE user_id=s.user_id AND reaction='like'),
      saved_repos_count=(SELECT count(*) FROM app.saves WHERE user_id=s.user_id),updated_at=now() RETURNING user_id`;
    return repositories.length + userRows.length;
  });
  const baselineMs = performance.now()-start; const baselineWal = await bytesSince(before);
  const boundedBefore = await wal(); const boundedStart = performance.now();
  const durations: number[] = []; let updated = 0; let scanned = 0;
  for (let n = 0; n < 20; n++) {
    const started = performance.now();
    const result = await new DataReconciliationService(sqlClient, 64).reconcileCounters();
    durations.push(performance.now()-started);
    assert.ok(result.repositories.scanned <= 64 && result.users.scanned <= 64);
    updated += result.repositories.updated + result.users.updated;
    scanned += result.repositories.scanned + result.users.scanned;
    if (!result.hasMore) break;
  }
  const boundedMs = performance.now()-boundedStart; const boundedWal = await bytesSince(boundedBefore);
  assert.equal(updated, 0); assert.equal(scanned, 1200); assert.equal(rewritten, 1200);
  t.diagnostic(JSON.stringify({ fixtureRows: 1200,baseline: { updated: rewritten,walBytes: baselineWal,transactionMs: baselineMs },
    bounded: { updated,walBytes: boundedWal,sweepMs: boundedMs,maxTwoTransactionBatchMs: Math.max(...durations),batches: durations.length } }));
});
