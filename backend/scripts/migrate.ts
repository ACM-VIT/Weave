import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import {
  LEGACY_BASELINE_TAGS,
  RETROACTIVE_LEGACY_TAGS,
  STRUCTURALLY_ADOPTABLE_V2_TAGS,
} from './migrationPlan.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, '../../database/migrations');
const journal = JSON.parse(
  fs.readFileSync(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
) as { entries: Array<{ idx: number; tag: string; when: number }> };

const client = postgres(databaseUrl, { max: 1, prepare: false });

type MigrationEntry = { idx: number; tag: string; when: number; hash: string; sql: string };

function migrationEntries(tags: readonly string[]): MigrationEntry[] {
  const allowed = new Set(tags);
  return journal.entries.filter((entry) => allowed.has(entry.tag)).map((entry) => {
    const sql = fs.readFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), 'utf8');
    return { ...entry, sql, hash: crypto.createHash('sha256').update(sql).digest('hex') };
  });
}

async function recordedMigrationHashes(): Promise<Set<string>> {
  if (!await relationExists('drizzle', '__drizzle_migrations')) return new Set();
  const rows = await client`SELECT hash FROM drizzle.__drizzle_migrations`;
  return new Set(rows.map((row) => String(row.hash)));
}

async function ensureMigrationHistoryTable(): Promise<void> {
  await client`CREATE SCHEMA IF NOT EXISTS drizzle`;
  await client`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `;
}

async function bootstrapSupabaseAuthStub(): Promise<void> {
  if (process.env.BOOTSTRAP_SUPABASE_AUTH_STUB !== '1') return;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('BOOTSTRAP_SUPABASE_AUTH_STUB is forbidden in production.');
  }
  await client`CREATE SCHEMA IF NOT EXISTS auth`;
  await client`
    CREATE TABLE IF NOT EXISTS auth.users (
      id uuid PRIMARY KEY,
      raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb
    )
  `;
  console.log('Created the explicit non-production Supabase auth.users migration stub.');
}

async function relationExists(schema: string, relation: string): Promise<boolean> {
  const rows = await client`
    SELECT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema} AND c.relname = ${relation}
    ) AS present
  `;
  return rows[0]?.present === true;
}

async function columnExists(schema: string, table: string, column: string): Promise<boolean> {
  const rows = await client`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema=${schema} AND table_name=${table} AND column_name=${column}
    ) AS present
  `;
  return rows[0]?.present === true;
}

async function adoptLegacyHistory(): Promise<void> {
  const hasLegacySchema = await relationExists('public', 'repo');
  const hasDrizzleHistory = await relationExists('drizzle', '__drizzle_migrations');
  if (!hasLegacySchema) return;

  const legacyRelations = [
    'activity', 'board_repos', 'boards', 'boards_containers', 'comment', 'container_boards',
    'follows', 'oauth_codes', 'refresh_tokens', 'repo', 'users',
  ];
  const missingRelations: string[] = [];
  for (const relation of legacyRelations) {
    if (!await relationExists('public', relation)) missingRelations.push(relation);
  }

  const legacyEntries = migrationEntries(LEGACY_BASELINE_TAGS);
  const recordedHashes = hasDrizzleHistory ? await recordedMigrationHashes() : new Set<string>();
  const historyComplete = legacyEntries.every((entry) => recordedHashes.has(entry.hash));
  if (historyComplete) return;

  if (process.env.ADOPT_LEGACY_SCHEMA !== '1') {
    throw new Error(
      'A legacy public schema exists with incomplete Drizzle history. Audit a clone, then rerun once with ADOPT_LEGACY_SCHEMA=1.',
    );
  }
  if (missingRelations.length > 0) {
    throw new Error(`Cannot adopt incomplete legacy schema; missing public tables: ${missingRelations.join(', ')}.`);
  }

  await ensureMigrationHistoryTable();

  for (const entry of legacyEntries) {
    await client`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      SELECT ${entry.hash}, ${entry.when}
      WHERE NOT EXISTS (
        SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = ${entry.hash}
      )
    `;
  }
  console.log('Adopted the audited parent-journal legacy baseline into Drizzle history.');
}

async function applyRetroactiveLegacyMigrations(): Promise<void> {
  if (!await relationExists('public', 'repo')) return;
  await ensureMigrationHistoryTable();
  const recordedHashes = await recordedMigrationHashes();
  for (const entry of migrationEntries(RETROACTIVE_LEGACY_TAGS)) {
    if (recordedHashes.has(entry.hash)) continue;
    await client.begin(async (tx) => {
      for (const statement of entry.sql.split('--> statement-breakpoint')) {
        if (statement.trim()) await tx.unsafe(statement).simple();
      }
      await tx`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${entry.hash}, ${entry.when})
      `;
    });
    recordedHashes.add(entry.hash);
    console.log(`Applied retroactive legacy migration ${entry.tag}.`);
  }
}

async function adoptStructurallyVerifiedV2History(): Promise<void> {
  if (!await relationExists('app', 'users')) return;

  const entries = migrationEntries(STRUCTURALLY_ADOPTABLE_V2_TAGS);
  const recordedHashes = await recordedMigrationHashes();
  const missingEntries = entries.filter((entry) => !recordedHashes.has(entry.hash));
  if (missingEntries.length === 0) return;
  if (process.env.ADOPT_LEGACY_SCHEMA !== '1') {
    throw new Error(
      'The v2 schema exists with incomplete Drizzle history. Audit a clone, then rerun once with ADOPT_LEGACY_SCHEMA=1.',
    );
  }

  const structuralChecks: Record<string, () => Promise<boolean>> = {
    '0008_interaction_events_and_saved_counts': async () =>
      await relationExists('public', 'interaction_events')
      && await relationExists('public', 'user_feedback_features'),
    '0009_app_telemetry_baseline': async () => {
      const roles = await client`SELECT 1 FROM pg_roles WHERE rolname='ghsocial_backend'`;
      return await relationExists('app', 'users')
        && await relationExists('app', 'repos')
        && await relationExists('telemetry', 'ml_outbox')
        && roles.length > 0;
    },
    '0010_product_api_baseline': async () =>
      await relationExists('app', 'refresh_tokens')
      && await relationExists('app', 'oauth_codes'),
    '0011_interaction_feedback_grant': async () => {
      const grants = await client`
        SELECT has_column_privilege(
          'ghsocial_backend','telemetry.interaction_events','feedback_version','UPDATE'
        ) AS interaction_grant,
        has_column_privilege(
          'ghsocial_backend','telemetry.user_repo_engagement','feedback_score','UPDATE'
        ) AS engagement_grant
      `;
      return grants[0]?.interaction_grant === true && grants[0]?.engagement_grant === true;
    },
    '0012_remove_profile_length_limits': async () => {
      const columns = await client`
        SELECT column_name,data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name='users'
          AND column_name IN ('username','full_name')
      `;
      return columns.length === 2 && columns.every((row) => row.data_type === 'text');
    },
    '0013_feed_serve_cursor': async () => columnExists('telemetry', 'feed_serves', 'next_cursor'),
  };

  await ensureMigrationHistoryTable();
  for (const entry of missingEntries) {
    if (!await structuralChecks[entry.tag]?.()) {
      throw new Error(`Cannot adopt ${entry.tag}; its required database structures are incomplete.`);
    }
    await client`
      INSERT INTO drizzle.__drizzle_migrations(hash,created_at)
      SELECT ${entry.hash},${entry.when}
      WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash=${entry.hash})
    `;
    console.log(`Adopted structurally verified migration history ${entry.tag}.`);
  }
}

try {
  await bootstrapSupabaseAuthStub();
  await adoptLegacyHistory();
  await applyRetroactiveLegacyMigrations();
  await adoptStructurallyVerifiedV2History();
  await migrate(drizzle(client), {
    migrationsFolder,
    migrationsSchema: 'drizzle',
    migrationsTable: '__drizzle_migrations',
  });
  console.log('Drizzle migrations are current.');
} finally {
  await client.end();
}
