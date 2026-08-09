import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const integration = process.env.RUN_REPOSITORY_SUMMARY_MIGRATION_INTEGRATION === '1'
  ? test
  : test.skip;
const migration = fs.readFileSync(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../database/migrations/0024_repository_summary_artifacts.sql',
), 'utf8');

async function applyMigration(client: postgres.Sql): Promise<void> {
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) await client.unsafe(statement).simple();
  }
}

integration('repository-summary migration normalizes partial state and is safe to reapply', async () => {
  const databaseUrl = process.env.REPOSITORY_SUMMARY_MIGRATION_DATABASE_URL
    ?? process.env.DATABASE_URL;
  assert.ok(databaseUrl, 'An isolated migration integration DATABASE_URL is required.');
  const parsed = new URL(databaseUrl);
  assert.ok(
    ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname),
    'Repository-summary migration integration is destructive and must use isolated local PostgreSQL.',
  );
  const client = postgres(databaseUrl, { max: 1, prepare: false });
  const repoId = crypto.randomUUID();
  try {
    await client`DROP SCHEMA IF EXISTS app CASCADE`;
    await client`DROP SCHEMA IF EXISTS telemetry CASCADE`;
    await client`CREATE SCHEMA app`;
    await client`CREATE SCHEMA telemetry`;
    await client.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ghsocial_backend') THEN
          CREATE ROLE ghsocial_backend;
        END IF;
      END $$
    `).simple();
    await client.unsafe(`
      CREATE TABLE app.repo_content (
        repo_id uuid PRIMARY KEY,
        readme text,
        content_hash text NOT NULL,
        content_version integer NOT NULL,
        readme_source_path text,
        readme_default_branch text,
        readme_base_url text
      )
    `).simple();
    await client.unsafe(`
      CREATE TABLE app.repo_card_summaries (
        summary_id uuid PRIMARY KEY,
        repo_id uuid NOT NULL,
        content_version integer NOT NULL,
        prompt_version text,
        model_version text NOT NULL,
        format_version text,
        summary text NOT NULL,
        highlights jsonb,
        source text,
        active boolean NOT NULL DEFAULT false
      )
    `).simple();
    await client.unsafe(`CREATE TABLE telemetry.ml_outbox (outbox_id uuid PRIMARY KEY)`).simple();
    await client`
      INSERT INTO app.repo_content (
        repo_id,readme,content_hash,content_version,readme_source_path,
        readme_default_branch,readme_base_url
      ) VALUES (
        ${repoId}::uuid,'# Canonical README\n\n![Image](./image.png)','precomputed-hash',1,
        '../README.md','feature\\unsafe',
        'https://raw.githubusercontent.com/owner/repo/main/'
      )
    `;
    await client`
      INSERT INTO app.repo_card_summaries (
        summary_id,repo_id,content_version,prompt_version,model_version,
        format_version,summary,highlights,source,active
      ) VALUES
        (${crypto.randomUUID()}::uuid,${repoId}::uuid,1,'legacy-prompt','legacy-model',
          'legacy-format','Legacy active summary. It must become inactive.','[]'::jsonb,'legacy',true),
        (${crypto.randomUUID()}::uuid,${repoId}::uuid,1,'long-prompt','long-model',
          'long-format',${'x'.repeat(361)},'[]'::jsonb,'generated',true),
        (${crypto.randomUUID()}::uuid,${repoId}::uuid,1,NULL,'partial-model',
          NULL,'Partially provisioned summary. It must normalize safely.','{"bad":true}'::jsonb,'generated',true),
        (${crypto.randomUUID()}::uuid,${repoId}::uuid,1,'valid-prompt','valid-model',
          'valid-format','A valid generated summary. It remains versioned and bounded.','[]'::jsonb,'generated',false)
    `;

    await assert.rejects(
      applyMigration(client),
      /repo_content_readme_metadata_check/,
      'unsafe pre-provisioned metadata must stop migration for explicit operator repair',
    );
    await client`
      UPDATE app.repo_content
      SET readme_source_path='docs/README.md',readme_default_branch='main',
        readme_base_url='https://raw.githubusercontent.com/owner/repo/refs/heads/main/docs/'
      WHERE repo_id=${repoId}::uuid
    `;
    await applyMigration(client);
    await applyMigration(client);

    const content = (await client`
      SELECT readme,content_hash,readme_source_path,readme_default_branch,readme_base_url
      FROM app.repo_content WHERE repo_id=${repoId}::uuid
    `)[0];
    assert.equal(String(content.readme), '# Canonical README\n\n![Image](./image.png)');
    assert.equal(String(content.content_hash), 'precomputed-hash');
    assert.equal(String(content.readme_source_path), 'docs/README.md');
    assert.equal(String(content.readme_default_branch), 'main');
    assert.equal(
      String(content.readme_base_url),
      'https://raw.githubusercontent.com/owner/repo/refs/heads/main/docs/',
    );

    const normalized = await client`
      SELECT prompt_version,model_version,format_version,highlights,source,active
      FROM app.repo_card_summaries WHERE repo_id=${repoId}::uuid
      ORDER BY model_version
    `;
    const legacyRows = normalized.filter((row) => row.source === 'legacy');
    assert.equal(legacyRows.length, 3);
    assert.ok(legacyRows.every((row) => row.active === false));
    const partial = normalized.find((row) => row.model_version === 'partial-model');
    assert.deepEqual(partial?.highlights, []);
    assert.equal(partial?.prompt_version, 'legacy-unversioned');
    assert.equal(partial?.format_version, 'legacy-unversioned');

    await assert.rejects(client`
      INSERT INTO app.repo_card_summaries (
        summary_id,repo_id,content_version,prompt_version,model_version,
        format_version,summary,highlights,source,active
      ) VALUES (
        ${crypto.randomUUID()}::uuid,${repoId}::uuid,1,'valid-prompt','valid-model',
        'valid-format','Another summary. It must violate tuple uniqueness.',
        '[]'::jsonb,'generated',false
      )
    `, /repo_card_summaries_versioned_uidx/);
    const grant = (await client`
      SELECT has_column_privilege(
        'ghsocial_backend','telemetry.ml_outbox','response_payload','UPDATE'
      ) AS allowed
    `)[0];
    assert.equal(grant.allowed, true);
  } finally {
    await client`DROP SCHEMA IF EXISTS app CASCADE`;
    await client`DROP SCHEMA IF EXISTS telemetry CASCADE`;
    await client.end({ timeout: 1 });
  }
});
