import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { sqlClient } from '../../db/index.js';
import { GitHubImportConsentService } from '../../services/githubImportConsentService.js';
import { OutboxService, type OutboxRow } from '../../services/outboxService.js';
import { OutboxWorker } from '../../workers/outboxWorker.js';
import { buildMlOnboardingJob } from '../../services/mlOnboardingService.js';
import { assertDisposableDatabase } from './disposableDatabase.js';

const enabled = process.env.RUN_DATABASE_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();
test.after(async () => { if (enabled) await sqlClient.end({ timeout: 1 }); });

test('revocation retires queued import deliveries and current-profile admission fences stale claims', {
  skip: !enabled, timeout: 30_000,
}, async () => {
  const user = crypto.randomUUID(), peer = crypto.randomUUID();
  const ids = [user, peer];
  const outbox = new OutboxService();
  const cache = { get: async () => null, set: async () => 'OK', del: async () => 0 };
  const service = new GitHubImportConsentService({ collect: async () => {
    throw new Error('Revocation must not collect provider data');
  } }, cache);
  async function createJob(owner: string, status: string, version = 2) {
    const id = crypto.randomUUID(), token = status === 'claimed' ? crypto.randomUUID() : null;
    const payload = buildMlOnboardingJob(owner, version, { username: 'fixture', interests: ['imported-only'] });
    await sqlClient`INSERT INTO telemetry.ml_outbox(outbox_id,job_type,aggregate_id,idempotency_key,payload,status,claim_token,claimed_at)
      VALUES(${id}::uuid,'onboard',${owner}::uuid,${'revocation-test:'+id},${JSON.stringify(payload)}::jsonb,
        ${status},${token}::uuid,${token ? new Date().toISOString() : null}::timestamptz)`;
    return id;
  }
  async function claim(id: string, token = crypto.randomUUID()): Promise<OutboxRow> {
    const [row] = await sqlClient`UPDATE telemetry.ml_outbox SET status='claimed',claimed_at=now(),claim_token=${token}::uuid
      WHERE outbox_id=${id}::uuid RETURNING *`;
    return { ...row, created_at: new Date(row.created_at).toISOString() } as OutboxRow;
  }
  async function state(id: string) {
    return (await sqlClient`SELECT status,claim_token,payload FROM telemetry.ml_outbox WHERE outbox_id=${id}::uuid`)[0];
  }
  try {
    for (const id of ids) {
      await sqlClient`INSERT INTO auth.users(id) VALUES(${id}::uuid)`;
      await sqlClient`INSERT INTO app.users(user_id,username,status,profile_version,interests,onboarding_completed)
        VALUES(${id}::uuid,${'revoke_'+id.replaceAll('-', '')},'active',2,'["imported-only"]'::jsonb,true)`;
    }
    await sqlClient`INSERT INTO app.user_github_imports(user_id,accepted_at,accepted_profile_version,baseline,applied)
      VALUES(${user}::uuid,now(),2,
        '{"interests":["manual-interest"],"skills":[],"tech_stack":[]}'::jsonb,
        '{"interests":["imported-only"],"skills":[],"tech_stack":[]}'::jsonb)`;
    const retired = await Promise.all(['pending', 'claimed', 'dead'].map(status => createJob(user, status)));
    const previouslyClaimed = await claim(retired[1]);
    const untouchedPeer = await createJob(peer, 'pending');
    const revoked = await service.revoke(user);
    assert.equal(revoked.profile_version, '3');
    for (const id of retired) {
      assert.equal((await state(id)).status, 'superseded');
      assert.equal((await state(id)).claim_token, null);
      assert.equal(await outbox.replay(id), false, 'retired consent cannot be reactivated by dead-job replay');
    }
    assert.equal((await state(untouchedPeer)).status, 'pending');
    assert.equal(await outbox.prepareOnboardingDelivery(previouslyClaimed), false);
    class PreviouslyClaimedOutbox extends OutboxService {
      private emitted = false;
      override async claim(): Promise<OutboxRow[]> {
        if (this.emitted) return [];
        this.emitted = true;
        return [previouslyClaimed];
      }
    }
    const unexpected = async () => assert.fail('Revoked onboarding reached ML transport');
    assert.equal(await new OutboxWorker(new PreviouslyClaimedOutbox(), {
      deliverOnboarding: unexpected, deliverFeedback: unexpected,
      deliverRepositoryIndex: unexpected, deliverRepositoryRefresh: unexpected,
    }).runOnce(), 1);
    const [restored] = await sqlClient`SELECT outbox_id,payload FROM telemetry.ml_outbox
      WHERE aggregate_id=${user}::uuid AND job_type='onboard' AND payload->>'profile_version'='3'`;
    assert.ok(restored);
    assert.deepEqual(restored.payload.profile.interests, ['manual-interest']);
    const current = await claim(String(restored.outbox_id));
    assert.equal(await outbox.prepareOnboardingDelivery(current), true);
    await sqlClient`UPDATE app.users SET profile_version=4 WHERE user_id=${user}::uuid`;
    assert.equal(await outbox.prepareOnboardingDelivery(current), false, 'outage retry must recheck the current version');
    assert.equal((await state(current.outbox_id)).status, 'superseded');
    const next = await createJob(user, 'pending', 4);
    const oldLease = await claim(next);
    const newLease = await claim(next);
    assert.equal(await outbox.prepareOnboardingDelivery(oldLease), false);
    assert.equal((await state(next)).claim_token, newLease.claim_token, 'expired gate must preserve replacement ownership');
    assert.equal(await outbox.prepareOnboardingDelivery(newLease), true);
  } finally {
    await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=ANY(${ids}::uuid[])`;
    await sqlClient`DELETE FROM app.users WHERE user_id=ANY(${ids}::uuid[])`;
    await sqlClient`DELETE FROM auth.users WHERE id=ANY(${ids}::uuid[])`;
  }
});


test('onboarding completion waits for its user before locking the claimed job', {
  skip: !enabled, timeout: 30_000,
}, async () => {
  const user = crypto.randomUUID(), id = crypto.randomUUID(), token = crypto.randomUUID();
  const outbox = new OutboxService();
  let completion: Promise<boolean> | undefined;
  try {
    await sqlClient`INSERT INTO auth.users(id) VALUES(${user}::uuid)`;
    await sqlClient`INSERT INTO app.users(user_id,username,status,profile_version,interests,onboarding_completed)
      VALUES(${user}::uuid,${'completion_lock_'+user.replaceAll('-', '')},'active',2,'["manual"]'::jsonb,true)`;
    await sqlClient`INSERT INTO app.user_feed_state(user_id,feed_version) VALUES(${user}::uuid,1)`;
    const payload = buildMlOnboardingJob(user, 2, { username: 'fixture', interests: ['manual'] });
    const [stored] = await sqlClient`INSERT INTO telemetry.ml_outbox(outbox_id,job_type,aggregate_id,idempotency_key,payload,status,claim_token,claimed_at)
      VALUES(${id}::uuid,'onboard',${user}::uuid,${'completion-lock:'+id},${JSON.stringify(payload)}::jsonb,'claimed',${token}::uuid,now()) RETURNING *`;
    const row = { ...stored, created_at: new Date(stored.created_at).toISOString() } as OutboxRow;
    // Force the first-delivery FK-insert path, not an existing-row conflict update.
    await sqlClient`DELETE FROM telemetry.feed_prewarm_jobs WHERE user_id=${user}::uuid`;
    await sqlClient.begin(async tx => {
      await tx`SELECT user_id FROM app.users WHERE user_id=${user}::uuid FOR UPDATE`;
      const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
      // Completion uses a second actual connection and must block on this user.
      completion = outbox.markDelivered(row);
      // Attach rejection immediately so a failure cannot become unhandled while
      // the deterministic barrier is still inspecting PostgreSQL lock state.
      void completion.catch(() => undefined);
      let blocked = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        await tx`SELECT pg_stat_clear_snapshot()`;
        const [waiting] = await tx`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE ${Number(backend.pid)}::int=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock') AS waiting`;
        if (waiting.waiting) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(blocked, 'observe actual completion waiting on the held user');
      // Before the fix, completion already owns this job and waits on the user
      // FK in schedule_onboarding_prewarm. NOWAIT exposes that inverse lock
      // order immediately instead of manufacturing a database deadlock timeout.
      await tx`SELECT outbox_id FROM telemetry.ml_outbox WHERE outbox_id=${id}::uuid FOR UPDATE NOWAIT`;
      await tx`UPDATE telemetry.ml_outbox SET status='superseded',claim_token=NULL,claimed_at=NULL
        WHERE outbox_id=${id}::uuid AND status='claimed' AND claim_token=${token}::uuid`;
    });
    assert.ok(completion);
    assert.equal(await completion, false, 'a superseded claim must not report delivery confirmation');
    const [state] = await sqlClient`SELECT status,claim_token FROM telemetry.ml_outbox WHERE outbox_id=${id}::uuid`;
    assert.deepEqual([state.status,state.claim_token], ['superseded',null]);
    const [prewarm] = await sqlClient`SELECT count(*) FROM telemetry.feed_prewarm_jobs WHERE user_id=${user}::uuid`;
    assert.equal(Number(prewarm.count), 0, 'retired context cannot enqueue a first prewarm');
  } finally {
    await completion?.catch(() => undefined);
    await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${user}::uuid`;
    await sqlClient`DELETE FROM telemetry.feed_prewarm_jobs WHERE user_id=${user}::uuid`;
    await sqlClient`DELETE FROM app.users WHERE user_id=${user}::uuid`;
    await sqlClient`DELETE FROM auth.users WHERE id=${user}::uuid`;
  }
});
