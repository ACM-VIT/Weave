import { runReadmeSummaryWorker } from '../../workers/readmeSummaryWorker.js';
import { ReadmeSummaryService, getReadmeSummaryStatus } from '../../services/readmeSummaryService.js';
import { digestFixture } from '../fixtures/readmeDigest.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';

import type { MlRepositoryIndexResponse } from '../../contracts/ml.v2.js';
import { sqlClient } from '../../db/index.js';
import { OutboxService, type OutboxRow } from '../../services/outboxService.js';
import { runReindex } from '../../scripts/reindex-active-repositories.js';
import { PostgresRepositoryPersistence } from '../../adapters/postgresRepositoryPersistence.js';
import { assertDisposableDatabase } from './disposableDatabase.js';

if (process.env.RUN_DATABASE_INTEGRATION === '1') assertDisposableDatabase();
const integration = process.env.RUN_DATABASE_INTEGRATION === '1' ? test : test.skip;
const repoId = '00000000-0000-4000-8000-000000000701';
const claimToken = '00000000-0000-4000-8000-000000000702';

test.after(async () => {
  if (process.env.RUN_DATABASE_INTEGRATION === '1') await sqlClient.end({ timeout: 1 });
});

function response(jobId: string, contentVersion: number): MlRepositoryIndexResponse {
  return {
    schema_version: 2,
    accepted: true,
    status: 'applied',
    job_id: jobId,
    repo_id: repoId,
    content_version: contentVersion,
    embedding_version: 'embedding-v2',
    card_summary: {
      summary: `Version ${contentVersion} is a concise repository summary. It supports durable integration testing.`,
      highlights: ['Durable response'],
      prompt_version: 'repo-card-summary-v1',
      model_version: 'integration-model',
      format_version: 'repo-card-summary-json-v1',
      source: 'generated',
    },
  };
}

async function claimedRow(
  outboxId: string,
  jobId: string,
  contentVersion: number,
  contentHash = `v${contentVersion}`,
): Promise<OutboxRow> {
  const payload = {
    job_id: jobId,
    repo_id: repoId,
    content_version: contentVersion,
    repository: { content_hash: contentHash },
  };
  await sqlClient`
    INSERT INTO telemetry.ml_outbox (
      outbox_id,job_type,aggregate_id,idempotency_key,payload,status,attempts,claimed_at,claim_token
    ) VALUES (
      ${outboxId}::uuid,'repo_index',${repoId}::uuid,${`summary-integration:${contentVersion}:${jobId}`},
      ${JSON.stringify(payload)}::jsonb,'claimed',1,now(),${claimToken}::uuid
    )
  `;
  return {
    outbox_id: outboxId,
    job_type: 'repo_index',
    aggregate_id: repoId,
    idempotency_key: `summary-integration:${contentVersion}:${jobId}`,
    payload,
    attempts: 1,
    created_at: new Date().toISOString(),
    claim_token: claimToken,
  };
}

integration('summary completion is atomic, idempotent, and fenced by current content version', async () => {
  await sqlClient`TRUNCATE app.repos,telemetry.ml_outbox CASCADE`;
  await sqlClient`
    INSERT INTO app.repos (repo_id,github_id,full_name,owner,name,url)
    VALUES (${repoId}::uuid,701,'owner/summary-test','owner','summary-test','https://github.com/owner/summary-test')
  `;
  await sqlClient`
    INSERT INTO app.repo_content (
      repo_id,content_hash,content_version,readme,readme_source_path,
      readme_default_branch,readme_base_url,languages
    ) VALUES (
      ${repoId}::uuid,'v2',2,'# Canonical README\n\n![Preview](./preview.png)',
      'docs/README.md','main',
      'https://raw.githubusercontent.com/owner/summary-test/refs/heads/main/docs/',
      '[]'::jsonb
    )
  `;

  const service = new OutboxService();
  const oldRow = await claimedRow(
    '00000000-0000-4000-8000-000000000703',
    '00000000-0000-4000-8000-000000000704',
    1,
  );
  assert.equal(await service.completeRepositoryIndex(oldRow, response(String(oldRow.payload.job_id), 1)), true);
  assert.equal(await service.completeRepositoryIndex(oldRow, response(String(oldRow.payload.job_id), 1)), false);
  assert.equal(Boolean((await sqlClient`
    SELECT active FROM app.repo_card_summaries WHERE repo_id=${repoId}::uuid AND content_version=1
  `)[0].active), false, 'an older response must remain inactive');

  const currentRow = await claimedRow(
    '00000000-0000-4000-8000-000000000705',
    '00000000-0000-4000-8000-000000000706',
    2,
  );
  assert.equal(await service.completeRepositoryIndex(
    currentRow,
    response(String(currentRow.payload.job_id), 2),
  ), true);
  const rows = await sqlClient`
    SELECT content_version,active FROM app.repo_card_summaries
    WHERE repo_id=${repoId}::uuid ORDER BY content_version
  `;
  assert.deepEqual(rows.map((row) => [Number(row.content_version), Boolean(row.active)]), [
    [1, false],
    [2, true],
  ]);
  assert.equal(Number((await sqlClient`
    SELECT count(*) AS count FROM app.repo_card_summaries WHERE repo_id=${repoId}::uuid
  `)[0].count), 2);

  const canonicalContent = (await sqlClient`
    SELECT readme,readme_source_path,readme_default_branch,readme_base_url
    FROM app.repo_content WHERE repo_id=${repoId}::uuid
  `)[0];
  assert.equal(String(canonicalContent.readme), '# Canonical README\n\n![Preview](./preview.png)');
  assert.equal(String(canonicalContent.readme_source_path), 'docs/README.md');
  assert.equal(String(canonicalContent.readme_default_branch), 'main');
  assert.equal(
    String(canonicalContent.readme_base_url),
    'https://raw.githubusercontent.com/owner/summary-test/refs/heads/main/docs/',
  );

  const hashMismatchRow = await claimedRow(
    '00000000-0000-4000-8000-000000000709',
    '00000000-0000-4000-8000-000000000710',
    2,
    'not-v2',
  );
  await assert.rejects(
    service.completeRepositoryIndex(
      hashMismatchRow,
      response(String(hashMismatchRow.payload.job_id), 2),
    ),
    /payload hash does not match/,
  );
  await service.markFailed(hashMismatchRow, 'Repository-index payload hash mismatch.', false);
  assert.equal(String((await sqlClient`
    SELECT status FROM telemetry.ml_outbox WHERE outbox_id=${hashMismatchRow.outbox_id}::uuid
  `)[0].status), 'dead');

  const delivered = (await sqlClient`
    SELECT status,response_payload FROM telemetry.ml_outbox
    WHERE outbox_id=${currentRow.outbox_id}::uuid
  `)[0];
  assert.equal(String(delivered.status), 'delivered');
  assert.equal((delivered.response_payload as Record<string, unknown>).content_version, 2);

  // Recovery replay: the database already has a generated tuple, while Qdrant
  // may have been rebuilt and the model can nondeterministically return a
  // different summary for the same version tuple. The first DB writer remains
  // canonical and the successful re-index job must still be finalized.
  const recoveryRow = await claimedRow(
    '00000000-0000-4000-8000-000000000711',
    '00000000-0000-4000-8000-000000000712',
    2,
  );
  const recoveryResponse = response(String(recoveryRow.payload.job_id), 2);
  recoveryResponse.card_summary.summary = 'A rebuilt vector produced different wording. The first database artifact remains canonical.';
  assert.equal(await service.completeRepositoryIndex(recoveryRow, recoveryResponse), true);
  const recoveryOutbox = (await sqlClient`
    SELECT status,response_payload FROM telemetry.ml_outbox
    WHERE outbox_id=${recoveryRow.outbox_id}::uuid
  `)[0];
  assert.equal(String(recoveryOutbox.status), 'delivered');
  const retainedResponse = recoveryOutbox.response_payload as {
    card_summary: { summary: string };
    backend_persistence: { artifact_status: string };
  };
  assert.equal(retainedResponse.card_summary.summary, recoveryResponse.card_summary.summary);
  assert.equal(retainedResponse.backend_persistence.artifact_status, 'first_writer_retained');
  assert.equal(String((await sqlClient`
    SELECT summary FROM app.repo_card_summaries
    WHERE repo_id=${repoId}::uuid AND content_version=2 AND active
  `)[0].summary), response(String(currentRow.payload.job_id), 2).card_summary.summary);
  assert.equal(Number((await sqlClient`
    SELECT count(*) AS count FROM app.repo_card_summaries WHERE repo_id=${repoId}::uuid
  `)[0].count), 2);

  await sqlClient`
    UPDATE app.repo_card_summaries SET active=false WHERE repo_id=${repoId}::uuid AND active
  `;
  await sqlClient`
    INSERT INTO app.repo_card_summaries (
      repo_id,content_version,prompt_version,model_version,format_version,
      summary,highlights,source,active
    ) VALUES (
      ${repoId}::uuid,2,'repo-card-summary-v1','repository-description-fallback-v1',
      'repo-card-summary-json-v1',
      'The repository has a concise description. It remains eligible for generated summary recovery.',
      '[]'::jsonb,'description_fallback',true
    )
  `;
  const upgradeRow = await claimedRow(
    '00000000-0000-4000-8000-000000000713',
    '00000000-0000-4000-8000-000000000714',
    2,
  );
  const upgradeResponse = response(String(upgradeRow.payload.job_id), 2);
  upgradeResponse.card_summary.model_version = 'recovered-provider-model';
  upgradeResponse.card_summary.summary = 'A recovered provider generated project context. It replaces the temporary description fallback.';
  assert.equal(await service.completeRepositoryIndex(upgradeRow, upgradeResponse), true);
  const activeUpgrade = (await sqlClient`
    SELECT model_version,source FROM app.repo_card_summaries
    WHERE repo_id=${repoId}::uuid AND active
  `)[0];
  assert.equal(String(activeUpgrade.model_version), 'recovered-provider-model');
  assert.equal(String(activeUpgrade.source), 'generated');

  const fallbackReplay = await claimedRow(
    '00000000-0000-4000-8000-000000000715',
    '00000000-0000-4000-8000-000000000716', 2,
  );
  const fallbackResponse = response(String(fallbackReplay.payload.job_id), 2);
  fallbackResponse.card_summary.source = 'description_fallback';
  fallbackResponse.card_summary.model_version = 'repository-description-fallback-v1';
  assert.equal(await service.completeRepositoryIndex(fallbackReplay, fallbackResponse), true);
  assert.equal(String((await sqlClient`
    SELECT source FROM app.repo_card_summaries WHERE repo_id=${repoId}::uuid AND active
  `)[0].source), 'generated', 'a recovery fallback must not downgrade durable generated content');

  // Deploying compatible validators must not silently revive terminal jobs.
  // An explicit replay retains the original content identity and is fenced by
  // a fresh claim before the corrected ML artifact can commit atomically.
  const terminalRecoveryRow = await claimedRow(crypto.randomUUID(), crypto.randomUUID(), 2);
  await service.markFailed(terminalRecoveryRow, 'Pre-fix summary contract rejection', false);
  assert.equal(String((await sqlClient`
    SELECT status FROM telemetry.ml_outbox WHERE outbox_id=${terminalRecoveryRow.outbox_id}::uuid
  `)[0].status), 'dead');
  assert.equal(await service.replay(terminalRecoveryRow.outbox_id), true);
  const recovered = (await service.claim(50)).find(row => row.outbox_id === terminalRecoveryRow.outbox_id)!;
  assert.ok(recovered);
  assert.equal(recovered.idempotency_key, terminalRecoveryRow.idempotency_key);
  assert.deepEqual(recovered.payload, terminalRecoveryRow.payload);
  assert.notEqual(recovered.claim_token, terminalRecoveryRow.claim_token);
  assert.equal(recovered.attempts, 1);
  const recoveredResponse = response(String(recovered.payload.job_id), 2);
  recoveredResponse.card_summary.model_version = 'terminal-recovery-model';
  assert.equal(await service.completeRepositoryIndex(recovered, recoveredResponse), true);
  assert.equal(String((await sqlClient`
    SELECT status FROM telemetry.ml_outbox WHERE outbox_id=${recovered.outbox_id}::uuid
  `)[0].status), 'delivered');
  assert.equal(await service.replay(recovered.outbox_id), false, 'Delivered jobs must not be reset.');

  const failedRow = await claimedRow(
    '00000000-0000-4000-8000-000000000717',
    '00000000-0000-4000-8000-000000000718', 2,
  );
  const invalidResponse = response(String(failedRow.payload.job_id), 2);
  invalidResponse.card_summary.model_version = 'failed-persistence-model';
  invalidResponse.card_summary.summary = 'x'.repeat(361);
  await assert.rejects(service.completeRepositoryIndex(failedRow, invalidResponse));
  assert.equal(String((await sqlClient`
    SELECT status FROM telemetry.ml_outbox WHERE outbox_id=${failedRow.outbox_id}::uuid
  `)[0].status), 'claimed', 'failed persistence retains the recoverable claim');
  assert.equal(Number((await sqlClient`
    SELECT count(*) AS count FROM app.repo_card_summaries
    WHERE repo_id=${repoId}::uuid AND model_version='failed-persistence-model'
  `)[0].count), 0, 'failed completion must roll back the artifact insertion');
});

integration('summary completion follows ingestion lock order without blocking its content write', async () => {
  const row = await claimedRow(crypto.randomUUID(), crypto.randomUUID(), 2);
  const ingestionClient = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  let signalLocked!: () => void;
  const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
  let continueIngestion!: () => void;
  const proceed = new Promise<void>((resolve) => { continueIngestion = resolve; });
  const ingestion = ingestionClient.begin(async (tx) => {
    await tx`SELECT repo_id FROM app.repos WHERE repo_id=${repoId}::uuid FOR UPDATE`;
    signalLocked();
    await proceed;
    await tx`SET LOCAL lock_timeout='500ms'`;
    await tx`UPDATE app.repo_content SET updated_at=now() WHERE repo_id=${repoId}::uuid`;
  });
  await locked;
  const completion = new OutboxService().completeRepositoryIndex(row, response(String(row.payload.job_id), 2));
  try {
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const waiting = await sqlClient`
        SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid()
          AND wait_event_type='Lock'
      `;
      if (waiting.length) { blocked = true; break; }
      await delay(10);
    }
    assert.equal(blocked, true, 'completion must reach the repository lock while ingestion owns it');
    continueIngestion();
    await ingestion;
    assert.equal(await completion, true);
  } finally {
    continueIngestion();
    await Promise.allSettled([ingestion, completion]);
    await ingestionClient.end({ timeout: 1 });
  }
});

integration('summary backfill reports generated exclusions and eligible jobs consistently', async () => {
  const options = { campaignId: 'summary-counts-regression', execute: false, batchSize: 1, summaryBackfill: true };
  const report = await runReindex(options, process.env.DATABASE_URL!);
  assert.equal(report.active, 1);
  assert.equal(report.eligible, 0);
  assert.equal(report.already_generated, 1);
  assert.equal(report.skipped, 1);
  assert.equal(report.would_queue, 0);

  await sqlClient`UPDATE app.repo_card_summaries SET active=false WHERE repo_id=${repoId}::uuid`;
  await sqlClient`
    UPDATE app.repo_card_summaries SET active=true
    WHERE repo_id=${repoId}::uuid AND content_version=2 AND source='description_fallback'
  `;
  const eligible = await runReindex(options, process.env.DATABASE_URL!);
  assert.equal(eligible.active, 1);
  assert.equal(eligible.eligible, 1);
  assert.equal(eligible.already_generated, 0);
  // This direct persistence fixture deliberately has no owner GitHub ID.
  assert.equal(eligible.invalid, 1);
  assert.equal(eligible.skipped, 1);
});

integration('code-only changes deliver index-only activity fields to ML', async () => {
  const persistence = new PostgresRepositoryPersistence();
  const record = {
    github_id: '7701', owner_github_id: '7702', full_name: 'fixture/activity',
    owner: 'fixture', name: 'activity', url: 'https://github.com/fixture/activity',
    description: 'Unchanged project prose.', readme: '# Unchanged README',
    observed_at: '2026-10-20T00:00:00Z', recent_commits: [], readme_to_codebase_ratio: 0.1,
  };
  const [first] = await persistence.bulkUpsert([record]);
  const updated = { ...record, recent_commits: ['2026-10-20T01:00:00Z'], readme_to_codebase_ratio: 0.2,
    observed_at: '2026-10-20T01:00:00Z' };
  const [second] = await persistence.bulkUpsert([updated]);
  assert.equal(second.content_version, first.content_version + 1);
  const jobs = await sqlClient`
    SELECT job_type,payload FROM telemetry.ml_outbox
    WHERE aggregate_id=${second.repo_id}::uuid AND payload->>'content_version'=${String(second.content_version)}
  `;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].job_type, 'repo_index');
  assert.equal(jobs[0].payload.repository.readme_to_codebase_ratio, 0.2);
  assert.deepEqual(jobs[0].payload.repository.recent_commits, ['2026-10-20T01:00:00.000Z']);
});

integration('legacy backfill remains idempotent after versioned summary migration', async () => {
  const legacyId = crypto.randomUUID();
  // Legacy schemas without numeric GitHub IDs require an existing canonical
  // mapping; the backfill deliberately refuses to invent those identities.
  await sqlClient`
    INSERT INTO app.repos (repo_id,github_id,full_name,owner,name,url)
    VALUES (${legacyId}::uuid,7703,'legacy/summary-fixture','legacy','summary-fixture',
      'https://github.com/legacy/summary-fixture')
  `;
  await sqlClient`
    INSERT INTO public.repo (repo_id,github_repo_url,owner_id,repo_name,full_name,readme_summary)
    VALUES (${legacyId}::uuid,'https://github.com/legacy/summary-fixture','legacy',
      'summary-fixture','legacy/summary-fixture',${'Historical summary text. '.repeat(20)})
  `;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'weave-backfill-regression-'));
  try {
    for (let replay = 0; replay < 2; replay++) {
      await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/backfill-v2.ts'], {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        env: { ...process.env, BACKFILL_REPORT: path.join(directory, `report-${replay}.json`) },
        timeout: 15_000,
      });
    }
    const summaries = await sqlClient`
      SELECT active,source,prompt_version,format_version FROM app.repo_card_summaries
      WHERE repo_id=${legacyId}::uuid
    `;
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].active, false);
    assert.equal(summaries[0].source, 'legacy');
    assert.equal(summaries[0].prompt_version, 'legacy-unversioned');
    assert.equal(summaries[0].format_version, 'legacy-unversioned');
  } finally {
    await sqlClient`DELETE FROM public.repo WHERE repo_id=${legacyId}::uuid`;
    await rm(directory, { recursive: true, force: true });
  }
});

integration('delivered malformed artifacts recover through immutable successors and scoped campaigns', async () => {
  const service = new OutboxService();
  const model = 'accepted-malformed-model';
  const originalJob = await claimedRow(crypto.randomUUID(), crypto.randomUUID(), 2);
  const originalResponse = response(String(originalJob.payload.job_id), 2);
  originalResponse.card_summary.model_version = model;
  await service.completeRepositoryIndex(originalJob, originalResponse);
  const original = (await sqlClient`SELECT * FROM app.repo_card_summaries WHERE repo_id=${repoId}::uuid AND active`)[0];
  const malformed = 'It supports shared workflows. Teams review changes. Users share updates. Formats include, e.g.';
  // Reproduce an artifact already accepted/delivered before validation tightened.
  await sqlClient`UPDATE app.repo_card_summaries SET summary=${malformed} WHERE summary_id=${original.summary_id}::uuid`;
  await sqlClient`UPDATE app.repos SET owner_github_id=7700 WHERE repo_id=${repoId}::uuid`;
  const viewer = crypto.randomUUID(), serve = crypto.randomUUID();
  await sqlClient`INSERT INTO auth.users(id) VALUES(${viewer}::uuid)`;
  await sqlClient`INSERT INTO app.users(user_id,username) VALUES(${viewer}::uuid,${'repair_' + viewer})`;
  await sqlClient`INSERT INTO telemetry.feed_serves(serve_id,feed_request_id,user_id,session_id,feed_version,source)
    VALUES(${serve}::uuid,${crypto.randomUUID()}::uuid,${viewer}::uuid,${crypto.randomUUID()}::uuid,1,'personalized')`;
  await sqlClient`INSERT INTO telemetry.feed_serve_items(serve_id,position,repo_id,source,summary_id)
    VALUES(${serve}::uuid,0,${repoId}::uuid,'semantic',${original.summary_id}::uuid)`;
  assert.equal(await service.replay(originalJob.outbox_id), false, 'dead-job replay cannot reset delivered jobs');
  const options = { campaignId: 'invalid-summary-regression', execute: false, batchSize: 1,
    summaryBackfill: false, repairInvalidSummaries: true, repositoryIds: [repoId] };
  const dry = await runReindex(options, process.env.DATABASE_URL!);
  assert.equal(dry.eligible, 1);
  assert.equal(dry.invalid_artifacts, 1);
  assert.equal(dry.would_queue, 1);
  const generalBackfill = await runReindex({ ...options, repairInvalidSummaries: false, summaryBackfill: true }, process.env.DATABASE_URL!);
  assert.ok(Number(generalBackfill.eligible) >= 1, 'invalid generated content is not protected by backfill eligibility');
  assert.equal((await runReindex({ ...options, execute: true }, process.env.DATABASE_URL!)).queued, 1);
  assert.equal((await runReindex({ ...options, execute: true }, process.env.DATABASE_URL!)).already_queued, 1);
  assert.equal((await sqlClient`SELECT summary FROM app.repo_card_summaries WHERE summary_id=${original.summary_id}::uuid`)[0].summary, malformed);
  const queued = (await sqlClient`UPDATE telemetry.ml_outbox SET status='claimed',claim_token=${claimToken}::uuid,claimed_at=now()
    WHERE idempotency_key=${`repo_index:${repoId}:2:campaign:${options.campaignId}`} RETURNING *`)[0];
  const fixed = response(String(queued.payload.job_id), 2);
  fixed.card_summary.model_version = model;
  fixed.card_summary.summary = 'Teams can inspect project ownership and coordinate changes. Developers can evaluate shared tooling with concise repository context.';
  assert.equal(await service.completeRepositoryIndex(queued as OutboxRow, fixed), true);
  const revisions = await sqlClient`SELECT * FROM app.repo_card_summaries WHERE repo_id=${repoId}::uuid AND model_version=${model} ORDER BY artifact_revision`;
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0].summary_id, original.summary_id);
  assert.equal(revisions[0].summary, malformed);
  assert.equal(revisions[0].active, false);
  assert.equal(revisions[1].artifact_revision, 1);
  assert.equal(revisions[1].supersedes_summary_id, original.summary_id);
  assert.equal(revisions[1].active, true);
  assert.equal(revisions[1].summary, fixed.card_summary.summary);
  assert.equal((await sqlClient`SELECT summary_id FROM telemetry.feed_serve_items WHERE serve_id=${serve}::uuid`)[0].summary_id, original.summary_id);
  const persisted = (await sqlClient`SELECT response_payload FROM telemetry.ml_outbox WHERE outbox_id=${queued.outbox_id}::uuid`)[0].response_payload.backend_persistence;
  assert.equal(persisted.artifact_status, 'invalid_artifact_replaced');
  assert.equal(persisted.summary_id, revisions[1].summary_id);
  const repeat = await claimedRow(crypto.randomUUID(), crypto.randomUUID(), 2);
  const different = { ...fixed, job_id: String(repeat.payload.job_id), card_summary: { ...fixed.card_summary,
    summary: 'A rebuilt provider proposes different safe wording. The valid first writer must still remain canonical.' } };
  await service.completeRepositoryIndex(repeat, different);
  assert.equal((await sqlClient`SELECT summary_id FROM app.repo_card_summaries WHERE repo_id=${repoId}::uuid AND active`)[0].summary_id, revisions[1].summary_id);
  assert.equal((await runReindex(options, process.env.DATABASE_URL!)).eligible, 0);

  // Concurrent repaired responses produce one successor; the next valid writer is retained.
  await sqlClient`UPDATE app.repo_card_summaries SET summary=${malformed} WHERE summary_id=${revisions[1].summary_id}::uuid`;
  const concurrent = await Promise.all([claimedRow(crypto.randomUUID(), crypto.randomUUID(), 2), claimedRow(crypto.randomUUID(), crypto.randomUUID(), 2)]);
  await Promise.all(concurrent.map(row => service.completeRepositoryIndex(row, { ...fixed, job_id: String(row.payload.job_id) })));
  const after = await sqlClient`SELECT artifact_revision,active FROM app.repo_card_summaries WHERE repo_id=${repoId}::uuid AND model_version=${model} ORDER BY artifact_revision`;
  assert.deepEqual(after.map(row => [row.artifact_revision,row.active]), [[0,false],[1,false],[2,true]]);
});

integration('fallback preservation rejects malformed generated rows and migration reapply preserves revisions', async () => {
  const service = new OutboxService();
  const old = (await sqlClient`SELECT summary_id FROM app.repo_card_summaries WHERE repo_id=${repoId}::uuid AND active`)[0];
  await sqlClient`UPDATE app.repo_card_summaries SET summary='GPL. Teams can redistribute the software.' WHERE summary_id=${old.summary_id}::uuid`;
  const job = await claimedRow(crypto.randomUUID(), crypto.randomUUID(), 2);
  const fallback = response(String(job.payload.job_id), 2);
  fallback.card_summary.source = 'description_fallback';
  fallback.card_summary.model_version = 'repository-description-fallback-v1';
  await service.completeRepositoryIndex(job, fallback);
  assert.equal((await sqlClient`SELECT source FROM app.repo_card_summaries WHERE repo_id=${repoId}::uuid AND active`)[0].source, 'description_fallback');
  assert.equal((await sqlClient`SELECT active FROM app.repo_card_summaries WHERE summary_id=${old.summary_id}::uuid`)[0].active, false);
  const { readFileSync } = await import('node:fs');
  const migration = readFileSync(new URL('../../../database/migrations/0027_summary_artifact_revisions.sql', import.meta.url), 'utf8');
  await sqlClient.unsafe(migration).simple();
  await sqlClient.unsafe(migration).simple();
  const names = await sqlClient`SELECT indexname FROM pg_indexes WHERE schemaname='app' AND indexname IN ('repo_card_summaries_versioned_uidx','repo_card_summaries_revisioned_uidx')`;
  assert.deepEqual(names.map(row => row.indexname), ['repo_card_summaries_revisioned_uidx']);
  assert.equal(Number((await sqlClient`SELECT count(*) AS n FROM app.repo_card_summaries WHERE repo_id=${repoId}::uuid AND model_version='accepted-malformed-model'`)[0].n), 3);
});

integration('canonical ingestion skips unchanged tuples and deduplicates only equivalent observations', async () => {
  assertDisposableDatabase();
  const persistence = new PostgresRepositoryPersistence();
  const record = {
    github_id: '77101', owner_github_id: '77102', full_name: 'noop-fixture/repository',
    owner: 'noop-fixture', name: 'repository', url: 'https://github.com/noop-fixture/repository',
    description: 'Canonical prose.', readme: '# Canonical\n' + 'Detailed source prose. '.repeat(12), topics: [' Systems ', 'SYSTEMS'],
    observed_at: '2026-10-21T00:00:00Z', pushed_at: '2026-10-20T00:00:00Z', star_count: 1,
  };
  const [first] = await persistence.bulkUpsert([record]);
  const tuples = async () => (await sqlClient`
    SELECT repo.xmin::text AS repo_tuple,repo.updated_at AS repo_updated_at,
      content.xmin::text AS content_tuple,content.updated_at,
      content.content_hash,content.content_version,content.source_updated_at,
      ARRAY(SELECT link.ctid::text FROM app.repo_topics link WHERE link.repo_id=repo.repo_id ORDER BY topic_id) AS topics
    FROM app.repos repo JOIN app.repo_content content USING(repo_id)
    WHERE repo.repo_id=${first.repo_id}::uuid
  `)[0];
  const before = await tuples();
  const [replayed] = await persistence.bulkUpsert([{ ...record, topics: ['systems'] }]);
  assert.equal(replayed.changed, false);
  assert.deepEqual(await tuples(), before, 'same content and source recency must not rewrite identity/content/topic tuples');
  const jobs = async () => await sqlClient`
    SELECT job_type,payload FROM telemetry.ml_outbox WHERE aggregate_id=${first.repo_id}::uuid
  `;
  assert.equal((await jobs()).length, 2, 'one index plus one versioned observation, unchanged on replay');
  assert.ok((await jobs()).filter(row => row.job_type === 'repo_refresh')
    .every(row => row.payload.required_content_version === first.content_version));
  await sqlClient`DELETE FROM telemetry.readme_summary_jobs WHERE repo_id=${first.repo_id}::uuid`;
  await persistence.bulkUpsert([record]);
  assert.equal(Number((await sqlClient`SELECT count(*) AS n FROM telemetry.readme_summary_jobs
    WHERE repo_id=${first.repo_id}::uuid`)[0].n), 1, 'unchanged content still repairs missing README work');

  const statsOnly = { ...record, topics: ['systems'], star_count: 2, observed_at: '2026-10-21T01:00:00Z' };
  const [stats] = await persistence.bulkUpsert([statsOnly]);
  assert.equal(stats.changed, false);
  assert.equal(stats.content_version, first.content_version);
  assert.deepEqual(await tuples(), before);
  assert.equal(Number((await sqlClient`SELECT count(*) AS n FROM app.repo_stat_snapshots
    WHERE repo_id=${first.repo_id}::uuid`)[0].n), 2);

  const sourceOnly = { ...statsOnly, pushed_at: '2026-10-21T00:00:00Z', observed_at: '2026-10-21T02:00:00Z' };
  const [source] = await persistence.bulkUpsert([sourceOnly]);
  const sourceTuple = await tuples();
  assert.equal(source.changed, false);
  assert.equal(sourceTuple.content_hash, before.content_hash);
  assert.deepEqual(sourceTuple.updated_at, before.updated_at, 'source recency does not impersonate canonical content change');
  assert.deepEqual(sourceTuple.topics, before.topics);
  assert.equal(new Date(sourceTuple.source_updated_at).toISOString(), '2026-10-21T00:00:00.000Z');

  const snapshot = { snapshot_id: crypto.randomUUID(), period: 'noop-fixture', source: 'fixture',
    computed_at: sourceOnly.observed_at, repositories: [{ ...sourceOnly, rank: 0 }] };
  const beforeSnapshotJobs = (await jobs()).length;
  await persistence.recordTrendingSnapshot(snapshot);
  assert.equal((await jobs()).length, beforeSnapshotJobs, 'equal normalized patch and timestamp share one authoritative refresh');
  await persistence.recordTrendingSnapshot({ ...snapshot, snapshot_id: crypto.randomUUID(),
    computed_at: '2026-10-21T03:00:00Z' });
  assert.equal((await jobs()).length, beforeSnapshotJobs + 1, 'a distinct computed-at observation must be retained');

  const [topicChange] = await persistence.bulkUpsert([{ ...sourceOnly, topics: ['api'], observed_at: '2026-10-21T04:00:00Z' }]);
  assert.equal(topicChange.changed, true);
  assert.equal(topicChange.content_version, first.content_version + 1);
  assert.deepEqual((await sqlClient`SELECT slug FROM app.topics topic JOIN app.repo_topics link USING(topic_id)
    WHERE link.repo_id=${first.repo_id}::uuid`).map(row => String(row.slug)), ['api']);
  await sqlClient`UPDATE app.repos SET updated_at='2000-01-01T00:00:00Z' WHERE repo_id=${first.repo_id}::uuid`;
  const [contentChange] = await persistence.bulkUpsert([{ ...sourceOnly, topics: ['api'],
    description: 'Changed prose.', observed_at: '2026-10-21T05:00:00Z' }]);
  assert.equal(contentChange.content_version, topicChange.content_version + 1);
  assert.ok(new Date((await tuples()).repo_updated_at).getTime() > Date.parse('2000-01-01T00:00:00Z'),
    'real prose changes advance the repository date exposed by feed/followed readers');
});

integration('refresh tracks the locked content version despite tied or inverted transaction timestamps', async () => {
  assertDisposableDatabase();
  const outbox = new OutboxService();
  for (const indexCreatedAt of ['2026-10-21T00:00:00Z', '2026-10-21T01:00:00Z']) {
    const aggregateId = crypto.randomUUID();
    const olderIndexId = crypto.randomUUID(), newerIndexId = crypto.randomUUID(), refreshId = crypto.randomUUID();
    try {
      await sqlClient`INSERT INTO telemetry.ml_outbox(outbox_id,job_type,aggregate_id,idempotency_key,payload,status,created_at) VALUES
        (${olderIndexId}::uuid,'repo_index',${aggregateId}::uuid,${olderIndexId},'{"content_version":1}'::jsonb,'delivered','2026-10-20T00:00:00Z'),
        (${newerIndexId}::uuid,'repo_index',${aggregateId}::uuid,${newerIndexId},'{"content_version":2}'::jsonb,'pending',${indexCreatedAt}::timestamptz),
        (${refreshId}::uuid,'repo_refresh',${aggregateId}::uuid,${refreshId},'{"feature_version":1,"required_content_version":2}'::jsonb,'pending','2026-10-21T00:00:00Z')`;
      const claimed = await outbox.claim(1000);
      assert.equal(claimed.some(row => row.outbox_id === refreshId), false);
      const newer = claimed.find(row => row.outbox_id === newerIndexId);
      assert.ok(newer, 'the required index must be delivered first, regardless of transaction timestamps');
      await outbox.markDelivered(newer);
      assert.equal((await outbox.claim(1000)).some(row => row.outbox_id === refreshId), true);
    } finally {
      await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${aggregateId}::uuid`;
    }
  }
});

integration('refresh metadata and delivered-index comparisons fail closed outside positive int32 versions', async () => {
  assertDisposableDatabase();
  const outbox = new OutboxService();
  const invalid = ['0', '-1', '01', '1.5', '2147483648', '9'.repeat(140_000), null, undefined];
  const cases = [
    ...invalid.map(version => ({ required: version, delivered: '2147483647', released: false })),
    ...invalid.map(version => ({ required: '1', delivered: version, released: false })),
    { required: '2', delivered: '1', released: false },
    { required: '1', delivered: '2147483647', released: true },
    { required: '2147483647', delivered: '2147483647', released: true },
  ];
  for (const { required, delivered, released } of cases) {
    const aggregateId = crypto.randomUUID(), refreshId = crypto.randomUUID(), indexId = crypto.randomUUID();
    try {
      await sqlClient`INSERT INTO telemetry.ml_outbox(outbox_id,job_type,aggregate_id,idempotency_key,payload,status) VALUES
        (${indexId}::uuid,'repo_index',${aggregateId}::uuid,${indexId},
          ${JSON.stringify({ content_version: delivered })}::text::jsonb,'delivered'),
        (${refreshId}::uuid,'repo_refresh',${aggregateId}::uuid,${refreshId},
          ${JSON.stringify({ feature_version: 1, required_content_version: required })}::text::jsonb,'pending')`;
      assert.equal((await outbox.claim(1000)).some(row => row.outbox_id === refreshId), released,
        'only bounded positive int32 index witnesses can discharge bounded positive int32 requirements');
    } finally {
      await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${aggregateId}::uuid`;
    }
  }
});

integration('legacy refreshes require the current canonical version, not any old delivered index', async () => {
  assertDisposableDatabase();
  const outbox = new OutboxService(), aggregateId = crypto.randomUUID(), refreshId = crypto.randomUUID();
  const olderIndexId = crypto.randomUUID(), newerIndexId = crypto.randomUUID();
  try {
    await sqlClient`INSERT INTO app.repos(repo_id,github_id,owner_github_id,full_name,owner,name,url)
      VALUES (${aggregateId}::uuid,77111,77112,'legacy-refresh-fixture/repo','legacy-refresh-fixture','repo','https://github.com/legacy-refresh-fixture/repo')`;
    await sqlClient`INSERT INTO app.repo_content(repo_id,content_hash,content_version)
      VALUES (${aggregateId}::uuid,'legacy-refresh-v2',2)`;
    await sqlClient`INSERT INTO telemetry.ml_outbox(outbox_id,job_type,aggregate_id,idempotency_key,payload,status) VALUES
      (${olderIndexId}::uuid,'repo_index',${aggregateId}::uuid,${olderIndexId},'{"content_version":1}'::jsonb,'delivered'),
      (${newerIndexId}::uuid,'repo_index',${aggregateId}::uuid,${newerIndexId},'{"content_version":2}'::jsonb,'pending'),
      (${refreshId}::uuid,'repo_refresh',${aggregateId}::uuid,${refreshId},'{"feature_version":1}'::jsonb,'pending')`;
    const claimed = await outbox.claim(1000);
    assert.equal(claimed.some(row => row.outbox_id === refreshId), false);
    await outbox.markDelivered(claimed.find(row => row.outbox_id === newerIndexId)!);
    assert.equal((await outbox.claim(1000)).some(row => row.outbox_id === refreshId), true);
  } finally {
    await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${aggregateId}::uuid`;
    await sqlClient`DELETE FROM app.repos WHERE repo_id=${aggregateId}::uuid`;
  }
});


integration('bounded digest processing improves ready latency while retaining real SQL lease and publication ownership',async t=>{
  assertDisposableDatabase();
  const url=new URL(process.env.README_SUMMARY_TEST_DATABASE_URL??'');
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/weave_scroll');
  assert.equal(url.toString(),new URL(process.env.DATABASE_URL!).toString());
  const db=postgres(url.toString(),{max:4,prepare:false}),ids=Array.from({length:6},()=>crypto.randomUUID());
  try {
    for(const [index,id] of ids.entries()){
      const name=`worker-pool-${index}`,githubId=String(BigInt(Date.now())*100n+BigInt(index));
      await db`INSERT INTO app.repos(repo_id,github_id,full_name,owner,name,url)
        VALUES(${id}::uuid,${githubId}::bigint,${'test/'+name},'test',${name},${'https://github.com/test/'+name})`;
      await db`INSERT INTO app.repo_content(repo_id,content_hash,content_version,readme)
        VALUES(${id}::uuid,'pool-v1',1,${'Canonical source document. '.repeat(30)})`;
    }
    for(const concurrency of [1,2]){
      let active=0,maximum=0;const ready:{id:string;milliseconds:number}[]=[];
      const service=new ReadmeSummaryService({modelVersion:'pool-test',async generate(source){
        active++;maximum=Math.max(maximum,active);
        try {await delay(source.full_name.endsWith('-0')?120:20);return digestFixture;}
        finally {active--;}
      }},db);
      await service.enqueueMissing(ids,concurrency===2);
      if(concurrency===1){
        const first=await service.claim([ids[0]]);assert.ok(first);
        assert.equal(await service.complete({...first,claim_token:crypto.randomUUID()},digestFixture),false);
        await db`UPDATE telemetry.readme_summary_jobs SET claimed_at=now()-interval '6 minutes' WHERE job_id=${first.job_id}::uuid`;
        const recovered=await service.claim([ids[0]]);assert.ok(recovered);assert.notEqual(recovered.claim_token,first.claim_token);
        assert.equal(await service.complete(first,digestFixture),false,'expired owner cannot publish after recovery');
        assert.equal(await service.complete(recovered,digestFixture),true);
        assert.equal(await service.complete(recovered,digestFixture),false,'completion replay cannot publish twice');
        await service.enqueueMissing(ids,true);
      }
      await db`UPDATE telemetry.readme_summary_jobs job SET created_at=now()-interval '1 hour'+ordered.ordinal*interval '1 millisecond'
        FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS ordered(repo_id,ordinal) WHERE job.repo_id=ordered.repo_id`;
      const started=performance.now();
      const observe=(result:Awaited<ReturnType<ReadmeSummaryService['processOne']>>)=>{
        assert.equal(result.status,'completed');ready.push({id:result.repo_id!,milliseconds:performance.now()-started});
      };
      if(concurrency===1){for(let count=0;count<ids.length;count++)observe(await service.processOne(ids));}
      else assert.deepEqual(await runReadmeSummaryWorker(service,{limit:ids.length,concurrency,once:true,repoIds:ids,onResult:observe}),{processed:6,failures:0});
      t.diagnostic(JSON.stringify({concurrency,milliseconds:Math.round((performance.now()-started)*100)/100,
        secondRepositoryReadyMs:Math.round(ready.find(value=>value.id===ids[1])!.milliseconds*100)/100,maximumProviders:maximum}));
      assert.equal(maximum,concurrency);assert.equal(new Set(ready.map(value=>value.id)).size,ids.length);
      if(concurrency===2)assert.notEqual(ready[0].id,ids[0],'the slow first provider must not hold every later digest');
      const artifacts=await db`SELECT repo_id FROM app.repo_readme_summaries WHERE repo_id=ANY(${ids}::uuid[]) AND active`;
      assert.equal(artifacts.length,ids.length);assert.equal(new Set(artifacts.map(row=>row.repo_id)).size,ids.length);
      assert.equal(Number((await db`SELECT count(*) FROM telemetry.readme_summary_jobs WHERE repo_id=ANY(${ids}::uuid[]) AND status='claimed'`)[0].count),0);
    }
    const verifier=new ReadmeSummaryService({modelVersion:'pool-test',async generate(){return digestFixture;}},db);
    await verifier.enqueueMissing([ids[0]],true);
    const stale=await verifier.claim([ids[0]]);assert.ok(stale);
    await db`UPDATE app.repo_content SET content_version=2,content_hash='pool-v2' WHERE repo_id=${ids[0]}::uuid`;
    assert.equal(await verifier.complete(stale,digestFixture),false,'an edit during generation prevents stale publication');
    assert.equal((await getReadmeSummaryStatus(ids[0],db))?.summary,null);
  } finally {await db`DELETE FROM app.repos WHERE repo_id=ANY(${ids}::uuid[])`;await db.end({timeout:1});}
});
