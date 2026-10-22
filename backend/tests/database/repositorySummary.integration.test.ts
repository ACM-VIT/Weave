import assert from 'node:assert/strict';
import test from 'node:test';

import type { MlRepositoryIndexResponse } from '../../contracts/ml.v2.js';
import { sqlClient } from '../../db/index.js';
import { OutboxService, type OutboxRow } from '../../services/outboxService.js';

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

});
