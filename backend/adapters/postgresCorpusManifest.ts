import type { Sql } from 'postgres';
import type { CorpusManifestEntry, ManifestReader } from '../services/corpusManifestService.js';

export function postgresCorpusManifest(db: Sql): ManifestReader {
  return async (after, asOf, limit) => db.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout = '2000ms'`;
    const rows = await tx`
      SELECT r.repo_id, r.github_id::text, lower(r.full_name) AS full_name,
        c.content_hash, c.content_version, c.updated_at AS content_updated_at, c.source_updated_at
      FROM app.repos r JOIN app.repo_content c USING (repo_id)
      WHERE r.status = 'active' AND (${after}::uuid IS NULL OR r.repo_id > ${after}::uuid)
        AND r.updated_at <= ${asOf}::timestamptz AND c.updated_at <= ${asOf}::timestamptz
      ORDER BY r.repo_id LIMIT ${limit}`;
    return rows.map((row) => ({ ...row,
      content_updated_at: new Date(row.content_updated_at).toISOString(),
      source_updated_at: row.source_updated_at ? new Date(row.source_updated_at).toISOString() : null,
    })) as CorpusManifestEntry[];
  }) as Promise<CorpusManifestEntry[]>;
}
