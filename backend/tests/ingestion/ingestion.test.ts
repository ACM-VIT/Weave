import assert from 'node:assert/strict';
import test from 'node:test';

import type { RepositoryUpsert, RepositoryUpsertResult, TrendingSnapshotInput } from '../../contracts/ingestion.v2.js';
import type { RepositoryPersistencePort } from '../../ports/repositoryPersistencePort.js';
import { IngestionService } from '../../services/ingestionService.js';
import { isRepositoryUpsert } from '../../utils/ingestionValidation.js';

class FakeRepoPersistence implements RepositoryPersistencePort {
  async bulkUpsert(input: RepositoryUpsert[]): Promise<RepositoryUpsertResult[]> {
    return input.map((repo) => ({ github_id: repo.github_id, repo_id: '00000000-0000-4000-8000-000000000001', content_version: 1, changed: true }));
  }
  async recordTrendingSnapshot(input: TrendingSnapshotInput) {
    return { snapshot_id: input.snapshot_id, repository_count: input.repositories.length, activated_at: new Date(0).toISOString() };
  }
}

test('ingestion returns canonical mappings keyed by GitHub numeric ID', async () => {
  const service = new IngestionService(new FakeRepoPersistence());
  const results = await service.bulkUpsert([{ github_id: '123', full_name: 'old/name', owner: 'old', name: 'name',
    url: 'https://github.com/old/name', observed_at: new Date(0).toISOString() }]);
  assert.equal(results[0].github_id, '123');
  assert.match(results[0].repo_id, /^[0-9a-f-]{36}$/);
});

test('ingestion rejects optional values that would deterministically fail DB or strict ML validation', () => {
  const valid = {
    github_id: '123', full_name: 'owner/name', owner: 'owner', name: 'name',
    url: 'https://github.com/owner/name', observed_at: '2026-07-21T00:00:00.000Z',
    description: null, readme: null, primary_language: null,
    languages: ['TypeScript'], topics: ['recommendations'],
    star_count: 1, fork_count: 0, open_issues_count: 0,
    pushed_at: '2026-07-20T00:00:00+05:30', recent_commits: ['2026-07-19T00:00:00Z'],
  };
  assert.equal(isRepositoryUpsert(valid), true);
  assert.equal(isRepositoryUpsert({ ...valid, star_count: -1 }), false);
  assert.equal(isRepositoryUpsert({ ...valid, topics: [''] }), false);
  assert.equal(isRepositoryUpsert({ ...valid, pushed_at: 'not-a-date' }), false);
  assert.equal(isRepositoryUpsert({ ...valid, description: 42 }), false);
  assert.equal(isRepositoryUpsert({ ...valid, readme: 'x'.repeat(1_000_001) }), false);
  assert.equal(isRepositoryUpsert({ ...valid, full_name: 'owner /name' }), false);
});
