import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const migration = fs.readFileSync(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../database/migrations/0024_repository_summary_artifacts.sql',
), 'utf8');
const schemaAudit = fs.readFileSync(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/schema-audit.ts',
), 'utf8');

test('repository-summary migration preserves canonical README metadata and durable ML responses', () => {
  for (const column of [
    'readme_source_path',
    'readme_default_branch',
    'readme_base_url',
    'prompt_version',
    'format_version',
    'highlights',
    'source',
    'response_payload',
  ]) assert.match(migration, new RegExp(`\\b${column}\\b`));
  assert.match(migration, /repo_card_summaries_versioned_uidx/);
  assert.match(
    migration,
    /repo_id,content_version,prompt_version,model_version,format_version/,
  );
  assert.match(migration, /raw\[\.\]githubusercontent\[\.\]com/);
  assert.match(migration, /refs\/heads/);
  assert.match(migration, /position\(chr\(92\) in readme_source_path\)=0/);
});

test('repository-summary migration deactivates unversioned legacy content and bounds active artifacts', () => {
  assert.match(migration, /source='legacy',[\s\S]+active=false[\s\S]+prompt_version IS NULL/);
  assert.match(migration, /source NOT IN \('generated','description_fallback','legacy'\)/);
  assert.match(migration, /OR \(source='legacy' AND active\)/);
  assert.match(migration, /char_length\(btrim\(summary\)\) NOT BETWEEN 1 AND 360/);
  assert.match(migration, /SET highlights='\[\]'::jsonb/);
  assert.match(migration, /source<>'legacy'/);
  assert.match(migration, /char_length\(btrim\(summary\)\) BETWEEN 1 AND 360/);
  assert.match(migration, /jsonb_array_length\(highlights\)<=3/);
  assert.match(migration, /content\.content_version=summary\.content_version/);
  assert.match(migration, /GRANT UPDATE \(response_payload\) ON telemetry\.ml_outbox TO ghsocial_backend/);
});

test('schema audit gates summary constraints, versioned index, and response retention grant', () => {
  for (const constraint of [
    'repo_content_readme_metadata_check',
    'repo_card_summaries_versions_check',
    'repo_card_summaries_highlights_check',
    'repo_card_summaries_source_check',
    'repo_card_summaries_active_length_check',
  ]) assert.match(schemaAudit, new RegExp(`\\b${constraint}\\b`));
  assert.match(schemaAudit, /telemetry\.ml_outbox/);
  assert.match(schemaAudit, /response_payload/);
  assert.match(schemaAudit, /can_store_ml_response/);
});
