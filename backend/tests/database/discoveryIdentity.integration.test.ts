import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import type { RepositoryUpsert } from '../../contracts/ingestion.v2.js';
import { sqlClient } from '../../db/index.js';
import { PostgresRepositoryPersistence } from '../../adapters/postgresRepositoryPersistence.js';
import { assertDisposableDatabase } from './disposableDatabase.js';
const enabled = process.env.RUN_DATABASE_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();
test.after(async () => { if (enabled) await sqlClient.end({ timeout: 1 }); });

test('public discovery skips reused stale names without replacing rich canonical content', { skip: !enabled }, async () => {
  const base = BigInt(crypto.randomInt(1_000_000_000,2_000_000_000))*10n;
  const githubIds = [base,base+1n,base+2n].map(String);
  const owner = `discover-${base}`, ownerId = String(base+3n);
  const repository = (id: string, name: string): RepositoryUpsert => ({
    github_id: id, owner_github_id: ownerId, full_name: `${owner}/${name}`, owner, name,
    url: `https://github.com/${owner}/${name}`, observed_at: '2026-10-23T00:00:00Z',
    description: 'Canonical rich description', readme: '# Canonical rich Markdown', topics: ['testing'],
  });
  const persistence = new PostgresRepositoryPersistence();
  try {
    const [known] = await persistence.bulkUpsert([repository(githubIds[0],'original')]);
    const original = (await sqlClient`SELECT r.full_name,c.content_hash,c.content_version,c.description,c.readme
      FROM app.repos r JOIN app.repo_content c USING(repo_id) WHERE repo_id=${known.repo_id}::uuid`)[0];
    const discovered = [repository(githubIds[0],'renamed'),repository(githubIds[1],'ORIGINAL'),repository(githubIds[2],'independent')]
      .map(repo => ({ ...repo, readme: null, description: 'Public discovery metadata' }));
    const created = await persistence.registerDiscoveredRepositories(discovered);
    assert.deepEqual(created.map(repo => repo.github_id), [githubIds[2]], 'occupied names must be deferred to canonical ingestion');
    assert.deepEqual((await sqlClient`SELECT r.full_name,c.content_hash,c.content_version,c.description,c.readme
      FROM app.repos r JOIN app.repo_content c USING(repo_id) WHERE repo_id=${known.repo_id}::uuid`)[0], original);
    assert.equal((await sqlClient`SELECT repo_id FROM app.repos WHERE github_id=${githubIds[1]}::bigint`).length,0);
  } finally {
    await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id IN (SELECT repo_id FROM app.repos WHERE github_id=ANY(${githubIds}::bigint[]))`;
    await sqlClient`DELETE FROM app.repos WHERE github_id=ANY(${githubIds}::bigint[])`;
    await sqlClient`DELETE FROM app.social_profiles WHERE provider='github' AND provider_subject=${ownerId}`;
  }
});
