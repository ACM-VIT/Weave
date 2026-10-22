import { isTransientReadmeStorageError } from './readmeStorageErrors.js';
import type { Sql, TransactionSql } from 'postgres';
import {
  README_SUMMARY_FORMAT_VERSION, README_SUMMARY_PROMPT_VERSION,
  type ReadmeSummaryContent,
} from '../contracts/readmeSummary.v2.js';
import { sqlClient } from '../db/index.js';
import { ReadmeSummaryError, validateReadmeSummary, type ReadmeSummaryGenerator, type ReadmeSummarySource } from './readmeSummaryGenerator.js';

export async function enqueueReadmeSummary(
  tx: TransactionSql, repoId: string, version: number, hash: string,
): Promise<void> {
  await tx`
    INSERT INTO telemetry.readme_summary_jobs (repo_id,content_version,content_hash,prompt_version)
    SELECT ${repoId}::uuid,${version},${hash},${README_SUMMARY_PROMPT_VERSION}
    FROM app.repo_content WHERE repo_id=${repoId}::uuid AND char_length(btrim(COALESCE(readme,'')))>=200
    ON CONFLICT (repo_id,content_version,content_hash,prompt_version) DO NOTHING
  `;
}

export interface ReadmeSummaryJob {
  job_id: string; generation_id: string; repo_id: string; content_version: number; content_hash: string;
  claim_token: string; attempts: number;
}

/** Durable, leased V2 jobs; provider calls occur outside the database transaction. */
export class ReadmeSummaryService {
  constructor(private readonly generator: ReadmeSummaryGenerator, private readonly db: Sql = sqlClient) {}

  async enqueueMissing(repoIds: string[], regenerate = false): Promise<number> {
    return this.db.begin(async (tx) => {
      if (regenerate) {
        await tx`UPDATE telemetry.readme_summary_jobs SET status='pending',generation_id=gen_random_uuid(),attempts=0,available_at=now(),last_error=NULL
          WHERE repo_id=ANY(${repoIds}::uuid[]) AND status IN ('completed','failed')
          AND prompt_version=${README_SUMMARY_PROMPT_VERSION}
          AND (content_version,content_hash)=(SELECT content_version,content_hash FROM app.repo_content content
            WHERE content.repo_id=telemetry.readme_summary_jobs.repo_id)`;
      }
      const rows = await tx`
        INSERT INTO telemetry.readme_summary_jobs (repo_id,content_version,content_hash,prompt_version)
        SELECT content.repo_id,content.content_version,content.content_hash,${README_SUMMARY_PROMPT_VERSION}
        FROM app.repo_content content JOIN app.repos repo USING(repo_id)
        WHERE content.repo_id=ANY(${repoIds}::uuid[]) AND repo.status='active'
          AND char_length(btrim(COALESCE(content.readme,'')))>=200
        ON CONFLICT (repo_id,content_version,content_hash,prompt_version) DO NOTHING RETURNING job_id
      `;
      return rows.length;
    });
  }

  async claim(repoIds?: string[]): Promise<ReadmeSummaryJob | null> {
    const rows = await this.db`
      WITH candidate AS (
        SELECT job.job_id FROM telemetry.readme_summary_jobs job
        WHERE ((job.status='pending' AND job.available_at<=now())
          OR (job.status='claimed' AND job.claimed_at<now()-interval '5 minutes'))
          AND job.prompt_version=${README_SUMMARY_PROMPT_VERSION}
          AND (${repoIds ?? null}::uuid[] IS NULL OR job.repo_id=ANY(${repoIds ?? []}::uuid[]))
        ORDER BY job.created_at FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE telemetry.readme_summary_jobs job
      SET status='claimed',attempts=attempts+1,claimed_at=now(),claim_token=gen_random_uuid()
      FROM candidate WHERE job.job_id=candidate.job_id
      RETURNING job.job_id,job.generation_id,job.repo_id,job.content_version,job.content_hash,job.claim_token,job.attempts
    `;
    return rows[0] as ReadmeSummaryJob ?? null;
  }

  async complete(job: ReadmeSummaryJob, content: ReadmeSummaryContent): Promise<boolean> {
    validateReadmeSummary(content);
    return this.db.begin(async (tx) => {
      // All summary writers match ingestion: repository, content, then README job.
      // Digest insertion also acquires a repository FK lock; taking it here
      // prevents a cycle with the card-summary worker's repository-first lock.
      await tx`SELECT repo_id FROM app.repos WHERE repo_id=${job.repo_id}::uuid FOR UPDATE`;
      const current = await tx`SELECT content_version,content_hash FROM app.repo_content
        WHERE repo_id=${job.repo_id}::uuid FOR UPDATE`;
      const claimed = await tx`SELECT job_id FROM telemetry.readme_summary_jobs
        WHERE job_id=${job.job_id}::uuid AND claim_token=${job.claim_token}::uuid AND status='claimed' FOR UPDATE`;
      if (!claimed.length) return false;
      if (!current.length || Number(current[0].content_version)!==Number(job.content_version)
        || current[0].content_hash!==job.content_hash) {
        await tx`UPDATE telemetry.readme_summary_jobs SET status='superseded',claim_token=NULL,claimed_at=NULL,completed_at=now()
          WHERE job_id=${job.job_id}::uuid`;
        return false;
      }
      await tx`UPDATE app.repo_readme_summaries SET active=false WHERE repo_id=${job.repo_id}::uuid AND active`;
      // Explicit text avoids Drizzle's shared JSON serializer override and raw-client double encoding.
      const artifact = await tx`
        INSERT INTO app.repo_readme_summaries (generation_id,repo_id,content_version,content_hash,prompt_version,format_version,model_version,artifact,active)
        VALUES (${job.generation_id}::uuid,${job.repo_id}::uuid,${job.content_version},${job.content_hash},${README_SUMMARY_PROMPT_VERSION},
          ${README_SUMMARY_FORMAT_VERSION},${this.generator.modelVersion},${JSON.stringify(content)}::text::jsonb,true)
        ON CONFLICT (generation_id)
        DO UPDATE SET active=true RETURNING summary_id
      `;
      if (!artifact.length) throw new Error('readme_summary_not_persisted');
      await tx`UPDATE telemetry.readme_summary_jobs SET status='completed',completed_at=now(),claim_token=NULL,
        claimed_at=NULL,last_error=NULL WHERE job_id=${job.job_id}::uuid`;
      return true;
    });
  }

  async processOne(repoIds?: string[]): Promise<{ status: string; repo_id?: string; error?: string }> {
    const job = await this.claim(repoIds);
    if (!job) return { status: 'idle' };
    try {
      const rows = await this.db`SELECT repo.full_name,content.description,content.readme,content.content_version,content.content_hash
        FROM app.repos repo JOIN app.repo_content content USING(repo_id) WHERE repo.repo_id=${job.repo_id}::uuid`;
      if (!rows[0] || Number(rows[0].content_version)!==Number(job.content_version) || rows[0].content_hash!==job.content_hash) {
        await this.db`UPDATE telemetry.readme_summary_jobs SET status='superseded',claim_token=NULL,claimed_at=NULL,completed_at=now()
          WHERE job_id=${job.job_id}::uuid AND claim_token=${job.claim_token}::uuid`;
        return { status: 'superseded', repo_id: job.repo_id };
      }
      const source = rows[0] as unknown as ReadmeSummarySource;
      const content = await this.generator.generate(source);
      validateReadmeSummary(content, source);
      return { status: await this.complete(job, content) ? 'completed' : 'superseded', repo_id: job.repo_id };
    } catch (error) {
      const code = error instanceof ReadmeSummaryError ? error.code : 'readme_summary_worker_failed';
      const retry = (error instanceof ReadmeSummaryError ? error.retryable : isTransientReadmeStorageError(error)) && job.attempts<4;
      const delay = error instanceof ReadmeSummaryError && error.retryAfterSeconds
        ? error.retryAfterSeconds : Math.min(900, 15 * 2 ** job.attempts);
      await this.db`UPDATE telemetry.readme_summary_jobs SET status=${retry ? 'pending' : 'failed'},
        available_at=now()+${delay}*interval '1 second',
        claim_token=NULL,claimed_at=NULL,last_error=${code}
        WHERE job_id=${job.job_id}::uuid AND claim_token=${job.claim_token}::uuid`;
      return { status: retry ? 'retry_scheduled' : 'failed', repo_id: job.repo_id, error: code };
    }
  }
}

/** Only application-owned aliases are interpolated; all values still use bound parameters. */
export function readmeSummaryProjection(repoAlias: string, contentAlias: string): string {
  if (![repoAlias, contentAlias].every((alias) => /^[a-z_]+$/.test(alias))) throw new Error('invalid_projection_alias');
  return `(SELECT digest.artifact || jsonb_build_object(
    'summary_id',digest.summary_id,'content_version',digest.content_version,'content_hash',digest.content_hash,
    'prompt_version',digest.prompt_version,'format_version',digest.format_version,'model_version',digest.model_version,
    'source','generated','generated_at',digest.created_at)
    FROM app.repo_readme_summaries digest WHERE digest.repo_id=${repoAlias}.repo_id AND digest.active
      AND digest.content_version=${contentAlias}.content_version AND digest.content_hash=${contentAlias}.content_hash
    LIMIT 1) AS readme_digest`;
}

export async function getReadmeSummaryStatus(repoId: string, db: Sql = sqlClient) {
  const rows = await db.unsafe(`SELECT ${readmeSummaryProjection('repo','content')},content.content_version,
    (SELECT job.status FROM telemetry.readme_summary_jobs job WHERE job.repo_id=repo.repo_id
      AND job.content_version=content.content_version AND job.content_hash=content.content_hash
      AND job.prompt_version=$2 ORDER BY created_at DESC LIMIT 1) AS job_status
    FROM app.repos repo JOIN app.repo_content content USING(repo_id)
    WHERE repo.repo_id=$1::uuid AND repo.status='active'`, [repoId,README_SUMMARY_PROMPT_VERSION]);
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    status: row.readme_digest ? 'ready' : row.job_status==='pending' ? 'pending'
      : row.job_status==='claimed' ? 'processing' : row.job_status==='failed' ? 'failed' : 'unavailable',
    content_version: Number(row.content_version),
    summary: row.readme_digest ?? null,
  };
}
