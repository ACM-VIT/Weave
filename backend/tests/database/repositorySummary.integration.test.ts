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
