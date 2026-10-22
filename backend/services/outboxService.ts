import crypto from 'node:crypto';
import { validateRepositoryCardSummary } from './mlService.js';
import { isAcceptedStoredSummary } from './storedRepositorySummary.js';

import { sqlClient } from '../db/index.js';
import type { MlRepositoryIndexResponse } from '../contracts/ml.v2.js';
import { isObsoleteIdentityOnboardingJob } from './mlOnboardingService.js';
import { notifyOutboxAfterCommit, PREWARM_WAKE_CHANNEL } from './outboxWakeup.js';

export interface OutboxRow {
  outbox_id: string;
  job_type: 'feedback' | 'onboard' | 'repo_index' | 'repo_refresh';
  aggregate_id: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: string;
  claim_token: string;
}

export class RepositoryIndexCompletionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryIndexCompletionConflictError';
  }
}

export function retryDelayMs(attempt: number, random = Math.random): number {
  const cap = 15 * 60_000;
  const maximum = Math.min(cap, 1_000 * 2 ** Math.max(0, attempt));
  return Math.floor(random() * maximum);
}

type LeaseEnvironment = Partial<Record<
  'ML_REPOSITORY_INDEX_TIMEOUT_MS' | 'OUTBOX_LEASE_MS',
  string | undefined
>>;

function positiveMilliseconds(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds.`);
  }
  return parsed;
}

export function resolveOutboxLeaseMs(
  environment: LeaseEnvironment = process.env as LeaseEnvironment,
): number {
  const repositoryTimeout = positiveMilliseconds(
    'ML_REPOSITORY_INDEX_TIMEOUT_MS',
    environment.ML_REPOSITORY_INDEX_TIMEOUT_MS,
    240_000,
  );
  const minimumLease = repositoryTimeout + 60_000;
  const lease = positiveMilliseconds('OUTBOX_LEASE_MS', environment.OUTBOX_LEASE_MS, minimumLease);
  if (lease < minimumLease) {
    throw new Error('OUTBOX_LEASE_MS must be at least 60 seconds longer than ML_REPOSITORY_INDEX_TIMEOUT_MS.');
  }
  return lease;
}

export class OutboxService {
  async status(): Promise<{
    pending: number;
    claimed: number;
    delivered: number;
    dead: number;
    superseded: number;
    oldest_pending_seconds: number;
  }> {
    const rows = await sqlClient`
      SELECT
        count(*) FILTER (WHERE status='pending')::int AS pending,
        count(*) FILTER (WHERE status='claimed')::int AS claimed,
        count(*) FILTER (WHERE status='delivered')::int AS delivered,
        count(*) FILTER (WHERE status='dead')::int AS dead,
        count(*) FILTER (WHERE status='superseded')::int AS superseded,
        COALESCE(EXTRACT(EPOCH FROM now()-min(created_at) FILTER (WHERE status='pending')),0)::int AS oldest_pending_seconds
      FROM telemetry.ml_outbox
    `;
    return {
      pending: Number(rows[0].pending), claimed: Number(rows[0].claimed), delivered: Number(rows[0].delivered),
      dead: Number(rows[0].dead), superseded: Number(rows[0].superseded),
      oldest_pending_seconds: Number(rows[0].oldest_pending_seconds),
    };
  }

  async claim(limit = 50, leaseMs = resolveOutboxLeaseMs()): Promise<OutboxRow[]> {
    const token = crypto.randomUUID();
    const rows = await sqlClient.begin(async (tx) => tx`
      WITH ready AS (
        SELECT candidate.outbox_id FROM telemetry.ml_outbox candidate
        WHERE (
          (candidate.status='pending' AND candidate.available_at<=now())
          OR (candidate.status='claimed' AND candidate.claimed_at < now()-(${leaseMs}::text || ' milliseconds')::interval)
        )
        AND (
          candidate.job_type<>'feedback'
          OR NOT EXISTS (
            SELECT 1 FROM telemetry.ml_outbox predecessor
            WHERE predecessor.job_type='feedback'
              AND predecessor.aggregate_id=candidate.aggregate_id
              AND predecessor.status<>'delivered'
              AND predecessor.payload->>'feedback_version' ~ '^[0-9]+$'
              AND candidate.payload->>'feedback_version' ~ '^[0-9]+$'
              AND (predecessor.payload->>'feedback_version')::numeric
                < (candidate.payload->>'feedback_version')::numeric
          )
        )
        ORDER BY
          CASE candidate.job_type
            WHEN 'onboard' THEN 0
            WHEN 'feedback' THEN 1
            WHEN 'repo_index' THEN 2
            ELSE 3
          END,
          candidate.created_at,
          CASE WHEN candidate.job_type='feedback' THEN candidate.aggregate_id END,
          CASE WHEN candidate.job_type='feedback'
            AND candidate.payload->>'feedback_version' ~ '^[0-9]+$'
            THEN (candidate.payload->>'feedback_version')::numeric END,
          candidate.outbox_id
        FOR UPDATE SKIP LOCKED LIMIT ${limit}
      )
      UPDATE telemetry.ml_outbox outbox SET status='claimed',claimed_at=now(),claim_token=${token}::uuid,
        attempts=outbox.attempts+1
      FROM ready WHERE outbox.outbox_id=ready.outbox_id
      RETURNING outbox.*
    `);
    return rows.map((row) => ({ ...row, outbox_id: String(row.outbox_id), aggregate_id: String(row.aggregate_id),
      idempotency_key: String(row.idempotency_key), job_type: row.job_type as OutboxRow['job_type'],
      attempts: Number(row.attempts), created_at: new Date(row.created_at as string).toISOString(),
      claim_token: String(row.claim_token), payload: row.payload as Record<string, unknown> }));
  }

  async markDelivered(row: OutboxRow, schedulePrewarm = false): Promise<boolean> {
    return sqlClient.begin(async (tx) => {
      const delivered = await tx`
        UPDATE telemetry.ml_outbox
        SET status='delivered',delivered_at=now(),claim_token=NULL,claimed_at=NULL,last_error=NULL,
          available_at=CASE WHEN job_type='onboard' AND ${schedulePrewarm} THEN now() ELSE available_at END,
          response_payload=CASE WHEN job_type='onboard' AND ${schedulePrewarm} THEN
            (CASE WHEN response_payload IS NULL THEN '{}'::jsonb
              WHEN jsonb_typeof(response_payload)='object' THEN response_payload
              ELSE jsonb_build_object('backend_original_response_payload',response_payload) END)
            || jsonb_build_object(
              'backend_onboarding_prewarm',jsonb_build_object(
                'status','pending','profile_version',payload->'profile_version',
                'feed_version',(SELECT feed_version::text FROM app.user_feed_state
                  WHERE user_id=aggregate_id),
                'attempts',0,'available_at',now(),'created_at',now(),
                'delivery_available_at',available_at
              )
            ) ELSE response_payload END
        WHERE outbox_id=${row.outbox_id}::uuid AND claim_token=${row.claim_token}::uuid
          AND status='claimed'
        RETURNING job_type
      `;
      // Delivery acknowledgement and durable scheduling commit together. Only
      // backend-owned metadata is used, never fields supplied by an ML response.
      if (schedulePrewarm && delivered[0]?.job_type === 'onboard') {
        await tx`SELECT pg_notify(${PREWARM_WAKE_CHANNEL}, '')`;
      }
      return delivered.length === 1;
    });
  }

  /**
   * Commits the versioned summary and repository-index response before the
   * claimed outbox row becomes delivered. The claim token fences expired
   * workers; locking repo_content prevents an older content response from
   * replacing the summary for a newer canonical README.
   */
  async completeRepositoryIndex(
    row: OutboxRow,
    response: MlRepositoryIndexResponse,
  ): Promise<boolean> {
    return sqlClient.begin(async (tx) => {
      const claimed = await tx`
        SELECT aggregate_id,payload
        FROM telemetry.ml_outbox
        WHERE outbox_id=${row.outbox_id}::uuid
          AND claim_token=${row.claim_token}::uuid
          AND status='claimed'
        FOR UPDATE
      `;
      if (!claimed[0]) return false;

      const payload = claimed[0].payload as Record<string, unknown>;
      const repositoryPayload = payload.repository;
      const claimedContentHash = repositoryPayload && typeof repositoryPayload === 'object'
        && !Array.isArray(repositoryPayload)
        ? (repositoryPayload as Record<string, unknown>).content_hash
        : null;
      if (String(claimed[0].aggregate_id) !== response.repo_id
        || payload.job_id !== response.job_id
        || payload.repo_id !== response.repo_id
        || payload.content_version !== response.content_version
        || typeof claimedContentHash !== 'string' || !claimedContentHash.trim()) {
        throw new RepositoryIndexCompletionConflictError(
          'Repository-index response does not match the claimed outbox payload.',
        );
      }

      // Ingestion locks the repository before its content. Use the same order
      // so the summary insert's repository FK cannot deadlock with ingestion.
      const repositories = await tx`
        SELECT repo_id FROM app.repos WHERE repo_id=${response.repo_id}::uuid FOR UPDATE
      `;
      if (!repositories[0]) {
        throw new RepositoryIndexCompletionConflictError('Repository no longer exists.');
      }
      const contentRows = await tx`
        SELECT content_version,content_hash
        FROM app.repo_content
        WHERE repo_id=${response.repo_id}::uuid
        FOR UPDATE
      `;
      if (!contentRows[0]) {
        throw new RepositoryIndexCompletionConflictError('Repository content no longer exists.');
      }
      const currentContentVersion = Number(contentRows[0].content_version);
      if (currentContentVersion < response.content_version) {
        throw new RepositoryIndexCompletionConflictError(
          'Repository-index response is newer than canonical repository content.',
        );
      }
      if (currentContentVersion === response.content_version
        && String(contentRows[0].content_hash) !== claimedContentHash) {
        throw new RepositoryIndexCompletionConflictError(
          'Repository-index payload hash does not match canonical repository content.',
        );
      }

      const artifact = response.card_summary;
      const source = repositoryPayload as { readme?: string | null; description?: string | null };
      validateRepositoryCardSummary(artifact, source);
      const summaries = await tx`
        SELECT * FROM app.repo_card_summaries
        WHERE repo_id=${response.repo_id}::uuid
          AND content_version=${response.content_version}
          AND prompt_version=${artifact.prompt_version}
          AND model_version=${artifact.model_version}
          AND format_version=${artifact.format_version}
        ORDER BY artifact_revision DESC
        FOR UPDATE
      `;
      // A valid first writer is immutable. Invalid historical rows remain
      // addressable by summary_id; only a new revision may supersede them.
      let persisted = summaries.find(candidate => isAcceptedStoredSummary(candidate, source));
      const predecessor = summaries[0];
      const repaired = !persisted && Boolean(predecessor);
      if (!persisted) {
        const inserted = await tx`
          INSERT INTO app.repo_card_summaries (
            repo_id,content_version,prompt_version,model_version,format_version,
            summary,highlights,source,active,artifact_revision,supersedes_summary_id
          ) VALUES (
            ${response.repo_id}::uuid,${response.content_version},${artifact.prompt_version},
            ${artifact.model_version},${artifact.format_version},${artifact.summary},
            ${JSON.stringify(artifact.highlights)}::jsonb,${artifact.source},false,
            ${predecessor ? Number(predecessor.artifact_revision) + 1 : 0},
            ${predecessor ? String(predecessor.summary_id) : null}::uuid
          ) RETURNING *
        `;
        persisted = inserted[0];
      }
      if (!persisted || !isAcceptedStoredSummary(persisted, source)) {
        throw new Error('A valid versioned repository summary was not persisted.');
      }
      const artifactDiverged = String(persisted.summary) !== artifact.summary
        || String(persisted.source) !== artifact.source
        || JSON.stringify(persisted.highlights) !== JSON.stringify(artifact.highlights);

      const generated = artifact.source === 'description_fallback'
        && currentContentVersion === response.content_version
        ? await tx`
          SELECT * FROM app.repo_card_summaries
          WHERE repo_id=${response.repo_id}::uuid
            AND content_version=${response.content_version}
            AND source='generated' AND active
          FOR UPDATE
        ` : [];
      // Preserve only generated content that still passes today's validator.
      const preserved = generated.find(candidate => isAcceptedStoredSummary(candidate, source));
      const activated = preserved ?? persisted;
      if (currentContentVersion === response.content_version) {
        await tx`
          UPDATE app.repo_card_summaries
          SET active=false
          WHERE repo_id=${response.repo_id}::uuid AND active
            AND summary_id<>${String(activated.summary_id)}::uuid
        `;
        await tx`
          UPDATE app.repo_card_summaries SET active=true
          WHERE summary_id=${String(activated.summary_id)}::uuid
        `;
      }

      const delivered = await tx`
        UPDATE telemetry.ml_outbox
        SET status='delivered',delivered_at=now(),claim_token=NULL,claimed_at=NULL,
            last_error=NULL,response_payload=${JSON.stringify({
              ...response,
              backend_persistence: {
                artifact_status: preserved ? 'generated_preserved' : repaired ? 'invalid_artifact_replaced'
                  : artifactDiverged ? 'first_writer_retained' : 'applied',
                summary_id: String(activated.summary_id),
                persisted_summary_id: String(persisted.summary_id),
                artifact_revision: Number(persisted.artifact_revision),
                supersedes_summary_id: persisted.supersedes_summary_id ?? null,
              },
            })}::jsonb
        WHERE outbox_id=${row.outbox_id}::uuid
          AND claim_token=${row.claim_token}::uuid
          AND status='claimed'
        RETURNING outbox_id
      `;
      if (delivered.length !== 1) throw new Error('Repository-index claim was lost before completion.');
      return true;
    });
  }

  async markFailed(row: OutboxRow, error: string, retryable: boolean, retryAfterMs?: number): Promise<void> {
    const ageMs = Date.now() - Date.parse(row.created_at);
    const dead = !retryable || row.attempts >= 10 || ageMs > 7 * 24 * 60 * 60_000;
    const delay = retryAfterMs == null ? retryDelayMs(row.attempts) : Math.min(15 * 60_000, Math.max(0, retryAfterMs));
    await sqlClient`
      UPDATE telemetry.ml_outbox SET status=${dead ? 'dead' : 'pending'},
        available_at=${new Date(Date.now() + delay).toISOString()}::timestamptz,
        claim_token=NULL,claimed_at=NULL,last_error=${error.slice(0, 4_000)}
      WHERE outbox_id=${row.outbox_id}::uuid AND claim_token=${row.claim_token}::uuid
    `;
  }

  async replay(outboxId: string): Promise<boolean> {
    return sqlClient.begin(async (tx) => {
      const rows = await tx`
        UPDATE telemetry.ml_outbox SET status='pending',attempts=0,available_at=now(),claimed_at=NULL,claim_token=NULL,last_error=NULL
        WHERE outbox_id=${outboxId}::uuid AND status='dead' RETURNING outbox_id
      `;
      if (rows.length) await notifyOutboxAfterCommit(tx);
      return rows.length === 1;
    });
  }

  async supersedeObsoleteOnboarding(outboxId: string): Promise<boolean> {
    return sqlClient.begin(async (tx) => {
      const rows = await tx`
        SELECT job_type,payload FROM telemetry.ml_outbox
        WHERE outbox_id=${outboxId}::uuid AND status='dead' FOR UPDATE
      `;
      const row = rows[0];
      if (!row || row.job_type !== 'onboard'
        || !isObsoleteIdentityOnboardingJob(row.payload as Record<string, unknown>)) return false;
      const updated = await tx`
        UPDATE telemetry.ml_outbox SET status='superseded',claim_token=NULL,claimed_at=NULL,
          last_error='Obsolete identity-only onboarding job superseded by embedding-context policy.'
        WHERE outbox_id=${outboxId}::uuid AND status='dead' RETURNING outbox_id
      `;
      return updated.length === 1;
    });
  }

  async supersedeRepositoryJobDeliveredBySuccessor(outboxId: string): Promise<boolean> {
    return sqlClient.begin(async (tx) => {
      const rows = await tx`
        SELECT outbox_id,job_type,aggregate_id,created_at
        FROM telemetry.ml_outbox
        WHERE outbox_id=${outboxId}::uuid AND status='dead'
          AND job_type IN ('repo_index','repo_refresh')
        FOR UPDATE
      `;
      const row = rows[0];
      if (!row) return false;
      const successors = await tx`
        SELECT 1 FROM telemetry.ml_outbox
        WHERE aggregate_id=${String(row.aggregate_id)}::uuid
          AND job_type IN ('repo_index','repo_refresh')
          AND status='delivered'
          AND created_at>=${row.created_at as string}::timestamptz
          AND outbox_id<>${outboxId}::uuid
        LIMIT 1
      `;
      if (successors.length === 0) return false;
      const updated = await tx`
        UPDATE telemetry.ml_outbox SET status='superseded',claim_token=NULL,claimed_at=NULL,
          last_error='Historical repository job superseded by a newer delivered canonical job.'
        WHERE outbox_id=${outboxId}::uuid AND status='dead' RETURNING outbox_id
      `;
      return updated.length === 1;
    });
  }
}
