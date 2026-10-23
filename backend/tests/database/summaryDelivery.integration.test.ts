import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';

import { sqlClient } from '../../db/index.js';
import { MlV2Client } from '../../services/mlService.js';
import { OutboxService, type OutboxRow } from '../../services/outboxService.js';
import { OutboxWorker } from '../../workers/outboxWorker.js';
import { PostgresFeedPersistence } from '../../adapters/postgresFeedPersistence.js';
import type { MlRepositoryIndexJob, MlRepositoryIndexResponse } from '../../contracts/ml.v2.js';
import { assertDisposableDatabase } from './disposableDatabase.js';

const enabled = process.env.RUN_SUMMARY_DELIVERY_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();
test.after(async () => { if (enabled) await sqlClient.end({ timeout: 1 }); });

class RecordingOutbox extends OutboxService {
  readonly claims: OutboxRow[] = [];
  afterClaim?: (rows: OutboxRow[]) => Promise<void>;
  override async claim(...args: Parameters<OutboxService['claim']>): Promise<OutboxRow[]> {
    const rows = await super.claim(...args);
    this.claims.push(...rows);
    await this.afterClaim?.(rows);
    return rows;
  }
}

test('repository index HTTP delivery commits its summary before ACK and durable feed readback', {
  skip: !enabled, timeout: 30_000,
}, async () => {
  // This suite exclusively owns the explicitly selected scratch database.
  // Never run it against an application database or concurrently with another
  // fixture using the same scratch target.
  await sqlClient`TRUNCATE app.repos,telemetry.ml_outbox CASCADE`;
  const user = crypto.randomUUID();
  await sqlClient`INSERT INTO auth.users(id) VALUES(${user}::uuid)`;
  await sqlClient`INSERT INTO app.users(user_id,username,status)
    VALUES(${user}::uuid,${'summary_'+user.replaceAll('-', '')},'active')`;
  const requests: MlRepositoryIndexJob[] = [];
  const invalidCases = ['summary', 'repo_id', 'content_version', 'model_version', 'prompt_version', 'format_version'] as const;
  const malformed = new Map<string, typeof invalidCases[number]>();
  const responses = new Map<string, MlRepositoryIndexResponse>();
  const app = express();
  app.use(express.json());
  // Explicit deterministic provider double: models/Qdrant are outside this
  // backend transaction test. Client HTTP/auth/validation and all SQL are real.
  app.post('/api/v2/repositories/embed', (req, res) => {
    assert.equal(req.headers['x-internal-secret'], 'summary-delivery-fixture');
    const job = req.body as MlRepositoryIndexJob;
    requests.push(job);
    const response: MlRepositoryIndexResponse = {
      schema_version: 2, accepted: true, status: 'applied', job_id: job.job_id,
      repo_id: job.repo_id, content_version: job.content_version, embedding_version: 'embedding-v2',
      card_summary: {
        summary: `Version ${job.content_version} provides concise discovery context. Developers can inspect its repository details.`,
        highlights: ['Versioned context'], prompt_version: 'repo-card-summary-v1',
        model_version: 'summary-delivery-model', format_version: 'repo-card-summary-json-v1', source: 'generated',
      },
    };
    const invalid = malformed.get(job.repo_id);
    if (invalid === 'summary') response.card_summary.summary = 'x'.repeat(361);
    else if (invalid === 'repo_id') response.repo_id = crypto.randomUUID();
    else if (invalid === 'content_version') response.content_version++;
    else if (invalid) response.card_summary[invalid] = '';
    responses.set(job.job_id, response);
    res.json(response);
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const outbox = new RecordingOutbox();
  const feed = new PostgresFeedPersistence();
  const worker = new OutboxWorker(outbox, new MlV2Client({
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    internalSecret: 'summary-delivery-fixture', timeoutMs: 2000, deliveryTimeoutMs: 2000,
    repositoryIndexTimeoutMs: 2000, maxResponseBytes: 100_000,
  }));

  async function repository() {
    const id = crypto.randomUUID();
    const githubId = crypto.randomInt(1, 1_000_000_000);
    await sqlClient`INSERT INTO app.repos(repo_id,github_id,full_name,owner,name,url,status)
      VALUES(${id}::uuid,${githubId},${'fixture/'+id},'fixture',${id},${'https://github.com/fixture/'+id},'active')`;
    return id;
  }
  async function content(repoId: string, version: number) {
    await sqlClient`INSERT INTO app.repo_content(repo_id,content_hash,content_version,readme,languages)
      VALUES(${repoId}::uuid,${'hash-'+version},${version},${'# Canonical README '+version},'[]'::jsonb)
      ON CONFLICT(repo_id) DO UPDATE SET content_hash=excluded.content_hash,
        content_version=excluded.content_version,readme=excluded.readme`;
  }
  async function enqueue(repoId: string, version: number) {
    const job: MlRepositoryIndexJob = { job_id: crypto.randomUUID(), repo_id: repoId,
      content_version: version, repository: { full_name: 'fixture/'+repoId,
        description: 'Synthetic repository for summary delivery testing.', primary_language: 'TypeScript',
        languages: ['TypeScript'], topics: ['testing'], star_count: 0, fork_count: 0, open_issues_count: 0,
        readme: '# Canonical README '+version, content_hash: 'hash-'+version } };
    const id = crypto.randomUUID();
    await sqlClient`INSERT INTO telemetry.ml_outbox(outbox_id,job_type,aggregate_id,idempotency_key,payload)
      VALUES(${id}::uuid,'repo_index',${repoId}::uuid,${'summary-delivery:'+job.job_id},${JSON.stringify(job)}::jsonb)`;
    return id;
  }
  async function state(id: string) {
    return (await sqlClient`SELECT status,claim_token,response_payload FROM telemetry.ml_outbox
      WHERE outbox_id=${id}::uuid`)[0];
  }
  async function summaries(repoId: string) {
    return sqlClient`SELECT summary_id,content_version,summary,active,created_at,artifact_revision
      FROM app.repo_card_summaries WHERE repo_id=${repoId}::uuid ORDER BY content_version`;
  }
  async function readFeed(repoId: string) {
    const [projection] = await feed.listActiveRepositories([repoId], user);
    assert.ok(projection);
    const requestId = crypto.randomUUID();
    const serve = await feed.createServe({ feed_request_id: requestId, user_id: user,
      session_id: crypto.randomUUID(), feed_version: 1n, generation_id: null, source: 'personalized',
      model_version: 'summary-delivery-fixture', next_cursor: null,
      items: [{ repo_id: repoId, score: 1, source: 'semantic', model_version: 'summary-delivery-fixture',
        summary_id: projection.summary_id, position: 0, repository: projection }] });
    const replay = await feed.getServeByRequest(user, requestId);
    assert.equal(replay?.serve_id, serve.serve_id);
    assert.equal(replay?.items[0]?.repository.summary, projection.summary);
    return replay!.items[0]!.repository;
  }
  try {
    const normal = await repository();
    await content(normal, 1);
    const normalJob = await enqueue(normal, 1);
    assert.equal(await worker.runOnce(), 1);
    assert.equal((await state(normalJob)).status, 'delivered');
    const first = await summaries(normal);
    assert.equal(first.length, 1);
    assert.equal(first[0].active, true);
    assert.equal((await readFeed(normal)).summary, first[0].summary);
    const claim = outbox.claims.find(row => row.outbox_id === normalJob)!;
    const response = responses.get(String(claim.payload.job_id))!;
    assert.equal(await outbox.completeRepositoryIndex(claim, response), false);
    assert.equal(await worker.runOnce(), 0);
    assert.equal(requests.length, 1, 'delivered replay must not call or regenerate ML work');
    assert.deepEqual(await summaries(normal), first, 'delivered replay must not rewrite its artifact');

    const failed = await repository();
    await content(failed, 1);
    const failedJob = await enqueue(failed, 1);
    await sqlClient.unsafe(`CREATE FUNCTION telemetry.summary_delivery_test_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'summary-delivery SQL fault'; END; $$`);
    await sqlClient.unsafe(`CREATE TRIGGER summary_delivery_test_failure BEFORE INSERT ON app.repo_card_summaries
      FOR EACH ROW WHEN (NEW.repo_id='${failed}'::uuid) EXECUTE FUNCTION telemetry.summary_delivery_test_failure()`);
    try {
      await assert.rejects(worker.runOnce(), /summary-delivery SQL fault/);
      assert.equal((await state(failedJob)).status, 'claimed', 'SQL failure must leave recoverable work');
      assert.equal((await summaries(failed)).length, 0, 'SQL failure must roll back the artifact');
      assert.equal((await readFeed(failed)).summary, null);
    } finally {
      await sqlClient`DROP TRIGGER IF EXISTS summary_delivery_test_failure ON app.repo_card_summaries`;
      await sqlClient`DROP FUNCTION IF EXISTS telemetry.summary_delivery_test_failure()`;
    }
    const failedClaim = outbox.claims.find(row => row.outbox_id === failedJob)!;
    await sqlClient`UPDATE telemetry.ml_outbox SET claimed_at=now()-interval '1 hour'
      WHERE outbox_id=${failedJob}::uuid`;
    let staleClaimCheckedWhileClaimed = false;
    outbox.afterClaim = async rows => {
      const replacement = rows.find(row => row.outbox_id === failedJob);
      if (!replacement) return;
      const before = await state(failedJob);
      assert.equal(before.status, 'claimed');
      assert.notEqual(before.claim_token, failedClaim.claim_token);
      assert.equal(await outbox.completeRepositoryIndex(
        failedClaim, responses.get(String(failedClaim.payload.job_id))!), false,
        'expired token must not complete work owned by a live replacement');
      assert.deepEqual(await state(failedJob), before, 'stale completion changed replacement claim');
      assert.equal((await summaries(failed)).length, 0, 'stale completion wrote a summary');
      staleClaimCheckedWhileClaimed = true;
    };
    try {
      assert.equal(await worker.runOnce(), 1);
    } finally {
      outbox.afterClaim = undefined;
    }
    assert.equal(staleClaimCheckedWhileClaimed, true);
    assert.equal((await state(failedJob)).status, 'delivered');
    assert.equal((await summaries(failed)).length, 1);
    assert.ok((await readFeed(failed)).summary);
    assert.equal(await outbox.completeRepositoryIndex(failedClaim, responses.get(String(failedClaim.payload.job_id))!), false,
      'expired claim cannot write after recovery completed');

    const reordered = await repository();
    await content(reordered, 2);
    const oldJob = await enqueue(reordered, 1);
    assert.equal(await worker.runOnce(), 1);
    assert.equal((await state(oldJob)).status, 'delivered');
    assert.equal((await summaries(reordered))[0].active, false);
    assert.equal((await readFeed(reordered)).summary, null, 'old result must not appear for current content');
    const newJob = await enqueue(reordered, 2);
    assert.equal(await worker.runOnce(), 1);
    assert.equal((await state(newJob)).status, 'delivered');
    const versions = await summaries(reordered);
    assert.deepEqual(versions.map(row => [Number(row.content_version), row.active]), [[1, false], [2, true]]);
    assert.equal((await readFeed(reordered)).summary, versions[1].summary);

    for (const invalidCase of invalidCases) {
      const invalid = await repository();
      await content(invalid, 1);
      malformed.set(invalid, invalidCase);
      const invalidJob = await enqueue(invalid, 1);
      assert.equal(await worker.runOnce(), 1);
      assert.equal((await state(invalidJob)).status, 'dead', `${invalidCase} must never become delivered`);
      assert.equal((await summaries(invalid)).length, 0);
      assert.equal((await readFeed(invalid)).summary, null);
    }

    const counts = (await sqlClient`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE active)::int AS active FROM app.repo_card_summaries`)[0];
    assert.deepEqual({ requests: requests.length, persisted: Number(counts.total), active: Number(counts.active) },
      { requests: 11, persisted: 4, active: 3 });
    const jobs = (await sqlClient`SELECT count(*) FILTER(WHERE status='delivered')::int AS delivered,
      count(*) FILTER(WHERE status='dead')::int AS dead,
      count(*) FILTER(WHERE status IN ('pending','claimed'))::int AS unfinished FROM telemetry.ml_outbox`)[0];
    assert.deepEqual({ delivered: jobs.delivered, dead: jobs.dead, unfinished: jobs.unfinished },
      { delivered: 4, dead: 6, unfinished: 0 });
    console.log('SUMMARY_DELIVERY_ACCEPTANCE '+JSON.stringify({ http_responses: requests.length,
      persisted: counts.total, active: counts.active, delivered_replay_extra_requests: 0,
      sql_failure_recovered: true, malformed_acknowledged: false, delivered: jobs.delivered, rejected: jobs.dead }));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
