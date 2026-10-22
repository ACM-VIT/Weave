import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import postgres from 'postgres';
import { sqlClient } from '../../db/index.js';
import { OutboxService } from '../../services/outboxService.js';
import { OutboxWorker } from '../../workers/outboxWorker.js';
import { FeedPrewarmService } from '../../services/feedPrewarmService.js';
import { FeedPrewarmWorker } from '../../workers/feedPrewarmWorker.js';
import { WorkerSupervisor } from '../../runtime/workerSupervisor.js';
import { WorkerWakeups } from '../../runtime/workerWakeups.js';
import { assertDisposableDatabase } from './disposableDatabase.js';

const enabled = process.env.RUN_OUTBOX_WAKEUPS_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();
const integration = enabled ? test : test.skip;
const users: string[] = [];
const jobs: string[] = [];
test.afterEach(async () => {
  if (!enabled) return;
  await sqlClient`DELETE FROM telemetry.ml_outbox WHERE outbox_id=ANY(${jobs}::uuid[])`;
  await sqlClient`DELETE FROM app.users WHERE user_id=ANY(${users}::uuid[])`;
  await sqlClient`DELETE FROM auth.users WHERE id=ANY(${users}::uuid[])`;
  users.length = jobs.length = 0;
});
test.after(async () => { if (enabled) await sqlClient.end({ timeout: 1 }); });

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise,open };
}
async function until(condition: () => Promise<boolean>, timeout = 5000) {
  const deadline = performance.now()+timeout;
  while (!await condition()) {
    assert.ok(performance.now()<deadline, 'Timed out waiting for durable work/notification.');
    await delay(5);
  }
}
async function user() {
  const id = randomUUID(); users.push(id);
  await sqlClient`INSERT INTO auth.users(id) VALUES (${id}::uuid)`;
  await sqlClient`INSERT INTO app.users(user_id,username,status,profile_version) VALUES (${id}::uuid,${'wake_'+id.replaceAll('-','')},'active',2)`;
  await sqlClient`INSERT INTO app.user_feed_state(user_id) VALUES (${id}::uuid)`;
  return id;
}
function newJob() { const id = randomUUID(); jobs.push(id); return id; }
async function onboard(userId: string, status = 'pending', profileVersion = 2) {
  const id = newJob();
  await sqlClient`INSERT INTO telemetry.ml_outbox(outbox_id,job_type,aggregate_id,idempotency_key,payload,status)
    VALUES (${id}::uuid,'onboard',${userId}::uuid,${'wake:'+id},${JSON.stringify({ job_id: id,user_id: userId,profile_version: profileVersion,profile: { interests: ['typescript'] } })}::jsonb,${status})`;
  return id;
}
async function deliver(userId: string) {
  const id = await onboard(userId);
  await sqlClient`UPDATE telemetry.ml_outbox SET status='delivered' WHERE outbox_id=${id}::uuid`;
  return id;
}

integration('outbox wakeups are commit-only, payload-free and rollback creates no actionable work', async () => {
  const listener = postgres(process.env.DATABASE_URL!, { max: 1,prepare: false });
  const received: string[] = [];
  let subscription: Awaited<ReturnType<typeof listener.listen>> | undefined;
  try {
    subscription = await listener.listen('weave_ml_outbox', value => { received.push(value); });
    const id = newJob(); const userId = await user();
    await assert.rejects(sqlClient.begin(async tx => {
      await tx`INSERT INTO telemetry.ml_outbox(outbox_id,job_type,aggregate_id,idempotency_key,payload)
        VALUES (${id}::uuid,'onboard',${userId}::uuid,${id},'{}'::jsonb)`;
      throw new Error('rollback');
    }), /rollback/);
    // Same-channel barrier follows the aborted transaction; no arbitrary sleep
    // is used to infer absence of an earlier notification.
    await sqlClient.notify('weave_ml_outbox', 'barrier');
    await until(async () => received.includes('barrier'));
    assert.deepEqual(received, ['barrier']);
    assert.equal((await sqlClient`SELECT 1 FROM telemetry.ml_outbox WHERE outbox_id=${id}::uuid`).length, 0);
    const ready = gate(); const release = gate();
    const committed = Promise.resolve(sqlClient.begin(async tx => {
      await tx`INSERT INTO telemetry.ml_outbox(outbox_id,job_type,aggregate_id,idempotency_key,payload)
        VALUES (${id}::uuid,'onboard',${userId}::uuid,${id},'{}'::jsonb)`;
      ready.open(); await release.promise;
    }));
    try {
      await Promise.race([ready.promise,committed]);
      assert.deepEqual(received, ['barrier']);
    } finally { release.open(); await committed; }
    await until(async () => received.includes(''));
    assert.deepEqual(received, ['barrier','']);
  } finally {
    try { await subscription?.unlisten(); }
    finally { await listener.end({ timeout: 1 }); }
  }
});

integration('delivery atomically coalesces durable prewarm by user/version and rollback preserves delivery state', async () => {
  const userId = await user(); const outboxId = await onboard(userId);
  await assert.rejects(sqlClient.begin(async tx => {
    await tx`SET LOCAL ROLE ghsocial_backend`;
    await tx`UPDATE telemetry.ml_outbox SET status='delivered' WHERE outbox_id=${outboxId}::uuid`;
    assert.equal((await tx`SELECT 1 FROM telemetry.feed_prewarm_jobs WHERE user_id=${userId}::uuid`).length, 1);
    throw new Error('rollback');
  }), /rollback/);
  assert.equal((await sqlClient`SELECT 1 FROM telemetry.feed_prewarm_jobs WHERE user_id=${userId}::uuid`).length, 0);
  assert.equal((await sqlClient`SELECT status FROM telemetry.ml_outbox WHERE outbox_id=${outboxId}::uuid`)[0].status, 'pending');
  await sqlClient`UPDATE telemetry.ml_outbox SET status='delivered' WHERE outbox_id=${outboxId}::uuid`;
  const queue = new FeedPrewarmService(); const first = (await queue.claim())!;
  const leaseDelay = (await queue.nextRunInMs())!;
  assert.ok(leaseDelay > 0 && leaseDelay <= 60_000, 'claimed jobs report their lease expiry');
  await queue.finish(first, { status: 'generated',feedVersion: 1n,count: 0 });
  await deliver(userId);
  assert.equal(await queue.claim(), null, 'repeat delivery must not redo a completed user/version');
  await sqlClient`UPDATE app.user_feed_state SET feed_version=2 WHERE user_id=${userId}::uuid`;
  await deliver(userId);
  const next = (await new FeedPrewarmService().claim())!;
  assert.equal(next.feedVersion, 2n);
  assert.notEqual(next.claimToken, first.claimToken);
  await queue.finish(first, { status: 'generated',feedVersion: 1n,count: 0 });
  assert.equal((await sqlClient`SELECT status FROM telemetry.feed_prewarm_jobs WHERE user_id=${userId}::uuid`)[0].status, 'claimed');
  await sqlClient`UPDATE app.users SET profile_version=3 WHERE user_id=${userId}::uuid`;
  await queue.finish(next, { status: 'generated',feedVersion: 2n,count: 0 });
  assert.equal((await sqlClient`SELECT status FROM telemetry.feed_prewarm_jobs WHERE user_id=${userId}::uuid`)[0].status, 'pending');
  assert.equal(await queue.claim(), null, 'wait for the newest ML profile delivery before retrying');
  const newer = await onboard(userId, 'pending', 3);
  await sqlClient`UPDATE telemetry.ml_outbox SET status='delivered' WHERE outbox_id=${newer}::uuid`;
  const profileJob = (await queue.claim())!;
  assert.equal(profileJob.profileVersion, 3n, 'a new ML profile must prewarm even at the same feed version');
  await deliver(userId); // An older version cannot take over the new claim.
  await queue.finish(next, { status: 'generated',feedVersion: 2n,count: 0 });
  assert.equal((await sqlClient`SELECT claim_token FROM telemetry.feed_prewarm_jobs WHERE user_id=${userId}::uuid`)[0].claim_token, profileJob.claimToken);
  await sqlClient`UPDATE app.user_feed_state SET feed_version=4 WHERE user_id=${userId}::uuid`;
  await queue.finish(profileJob, { status: 'generated',feedVersion: 2n,count: 0 });
  await sqlClient`UPDATE telemetry.feed_prewarm_jobs SET available_at=now() WHERE user_id=${userId}::uuid`;
  const latest = (await queue.claim())!;
  assert.equal(latest.feedVersion, 4n, 'an invalidated generation retries with the current feed version');
  await queue.finish(latest, { status: 'generated',feedVersion: 4n,count: 0 });
});

integration('restarts recover expired claims, adopt current versions, retry failures and ignore disabled/deleted users', async () => {
  const userId = await user(); await deliver(userId);
  const queue = new FeedPrewarmService(); const first = (await queue.claim())!;
  assert.equal(await new FeedPrewarmService().claim(), null);
  await sqlClient`UPDATE telemetry.feed_prewarm_jobs SET claimed_at=now()-interval '2 minutes' WHERE user_id=${userId}::uuid`;
  assert.equal(await queue.nextRunInMs(), 0);
  await sqlClient`UPDATE app.user_feed_state SET feed_version=3 WHERE user_id=${userId}::uuid`;
  const recovered = (await new FeedPrewarmService().claim())!;
  assert.notEqual(recovered.claimToken, first.claimToken);
  assert.equal(recovered.feedVersion, 3n);
  await queue.retry(first);
  assert.equal((await sqlClient`SELECT status FROM telemetry.feed_prewarm_jobs WHERE user_id=${userId}::uuid`)[0].status, 'claimed');
  await queue.retry(recovered);
  assert.equal(await queue.claim(), null, 'retry backoff must be observed');
  await sqlClient`UPDATE telemetry.feed_prewarm_jobs SET available_at=now() WHERE user_id=${userId}::uuid`;
  const retry = (await queue.claim())!;
  await queue.finish(retry, { status: 'coalesced',feedVersion: 3n });
  assert.equal((await sqlClient`SELECT status FROM telemetry.feed_prewarm_jobs WHERE user_id=${userId}::uuid`)[0].status, 'pending');
  await sqlClient`UPDATE app.users SET status='deleted' WHERE user_id=${userId}::uuid`;
  await sqlClient`UPDATE telemetry.feed_prewarm_jobs SET available_at=now() WHERE user_id=${userId}::uuid`;
  assert.equal(await queue.claim(), null);
  assert.equal(await queue.nextRunInMs(), undefined, 'disabled users must not schedule busy retries');
  await sqlClient`DELETE FROM app.users WHERE user_id=${userId}::uuid`;
  assert.equal((await sqlClient`SELECT 1 FROM telemetry.feed_prewarm_jobs WHERE user_id=${userId}::uuid`).length, 0);
});

integration('delayed or failed prewarm cannot hold up unrelated outbox delivery', async t => {
  const userId = await user(); await deliver(userId);
  const began = gate(); const release = gate();
  const prewarm = new FeedPrewarmWorker(new FeedPrewarmService(), { generate: async () => {
    began.open(); await release.promise; throw new Error('ML unavailable');
  } });
  const generating = prewarm.runOnce();
  try {
    await Promise.race([began.promise,generating]);
    const id = await onboard(userId);
    const started = performance.now();
    const worker = new OutboxWorker(new OutboxService(), {
      deliverOnboarding: async () => ({ accepted: true,retryable: false,status_code: 200 }),
      deliverFeedback: async () => { throw new Error('unexpected'); },
      deliverRepositoryIndex: async () => { throw new Error('unexpected'); },
      deliverRepositoryRefresh: async () => { throw new Error('unexpected'); },
    });
    assert.equal(await worker.runOnce(), 1);
    assert.equal((await sqlClient`SELECT status FROM telemetry.ml_outbox WHERE outbox_id=${id}::uuid`)[0].status, 'delivered');
    t.diagnostic(`Delivery completed in ${(performance.now()-started).toFixed(1)} ms while prewarm remained paused; no prewarm hook in the delivery lane.`);
  } finally { release.open(); await generating; }
  assert.equal((await sqlClient`SELECT status,last_error FROM telemetry.feed_prewarm_jobs WHERE user_id=${userId}::uuid`)[0].last_error, 'generation_failed');
});

integration('early notifications preserve coalesced and failed prewarm retry deadlines', async () => {
  const supervisor = new WorkerSupervisor();
  const listener = new WorkerWakeups(supervisor);
  const attempts = new Map<string, number[]>();
  const failing = new Set<string>();
  const prewarm = new FeedPrewarmWorker(new FeedPrewarmService(), { generate: async userId => {
    const starts = attempts.get(userId)!;
    starts.push(performance.now());
    if (starts.length === 1) {
      if (failing.has(userId)) throw Object.assign(new Error('ML unavailable'), { code: 'ETIMEDOUT' });
      return { status: 'coalesced', feedVersion: 1n };
    }
    return { status: 'generated', feedVersion: 1n, count: 0 };
  } });
  supervisor.registerAdaptive('feed-prewarm', 10, 60_000, () => prewarm.runOnce());
  try {
    await listener.start();
    supervisor.start();
    for (const fails of [false, true]) {
      const userId = await user();
      const starts: number[] = [];
      attempts.set(userId, starts);
      if (fails) failing.add(userId);
      await deliver(userId);
      await until(async () => (await sqlClient`
        SELECT status FROM telemetry.feed_prewarm_jobs WHERE user_id=${userId}::uuid
      `)[0]?.status === 'completed');
      assert.equal(starts.length, 2);
      assert.ok(starts[1]-starts[0] >= (fails ? 1_900 : 900), 'retry backoff must not be bypassed');
      assert.ok(starts[1]-starts[0] < 5_000, 'an early notification must not impose the 60-second idle poll');
    }
    assert.equal(supervisor.snapshot()['feed-prewarm'].failures, 0);
  } finally { await supervisor.stop(); await listener.stop(); }
});

integration('notifications wake idle workers and reconnect drains missed work without fallback polling', async t => {
  const supervisor = new WorkerSupervisor();
  const listener = new WorkerWakeups(supervisor);
  const outbox = new OutboxService();
  let claimed = 0; let polls = 0; let started = performance.now(); let latency = 0;
  supervisor.registerAdaptive('ml-outbox', 10, 60_000, async () => {
    polls++;
    const [row] = await outbox.claim(1);
    if (!row) return 0;
    latency = performance.now()-started; claimed++;
    await outbox.markDelivered(row); return 1;
  });
  supervisor.registerAdaptive('outbox-notification-listener', 10, 60_000, async () => {
    await listener.start(); return 0;
  });
  try {
    supervisor.start(); await listener.start();
    await until(async () => polls >= 2 && !supervisor.snapshot()['ml-outbox'].running);
    const firstUser = await user();
    started = performance.now(); await onboard(firstUser);
    await until(async () => claimed === 1);
    t.diagnostic(`Measured local commit-call-to-claim upper bound: ${latency.toFixed(1)} ms (60 second fallback, not elapsed latency).`);
    await until(async () => !supervisor.snapshot()['ml-outbox'].running);
    await delay(30);
    const before = polls;
    // Terminate this fixture's session. The supervisor must reconnect, re-LISTEN
    // and recheck durable work. A 60 second poll cannot satisfy this 5s wait.
    await sqlClient`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE application_name='weave-worker-wakeups' AND datname=current_database()`;
    started = performance.now(); await onboard(await user());
    await until(async () => claimed === 2 && polls > before);
    assert.ok(polls > before);
  } finally { await listener.stop(); await supervisor.stop(); }
});

integration('bounded fallback polling survives lost signals: compare measured wake and polling latency at the same interval', async t => {
  const supervisor = new WorkerSupervisor(); const outbox = new OutboxService();
  const listener = new WorkerWakeups(supervisor);
  let polls = 0; let emptyPolls = 0; let claimed = 0; let claimTime = 0;
  supervisor.registerAdaptive('ml-outbox', 10, 500, async () => {
    polls++;
    const [row] = await outbox.claim(1);
    if (!row) { emptyPolls++; return 0; }
    claimTime = performance.now(); claimed++;
    await outbox.markDelivered(row); return 1;
  });
  try {
    supervisor.start();
    await until(async () => polls === 1 && !supervisor.snapshot()['ml-outbox'].running);
    const firstUser = await user();
    let started = performance.now();
    await onboard(firstUser);
    await until(async () => claimed === 1);
    assert.ok(polls >= 2);
    const fallbackMs = claimTime-started;
    await until(async () => emptyPolls >= 2 && !supervisor.snapshot()['ml-outbox'].running);
    await listener.start();
    await until(async () => !supervisor.snapshot()['ml-outbox'].running);
    const nextUser = await user();
    started = performance.now(); await onboard(nextUser);
    await until(async () => claimed === 2);
    t.diagnostic(`Measured producer-call-to-claim-response upper bounds, same 500 ms fallback: polling=${fallbackMs.toFixed(1)} ms, wake=${(claimTime-started).toFixed(1)} ms. Transaction execution is included; these are not configured-interval-as-latency claims.`);
  } finally { await listener.stop(); await supervisor.stop(); }
});


integration('retry horizon is immutable, expiry is visible and stale completion cannot erase success', async () => {
  const userId = await user(); await deliver(userId);
  const queue = new FeedPrewarmService();
  const first = (await queue.claim())!;
  assert.equal(await queue.isCurrent(first), true);
  const scheduled = (await sqlClient`SELECT scheduled_at FROM telemetry.feed_prewarm_jobs WHERE user_id=${userId}::uuid`)[0].scheduled_at;
  await queue.retry(first);
  assert.equal(String((await sqlClient`SELECT scheduled_at FROM telemetry.feed_prewarm_jobs WHERE user_id=${userId}::uuid`)[0].scheduled_at), String(scheduled));
  await sqlClient`UPDATE telemetry.feed_prewarm_jobs SET scheduled_at=now()-interval '8 days',available_at=now() WHERE user_id=${userId}::uuid`;
  assert.equal(await queue.claim(), null);
  assert.equal(await queue.expire(), 1);
  assert.equal((await queue.status()).expired, 1);
  await queue.finish(first, { status: 'generated',feedVersion: 1n,count: 0 });
  assert.equal((await sqlClient`SELECT status FROM telemetry.feed_prewarm_jobs WHERE user_id=${userId}::uuid`)[0].status, 'expired');
  await deliver(userId);
  assert.equal(await queue.claim(), null, 'duplicate delivery cannot restart the old horizon');
});
