import type { Sql, TransactionSql } from 'postgres';
import { pathToFileURL } from 'node:url';
import { deriveReadmeMediaManifest } from '../services/readmeMediaManifest.js';
import { MAX_BATCH_REPOSITORIES } from '../services/repositoryIngestionBatch.js';

interface MissingManifestRow {
  repo_id: string;
  full_name: string;
  url: string;
  readme: string | null;
  readme_source_path: string | null;
  readme_default_branch: string | null;
  readme_base_url: string | null;
  content_version: number;
  content_hash: string;
}

function manifestStaleSql(alias: 'content'): string {
  return `(
    jsonb_typeof(${alias}.readme_media_manifest) IS DISTINCT FROM 'object'
    OR ${alias}.readme_media_manifest->>'schema_version' IS DISTINCT FROM '2'
    OR ${alias}.readme_media_manifest->>'content_version' IS DISTINCT FROM ${alias}.content_version::text
    OR ${alias}.readme_media_manifest->>'content_hash' IS DISTINCT FROM ${alias}.content_hash
    OR (${alias}.readme_media_manifest->>'representation' IS DISTINCT FROM 'deferred'
      AND ${alias}.readme_media_manifest->>'representation' IS DISTINCT FROM 'inline_only')
    OR jsonb_typeof(${alias}.readme_media_manifest->'readme_available') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(${alias}.readme_media_manifest->'images') IS DISTINCT FROM 'array'
    OR jsonb_typeof(${alias}.readme_media_manifest->'videos') IS DISTINCT FROM 'array'
  )`;
}

export async function countMissingReadmeMediaManifests(db: Sql): Promise<number> {
  const rows = await db.unsafe(
    `SELECT count(*)::bigint AS count FROM app.repo_content content WHERE ${manifestStaleSql('content')}`,
  );
  return Number(rows[0]?.count ?? 0);
}

async function backfillBatch(tx: TransactionSql): Promise<number> {
  const rows = await tx.unsafe(`
    SELECT repo.repo_id,repo.full_name,repo.url,content.readme,
      content.readme_source_path,content.readme_default_branch,content.readme_base_url,
      content.content_version,content.content_hash
    FROM app.repo_content content JOIN app.repos repo USING(repo_id)
    WHERE ${manifestStaleSql('content')}
    ORDER BY repo.repo_id
    LIMIT ${MAX_BATCH_REPOSITORIES}
    FOR UPDATE OF content SKIP LOCKED
  `) as unknown as MissingManifestRow[];
  if (!rows.length) return 0;
  const updates = rows.map(row => ({
    repo_id: String(row.repo_id),
    content_version: Number(row.content_version),
    content_hash: String(row.content_hash),
    manifest: deriveReadmeMediaManifest({
      markdown: row.readme,
      context: { fullName: String(row.full_name), githubUrl: String(row.url),
        sourcePath: row.readme_source_path == null ? null : String(row.readme_source_path),
        defaultBranch: row.readme_default_branch == null ? null : String(row.readme_default_branch),
        baseUrl: row.readme_base_url == null ? null : String(row.readme_base_url) },
      contentVersion: Number(row.content_version), contentHash: String(row.content_hash),
    }),
  }));
  const written = await tx`
    WITH input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(updates)}::text::jsonb)
        AS update_row(repo_id uuid,content_version integer,content_hash text,manifest jsonb)
    )
    UPDATE app.repo_content content SET readme_media_manifest=input.manifest
    FROM input
    WHERE content.repo_id=input.repo_id
      AND content.content_version=input.content_version
      AND content.content_hash=input.content_hash
      AND ${tx.unsafe(manifestStaleSql('content'))}
    RETURNING content.repo_id
  `;
  return written.length;
}

export async function runReadmeMediaBackfill(db: Sql, apply: boolean): Promise<{
  mode: 'dry-run' | 'apply'; before: number; written: number; remaining: number;
}> {
  const before = await countMissingReadmeMediaManifests(db);
  let written = 0;
  if (apply) {
    while (true) {
      const batchWritten = await db.begin(backfillBatch);
      if (batchWritten === 0) break;
      written += batchWritten;
    }
  }
  const remaining = await countMissingReadmeMediaManifests(db);
  return { mode: apply ? 'apply' : 'dry-run', before, written, remaining };
}

function parseApplyFlag(arguments_: string[]): boolean {
  let apply = false;
  for (const argument of arguments_) {
    if (argument === '--apply') apply = true;
    else if (argument !== '--dry-run') throw new Error(`Unknown argument: ${argument}`);
  }
  return apply;
}

async function main(): Promise<void> {
  const apply = parseApplyFlag(process.argv.slice(2));
  const { sqlClient } = await import('../db/index.js');
  try {
    const report = await runReadmeMediaBackfill(sqlClient, apply);
    console.log(JSON.stringify(report));
    if (apply && report.remaining > 0) throw new Error('Media manifest backfill remains incomplete; rerun after locked rows are available.');
  } finally {
    await sqlClient.end({ timeout: 1 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
