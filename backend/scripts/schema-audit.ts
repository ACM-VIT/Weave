import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

interface Manifest {
  schemas: string[];
  tables: Record<string, string[]>;
  indexes: string[];
  functions: string[];
  roles: string[];
  columns?: string[];
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, '../../database/migrations');
const manifest = JSON.parse(
  fs.readFileSync(path.resolve(here, '../../database/audits/expected-v2-schema.json'), 'utf8'),
) as Manifest;
const journal = JSON.parse(
  fs.readFileSync(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
) as { entries: Array<{ tag: string }> };
const client = postgres(databaseUrl, { max: 1, prepare: false });
const missing: string[] = [];

try {
  const schemaRows = await client`SELECT schema_name FROM information_schema.schemata`;
  const schemas = new Set(schemaRows.map((row) => String(row.schema_name)));
  for (const schema of manifest.schemas) if (!schemas.has(schema)) missing.push(`schema:${schema}`);

  const tableRows = await client`
    SELECT table_schema, table_name FROM information_schema.tables
    WHERE table_schema = ANY(${manifest.schemas}::text[]) AND table_type = 'BASE TABLE'
  `;
  const tables = new Set(tableRows.map((row) => `${row.table_schema}.${row.table_name}`));
  for (const [schema, names] of Object.entries(manifest.tables)) {
    for (const name of names) if (!tables.has(`${schema}.${name}`)) missing.push(`table:${schema}.${name}`);
  }

  const columnRows = await client`
    SELECT table_schema,table_name,column_name
    FROM information_schema.columns
    WHERE table_schema = ANY(${manifest.schemas}::text[])
  `;
  const columns = new Set(columnRows.map(
    (row) => `${row.table_schema}.${row.table_name}.${row.column_name}`,
  ));
  for (const requiredColumn of [
    ...(manifest.columns ?? []),
    'app.user_feed_state.last_published_feed_version',
    'app.users.interests',
    'app.users.skills',
    'app.users.tech_stack',
    'app.users.date_of_birth',
    'app.users.onboarding_completed',
    'app.oauth_codes.client_code_challenge',
    'app.repo_content.readme_source_path',
    'app.repo_content.readme_default_branch',
    'app.repo_content.readme_base_url',
    'app.repo_card_summaries.prompt_version',
    'app.repo_card_summaries.format_version',
    'app.repo_card_summaries.highlights',
    'app.repo_card_summaries.source',
    'app.repo_card_summaries.artifact_revision',
    'app.repo_card_summaries.supersedes_summary_id',
    'telemetry.ml_outbox.response_payload',
    'telemetry.counter_reconciliation_progress.scope',
    'telemetry.counter_reconciliation_progress.last_id',
    'telemetry.counter_reconciliation_progress.upper_id',
    'telemetry.counter_reconciliation_progress.completed_sweeps',
    'telemetry.counter_reconciliation_progress.updated_at',
    ...['user_id','feed_version','profile_version','status','scheduled_at','available_at','claimed_at','claim_token','attempts','last_error']
      .map(name => `telemetry.feed_prewarm_jobs.${name}`),
  ]) {
    if (!columns.has(requiredColumn)) missing.push(`column:${requiredColumn}`);
  }

  const outboxConstraintRows = await client`
    SELECT pg_get_constraintdef(constraint_row.oid) AS definition
    FROM pg_constraint constraint_row
    JOIN pg_class relation ON relation.oid=constraint_row.conrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname='telemetry' AND relation.relname='ml_outbox'
      AND constraint_row.conname='ml_outbox_status_check'
  `;
  const outboxStatusDefinition = String(outboxConstraintRows[0]?.definition ?? '');
  if (!outboxStatusDefinition.includes('superseded')) {
    missing.push('constraint:telemetry.ml_outbox.status:superseded');
  }

  const summaryConstraintRows = await client`
    SELECT relation.relname AS table_name,constraint_row.conname,
      pg_get_constraintdef(constraint_row.oid) AS definition
    FROM pg_constraint constraint_row
    JOIN pg_class relation ON relation.oid=constraint_row.conrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname='app'
      AND relation.relname IN ('repo_content','repo_card_summaries')
  `;
  const summaryConstraints = new Map(summaryConstraintRows.map(
    (row) => [`${row.table_name}.${row.conname}`, String(row.definition)],
  ));
  for (const name of [
    'repo_content.repo_content_readme_metadata_check',
    'repo_card_summaries.repo_card_summaries_versions_check',
    'repo_card_summaries.repo_card_summaries_revision_check',
    'repo_card_summaries.repo_card_summaries_highlights_check',
    'repo_card_summaries.repo_card_summaries_source_check',
    'repo_card_summaries.repo_card_summaries_active_length_check',
  ]) {
    if (!summaryConstraints.has(name)) missing.push(`constraint:app.${name}`);
  }
  const readmeMetadataDefinition = summaryConstraints.get(
    'repo_content.repo_content_readme_metadata_check',
  ) ?? '';
  if (!readmeMetadataDefinition.includes('raw')
    || !readmeMetadataDefinition.includes('githubusercontent')
    || !readmeMetadataDefinition.includes('refs/heads')) {
    missing.push('constraint:app.repo_content.repo_content_readme_metadata_check:canonical-host');
  }

  const legacyAuthTriggerRows = await client`
    SELECT 1 FROM information_schema.triggers
    WHERE event_object_schema='auth' AND event_object_table='users'
      AND trigger_name='on_auth_user_created'
  `;
  if (legacyAuthTriggerRows.length > 0) {
    missing.push('prohibited-trigger:auth.users.on_auth_user_created');
  }

  const indexRows = await client`
    SELECT indexname FROM pg_indexes WHERE schemaname = ANY(${manifest.schemas}::text[])
  `;
  const indexes = new Set(indexRows.map((row) => String(row.indexname)));
  for (const name of manifest.indexes) if (!indexes.has(name)) missing.push(`index:${name}`);

  const functionRows = await client`
    SELECT n.nspname,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ANY(${manifest.schemas}::text[])
  `;
  const functions = new Set(functionRows.map((row) => `${row.nspname}.${row.proname}`));
  for (const name of manifest.functions) {
    const qualified = name.includes('.') ? name : `app.${name}`;
    if (!functions.has(qualified)) missing.push(`function:${qualified}`);
  }

  const wakeTriggers = await client`
    SELECT relation.relname AS table_name,trigger.tgname AS name,procedure.proname AS function_name
    FROM pg_trigger trigger JOIN pg_class relation ON relation.oid=trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    JOIN pg_proc procedure ON procedure.oid=trigger.tgfoid
    JOIN pg_namespace function_namespace ON function_namespace.oid=procedure.pronamespace
      AND function_namespace.nspname='telemetry'
    WHERE namespace.nspname='telemetry' AND NOT trigger.tgisinternal AND trigger.tgenabled IN ('O','A')
  `;
  for (const [table,name,fn] of [
    ['ml_outbox','ml_outbox_wake','notify_worker_ready'],
    ['feed_prewarm_jobs','feed_prewarm_wake','notify_worker_ready'],
    ['ml_outbox','ml_outbox_onboarding_prewarm','schedule_onboarding_prewarm'],
  ]) {
    if (!wakeTriggers.some(row => row.table_name === table && row.name === name && row.function_name === fn)) {
      missing.push(`trigger:telemetry.${table}.${name}`);
    }
  }

  const roleRows = await client`SELECT rolname FROM pg_roles`;
  const roles = new Set(roleRows.map((row) => String(row.rolname)));
  for (const name of manifest.roles) if (!roles.has(name)) missing.push(`role:${name}`);

  const exposed = await client`
    SELECT grantee, table_schema, table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema IN ('app', 'telemetry') AND grantee IN ('anon', 'authenticated')
  `;
  for (const row of exposed) {
    missing.push(`prohibited-grant:${row.grantee}:${row.table_schema}.${row.table_name}:${row.privilege_type}`);
  }

  const runtimeGrantRows = await client`
    SELECT has_column_privilege(
      'ghsocial_backend',
      'telemetry.interaction_events',
      'feedback_version',
      'UPDATE'
    ) AS can_assign_feedback_version,
    has_column_privilege(
      'ghsocial_backend',
      'telemetry.user_repo_engagement',
      'feedback_score',
      'UPDATE'
    ) AS can_update_engagement,
    has_column_privilege(
      'ghsocial_backend',
      'telemetry.ml_outbox',
      'response_payload',
      'UPDATE'
    ) AS can_store_ml_response,
    has_table_privilege(
      'ghsocial_backend',
      'telemetry.counter_reconciliation_progress',
      'SELECT'
    ) AND has_table_privilege(
      'ghsocial_backend','telemetry.counter_reconciliation_progress','UPDATE'
    ) AS can_reconcile_counters,
    has_table_privilege('ghsocial_backend','telemetry.feed_prewarm_jobs','SELECT')
      AND has_table_privilege('ghsocial_backend','telemetry.feed_prewarm_jobs','INSERT')
      AND has_table_privilege('ghsocial_backend','telemetry.feed_prewarm_jobs','UPDATE') AS can_schedule_prewarm
  `;
  if (runtimeGrantRows[0]?.can_assign_feedback_version !== true) {
    missing.push('required-grant:ghsocial_backend:telemetry.interaction_events.feedback_version:UPDATE');
  }
  if (runtimeGrantRows[0]?.can_update_engagement !== true) {
    missing.push('required-grant:ghsocial_backend:telemetry.user_repo_engagement:UPDATE');
  }
  if (runtimeGrantRows[0]?.can_store_ml_response !== true) {
    missing.push('required-grant:ghsocial_backend:telemetry.ml_outbox.response_payload:UPDATE');
  }
  if (runtimeGrantRows[0]?.can_reconcile_counters !== true) {
    missing.push('required-grant:ghsocial_backend:telemetry.counter_reconciliation_progress:SELECT,UPDATE');
  }
  if (runtimeGrantRows[0]?.can_schedule_prewarm !== true) {
    missing.push('required-grant:ghsocial_backend:telemetry.feed_prewarm_jobs:SELECT,INSERT,UPDATE');
  }

  const migrationRows = await client`
    SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at
  `.catch(() => []);
  if (migrationRows.length === 0) missing.push('migration-history:empty');
  const recordedHashes = new Set(migrationRows.map((row) => String(row.hash)));
  for (const entry of journal.entries) {
    const sql = fs.readFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), 'utf8');
    const expectedHash = crypto.createHash('sha256').update(sql).digest('hex');
    if (!recordedHashes.has(expectedHash)) missing.push(`migration-hash:${entry.tag}`);
  }

  if (missing.length > 0) {
    console.error('Schema audit failed:\n' + missing.map((item) => `- ${item}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Schema audit passed: ${tables.size} v2 tables and ${migrationRows.length} migration hashes.`);
  }
} finally {
  await client.end();
}
