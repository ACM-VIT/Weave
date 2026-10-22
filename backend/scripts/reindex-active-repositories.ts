import crypto from 'node:crypto';
import { isValidUuid } from '../utils/validators.js';
import { isAcceptedStoredSummary } from '../services/storedRepositorySummary.js';
import { pathToFileURL } from 'node:url';

import postgres from 'postgres';

import type { RepositoryUpsert } from '../contracts/ingestion.v2.js';
import type { MlRepositoryIndexJob } from '../contracts/ml.v2.js';
import { buildMlRepositorySource } from '../services/mlRepositoryPayloadService.js';
import { isRepositoryUpsert } from '../utils/ingestionValidation.js';

export interface ReindexOptions {
  campaignId: string;
  execute: boolean;
  batchSize: number;
  summaryBackfill: boolean;
  repairInvalidSummaries?: boolean;
  repositoryIds?: string[];
}

interface ReindexRow {
  repo_id: string;
  active_summary?: Record<string, unknown> | null;
  github_id: string;
  owner_github_id: string | null;
  full_name: string;
  url: string;
  description: string | null;
  readme: string | null;
  readme_source_path: string | null;
  readme_default_branch: string | null;
  readme_base_url: string | null;
  primary_language: string | null;
  languages: unknown;
  topics: unknown;
  content_hash: string;
  content_version: number;
  source_updated_at: string | Date | null;
  star_count: number | null;
  fork_count: number | null;
  open_issues_count: number | null;
  observed_at: string | Date;
}

const CAMPAIGN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

export function parseReindexOptions(arguments_: string[]): ReindexOptions {
  let execute = false;
  let campaignId: string | undefined;
  let batchSize = 100;
  let summaryBackfill = false;
  let repairInvalidSummaries = false;
  const repositoryIds: string[] = [];
  for (const argument of arguments_) {
    if (argument === '--execute') execute = true;
    else if (argument === '--summary-backfill') summaryBackfill = true;
    else if (argument === '--repair-invalid-summaries') repairInvalidSummaries = true;
    else if (argument.startsWith('--repo-id=')) repositoryIds.push(argument.slice('--repo-id='.length));
    else if (argument.startsWith('--campaign=')) campaignId = argument.slice('--campaign='.length);
    else if (argument.startsWith('--batch-size=')) batchSize = Number(argument.slice('--batch-size='.length));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!campaignId || !CAMPAIGN_PATTERN.test(campaignId)) {
    throw new Error('--campaign must be 3-64 letters, numbers, dots, underscores, or hyphens.');
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error('--batch-size must be an integer from 1 to 500.');
  }
  if (summaryBackfill && repairInvalidSummaries) throw new Error('Choose --summary-backfill or --repair-invalid-summaries.');
  if (repositoryIds.some(id => !isValidUuid(id))) throw new Error('--repo-id must be a canonical UUID.');
  if (repairInvalidSummaries && execute && repositoryIds.length === 0) throw new Error('Invalid-artifact recovery execution requires reviewed --repo-id values.');
  return { campaignId, execute, batchSize, summaryBackfill, ...(repairInvalidSummaries ? { repairInvalidSummaries: true } : {}),
    ...(repositoryIds.length ? { repositoryIds: [...new Set(repositoryIds.map(id => id.toLowerCase()))] } : {}) };
}

export function campaignIdempotencyKey(
  campaignId: string,
  repoId: string,
  contentVersion: number,
): string {
  return `repo_index:${repoId}:${contentVersion}:campaign:${campaignId}`;
}

function iso(value: string | Date | null): string | null {
  return value == null ? null : new Date(value).toISOString();
}

export function buildCampaignRepositoryJob(
  row: ReindexRow,
  jobId = crypto.randomUUID(),
): MlRepositoryIndexJob | null {
  const [owner, ...nameParts] = row.full_name.split('/');
  const repository: RepositoryUpsert = {
    github_id: String(row.github_id),
    owner_github_id: String(row.owner_github_id ?? ''),
    full_name: row.full_name,
    owner,
    name: nameParts.join('/'),
    url: row.url,
    description: row.description,
    readme: row.readme,
    readme_source_path: row.readme_source_path,
    readme_default_branch: row.readme_default_branch,
    readme_base_url: row.readme_base_url,
    primary_language: row.primary_language,
    languages: Array.isArray(row.languages) ? row.languages.map(String) : [],
    topics: Array.isArray(row.topics) ? row.topics.map(String) : [],
    star_count: Number(row.star_count ?? 0),
    fork_count: Number(row.fork_count ?? 0),
    open_issues_count: Number(row.open_issues_count ?? 0),
    pushed_at: iso(row.source_updated_at),
    observed_at: iso(row.observed_at)!,
  };
  if (!isRepositoryUpsert(repository) || !Number.isInteger(row.content_version) || row.content_version < 1) return null;
  return {
    job_id: jobId,
    repo_id: row.repo_id,
    content_version: row.content_version,
    repository: buildMlRepositorySource(repository, row.content_hash),
  };
}

export async function runReindex(options: ReindexOptions, databaseUrl: string): Promise<Record<string, unknown>> {
  const repositoryIds = options.repositoryIds ?? [];
  if (repositoryIds.some(id => !isValidUuid(id))
    || (options.repairInvalidSummaries && options.execute && !repositoryIds.length)) {
    throw new Error('Invalid-artifact recovery requires reviewed canonical repository IDs.');
  }
  const client = postgres(databaseUrl, { max: 1, prepare: false });
  const report = {
    mode: options.execute ? 'execute' : 'dry-run',
    scope: options.repairInvalidSummaries ? 'invalid-current-summary'
      : options.summaryBackfill ? 'missing-or-invalid-current-generated-summary' : 'all-active-repositories',
    campaign_id: options.campaignId,
    batch_size: options.batchSize,
    active: 0,
    eligible: 0,
    missing_content: 0,
    already_generated: 0,
    invalid_artifacts: 0,
    queued: 0,
    would_queue: 0,
    already_queued: 0,
    invalid: 0,
    skipped: 0,
  };
  try {
    const counts = await client`
      SELECT count(*) FILTER (WHERE repo.status='active')::int AS active,
        count(content.repo_id) FILTER (WHERE repo.status='active')::int AS with_content
      FROM app.repos repo LEFT JOIN app.repo_content content ON content.repo_id=repo.repo_id
      WHERE (${repositoryIds.length === 0} OR repo.repo_id=ANY(${repositoryIds}::uuid[]))
    `;
    report.active = Number(counts[0].active);
    report.missing_content = report.active - Number(counts[0].with_content);
    report.skipped = report.missing_content;

    let cursor: string | null = null;
    do {
      const batch = await client.begin(async (tx) => {
        const rows = await tx`
          SELECT repo.repo_id,repo.github_id::text AS github_id,repo.owner_github_id::text AS owner_github_id,
            repo.full_name,repo.url,
            content.description,content.readme,content.readme_source_path,
            content.readme_default_branch,content.readme_base_url,
            content.primary_language,content.languages,
            content.content_hash,content.content_version,content.source_updated_at,
            stat.star_count,stat.fork_count,stat.open_issues_count,
            COALESCE(stat.observed_at,content.updated_at) AS observed_at,topic_list.topics,active_summary.artifact AS active_summary
          FROM app.repos repo
          JOIN app.repo_content content ON content.repo_id=repo.repo_id
          LEFT JOIN LATERAL (
            SELECT to_jsonb(summary.*) AS artifact FROM app.repo_card_summaries summary
            WHERE summary.repo_id=repo.repo_id AND summary.active LIMIT 1
          ) active_summary ON true
          LEFT JOIN LATERAL (
            SELECT snapshot.star_count,snapshot.fork_count,snapshot.open_issues_count,snapshot.observed_at
            FROM app.repo_stat_snapshots snapshot WHERE snapshot.repo_id=repo.repo_id
            ORDER BY snapshot.observed_at DESC LIMIT 1
          ) stat ON true
          LEFT JOIN LATERAL (
            SELECT COALESCE(jsonb_agg(topic.slug ORDER BY topic.slug),'[]'::jsonb) AS topics
            FROM app.repo_topics relation JOIN app.topics topic ON topic.topic_id=relation.topic_id
            WHERE relation.repo_id=repo.repo_id
          ) topic_list ON true
          WHERE repo.status='active' AND (${cursor}::uuid IS NULL OR repo.repo_id>${cursor}::uuid)
            AND (${repositoryIds.length === 0} OR repo.repo_id=ANY(${repositoryIds}::uuid[]))
          ORDER BY repo.repo_id LIMIT ${options.batchSize}
          FOR SHARE OF repo,content
        ` as unknown as ReindexRow[];
        let queued = 0;
        let wouldQueue = 0;
        let alreadyQueued = 0;
        let invalid = 0;
        let eligible = 0;
        let alreadyGenerated = 0;
        let skippedByScope = 0;
        let invalidArtifacts = 0;
        for (const row of rows) {
          const active = row.active_summary;
          const accepted = Boolean(active && Number(active.content_version) === row.content_version
            && isAcceptedStoredSummary(active, row));
          if (active && !accepted) invalidArtifacts++;
          const validGenerated = accepted && active?.source === 'generated';
          if ((options.summaryBackfill && validGenerated)
            || (options.repairInvalidSummaries && (!active || accepted))) {
            skippedByScope++;
            if (validGenerated) alreadyGenerated++;
            continue;
          }
          eligible++;
          const job = buildCampaignRepositoryJob(row);
          if (!job) { invalid++; continue; }
          const key = campaignIdempotencyKey(options.campaignId, row.repo_id, row.content_version);
          if (options.execute) {
            const inserted = await tx`
              INSERT INTO telemetry.ml_outbox (job_type,aggregate_id,idempotency_key,payload)
              VALUES ('repo_index',${row.repo_id}::uuid,${key},
                ${tx.json(job as unknown as Parameters<typeof tx.json>[0])})
              ON CONFLICT (idempotency_key) DO NOTHING RETURNING outbox_id
            `;
            if (inserted.length === 1) queued++;
            else alreadyQueued++;
          } else {
            const exists = await tx`SELECT 1 FROM telemetry.ml_outbox WHERE idempotency_key=${key}`;
            if (exists.length > 0) alreadyQueued++;
            else wouldQueue++;
          }
        }
        return {
          rows: rows.length,
          eligible, alreadyGenerated, skippedByScope, invalidArtifacts,
          cursor: rows.length > 0 ? rows.at(-1)!.repo_id : null,
          queued,
          wouldQueue,
          alreadyQueued,
          invalid,
        };
      });
      report.eligible += batch.eligible;
      report.already_generated += batch.alreadyGenerated;
      report.skipped += batch.skippedByScope;
      report.invalid_artifacts += batch.invalidArtifacts;
      report.queued += batch.queued;
      report.would_queue += batch.wouldQueue;
      report.already_queued += batch.alreadyQueued;
      report.invalid += batch.invalid;
      cursor = batch.cursor;
      if (batch.rows < options.batchSize) break;
    } while (cursor);
    report.skipped += report.already_queued + report.invalid;
    return report;
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const options = parseReindexOptions(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  const report = await runReindex(options, databaseUrl);
  console.log(JSON.stringify(report, null, 2));
  if (Number(report.invalid) > 0 || Number(report.missing_content) > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
