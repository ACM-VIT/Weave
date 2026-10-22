import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCampaignRepositoryJob,
  campaignIdempotencyKey,
  parseReindexOptions,
} from '../../scripts/reindex-active-repositories.js';

test('reindex campaign is dry-run by default and execute requires the same explicit campaign', () => {
  assert.deepEqual(parseReindexOptions(['--campaign=v2-strict-20260721']), {
    campaignId: 'v2-strict-20260721', execute: false, batchSize: 100, summaryBackfill: false,
  });
  assert.deepEqual(parseReindexOptions([
    '--campaign=v2-strict-20260721', '--execute', '--batch-size=25', '--summary-backfill',
  ]), {
    campaignId: 'v2-strict-20260721', execute: true, batchSize: 25, summaryBackfill: true,
  });
  assert.throws(() => parseReindexOptions(['--execute']), /--campaign/);
  assert.throws(() => parseReindexOptions(['--campaign=unsafe campaign']), /--campaign/);
  assert.throws(() => parseReindexOptions(['--campaign=safe', '--unknown']), /Unknown argument/);
});

test('campaign reindex preserves canonical identity/version and builds a fresh scoped key', () => {
  const job = buildCampaignRepositoryJob({
    repo_id: '00000000-0000-4000-8000-000000000001',
    github_id: '123',
    owner_github_id: '456',
    full_name: 'owner/repository',
    url: 'https://github.com/owner/repository',
    description: null,
    readme: 'README',
    readme_source_path: 'docs/README.md',
    readme_default_branch: 'main',
    readme_base_url: 'https://raw.githubusercontent.com/owner/repository/refs/heads/main/docs/',
    primary_language: null,
    languages: ['TypeScript'],
    topics: ['recommendations'],
    content_hash: 'canonical-content-hash',
    content_version: 7,
    source_updated_at: '2026-07-21T08:30:00+05:30',
    star_count: 10,
    fork_count: 2,
    open_issues_count: 1,
    observed_at: '2026-07-21T09:00:00.000Z',
  }, '00000000-0000-4000-8000-000000000002');
  assert.ok(job);
  assert.equal(job.content_version, 7);
  assert.equal(job.repository.content_hash, 'canonical-content-hash');
  assert.equal(job.repository.readme_source_path, 'docs/README.md');
  assert.equal(job.repository.readme_default_branch, 'main');
  assert.equal(job.repository.readme_base_url, 'https://raw.githubusercontent.com/owner/repository/refs/heads/main/docs/');
  assert.equal(job.repository.pushed_at, '2026-07-21T03:00:00.000Z');
  assert.equal(Object.hasOwn(job.repository, 'repo_id'), false);
  assert.equal(
    campaignIdempotencyKey('v2-strict-20260721', job.repo_id, job.content_version),
    'repo_index:00000000-0000-4000-8000-000000000001:7:campaign:v2-strict-20260721',
  );
});

test('invalid-summary repair is read-only by default and execution requires explicit repository scope', () => {
  assert.deepEqual(parseReindexOptions(['--campaign=repair-contract-v1', '--repair-invalid-summaries']), {
    campaignId: 'repair-contract-v1', execute: false, batchSize: 100, summaryBackfill: false, repairInvalidSummaries: true,
  });
  assert.throws(() => parseReindexOptions(['--campaign=repair-contract-v1', '--repair-invalid-summaries', '--execute']), /--repo-id/);
  const scoped = parseReindexOptions(['--campaign=repair-contract-v1', '--repair-invalid-summaries', '--execute',
    '--repo-id=00000000-0000-4000-8000-000000000701']);
  assert.equal(scoped.execute, true);
  assert.deepEqual(scoped.repositoryIds, ['00000000-0000-4000-8000-000000000701']);
  assert.throws(() => parseReindexOptions(['--campaign=repair-contract-v1', '--repair-invalid-summaries', '--summary-backfill']), /Choose/);
  assert.throws(() => parseReindexOptions(['--campaign=repair-contract-v1', '--repair-invalid-summaries', '--repo-id=invalid']), /canonical UUID/);
});
