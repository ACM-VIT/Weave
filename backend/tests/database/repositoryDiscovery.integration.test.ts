import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { assertDisposableDatabase } from './disposableDatabase.js';
import type { RepositoryUpsert } from '../../contracts/ingestion.v2.js';

const enabled = process.env.RUN_DATABASE_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();
const integration = enabled ? test : test.skip;

integration('create-only graph discovery preserves rich content and races safely with canonical ingestion', async () => {
  const [{ sqlClient }, { PostgresRepositoryPersistence }] = await Promise.all([
    import('../../db/index.js'), import('../../adapters/postgresRepositoryPersistence.js'),
  ]);
  const persistence = new PostgresRepositoryPersistence();
  const githubIds = Array.from({ length: 3 }, () => String(crypto.randomInt(1_000_000_000, 2_000_000_000)));
  const ownerId = String(crypto.randomInt(2_000_000_000, 3_000_000_000));
  const owner = `discovery-${ownerId}`;
  const record = (id: string): RepositoryUpsert => ({ github_id: id, owner_github_id: ownerId,
    owner, name: `repo-${id}`, full_name: `${owner}/repo-${id}`, url: `https://github.com/${owner}/repo-${id}`,
    description: 'Source-provided description', primary_language: 'TypeScript', topics: ['testing'],
    star_count: 17, fork_count: 3, open_issues_count: 2, observed_at: new Date().toISOString(),
  });
  try {
    const rich = { ...record(githubIds[0]), readme: '# Canonical Markdown\n\n![original](docs/diagram.png)',
      readme_source_path: 'README.md', readme_default_branch: 'main',
      readme_base_url: `https://raw.githubusercontent.com/${owner}/repo-${githubIds[0]}/refs/heads/main/` };
    const [original] = await persistence.bulkUpsert([rich]);
    const created = await persistence.registerDiscoveredRepositories([record(githubIds[0]), record(githubIds[1])]);
    assert.equal(created.length, 1);
    assert.equal(created[0].github_id, githubIds[1]);
    assert.match(created[0].repo_id, /^[0-9a-f-]{36}$/);
    const [content] = await sqlClient`SELECT readme,content_version,readme_source_path FROM app.repo_content WHERE repo_id=${original.repo_id}::uuid`;
    assert.equal(content.readme, rich.readme);
    assert.equal(content.readme_source_path, 'README.md');
    assert.equal(Number(content.content_version), original.content_version);
    const [job] = await sqlClient`SELECT payload FROM telemetry.ml_outbox WHERE aggregate_id=${created[0].repo_id}::uuid AND job_type='repo_index'`;
    assert.equal(job.payload.repo_id, created[0].repo_id);
    assert.equal(job.payload.repository.github_id, githubIds[1]);
    assert.equal(job.payload.repository.readme ?? null, null, 'unknown README is not fabricated');
    const [observed] = await sqlClient`SELECT star_count,fork_count,open_issues_count FROM app.repo_stat_snapshots WHERE repo_id=${created[0].repo_id}::uuid`;
    assert.deepEqual([Number(observed.star_count), Number(observed.fork_count), Number(observed.open_issues_count)], [17, 3, 2]);
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => persistence.registerDiscoveredRepositories([record(githubIds[2])])));
    assert.equal(concurrent.reduce((sum, rows) => sum + rows.length, 0), 1);
    await Promise.all([
      persistence.registerDiscoveredRepositories([record(githubIds[2])]),
      persistence.bulkUpsert([{ ...record(githubIds[2]), readme: '# Real enriched content' }]),
    ]);
    const [final] = await sqlClient`SELECT content.readme FROM app.repos repo JOIN app.repo_content content USING(repo_id) WHERE github_id=${githubIds[2]}::bigint`;
    assert.equal(final.readme, '# Real enriched content');
    assert.equal(Number((await sqlClient`SELECT count(*) FROM app.repos WHERE github_id=${githubIds[2]}::bigint`)[0].count), 1);
    const [versions] = await sqlClient`SELECT count(*) FROM telemetry.ml_outbox job JOIN app.repos repo ON job.aggregate_id=repo.repo_id WHERE repo.github_id=${githubIds[2]}::bigint AND job.job_type='repo_index'`;
    assert.equal(Number(versions.count), 2, 'one initial index and one real enrichment version');
  } finally {
    await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id IN (SELECT repo_id FROM app.repos WHERE github_id=ANY(${githubIds}::bigint[]))`;
    await sqlClient`DELETE FROM app.repos WHERE github_id=ANY(${githubIds}::bigint[])`;
    await sqlClient`DELETE FROM app.social_profiles WHERE provider='github' AND provider_subject=${ownerId}`;
    await sqlClient.end({ timeout: 1 });
  }
});
