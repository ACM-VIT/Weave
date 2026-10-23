import crypto from 'node:crypto';
import { validateRepositoryCardSummary } from './mlService.js';
import { isAcceptedStoredSummary } from './storedRepositorySummary.js';

import { sqlClient } from '../db/index.js';
import type { MlRepositoryIndexResponse } from '../contracts/ml.v2.js';
import { isObsoleteIdentityOnboardingJob } from './mlOnboardingService.js';

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

export interface OutboxClaimOptions {
  jobTypes?: readonly OutboxRow['job_type'][];
  /** Retry slots never compete with first-attempt feedback batches. */
  attempts?: 'first' | 'retry';
}

function validateClaim(limit: number, options: OutboxClaimOptions): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('Outbox claim limit must be an integer between 1 and 1000.');
  }
  if (options.jobTypes && (!options.jobTypes.length || options.jobTypes.some(type =>
    !['feedback', 'onboard', 'repo_index', 'repo_refresh'].includes(type)))) {
    throw new Error('Outbox claim requires valid job types.');
  }
  if (options.attempts && !['first', 'retry'].includes(options.attempts)) {
    throw new Error('Outbox claim attempt filter is invalid.');
  }
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

  async claim(limit = 50, leaseMs = resolveOutboxLeaseMs(), options: OutboxClaimOptions = {}): Promise<OutboxRow[]> {
    validateClaim(limit, options);
    const token = crypto.randomUUID();
    const rows = await sqlClient.begin(async (tx) => tx`
      WITH ready AS (
        SELECT candidate.outbox_id FROM telemetry.ml_outbox candidate
        WHERE (
          (candidate.status='pending' AND candidate.available_at<=now())
          OR (candidate.status='claimed' AND candidate.claimed_at < now()-(${leaseMs}::text || ' milliseconds')::interval)
        )
        AND candidate.job_type=ANY(${options.jobTypes ?? ['feedback', 'onboard', 'repo_index', 'repo_refresh']}::text[])
        AND (${options.attempts ?? null}::text IS NULL
          OR (${options.attempts ?? null}='first' AND candidate.attempts=0)
          OR (${options.attempts ?? null}='retry' AND candidate.attempts>0))
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
        AND (
          candidate.job_type<>'repo_refresh'
          OR EXISTS (
            SELECT 1 FROM telemetry.ml_outbox delivered_index
            LEFT JOIN app.repo_content canonical ON canonical.repo_id=candidate.aggregate_id
            CROSS JOIN LATERAL (
              -- Missing metadata denotes a legacy job. Never treat malformed
              -- present metadata as legacy or infer dependencies from timestamps.
              SELECT CASE WHEN candidate.payload ? 'required_content_version'
                THEN candidate.payload->>'required_content_version'
                ELSE canonical.content_version::text END AS content_version
            ) required_index
            WHERE delivered_index.aggregate_id=candidate.aggregate_id
              AND delivered_index.job_type='repo_index'
              AND delivered_index.status='delivered'
              AND CASE
                WHEN delivered_index.payload->>'content_version' ~ '^[1-9][0-9]{0,9}$'
                  AND required_index.content_version ~ '^[1-9][0-9]{0,9}$'
                THEN CASE
                  WHEN (delivered_index.payload->>'content_version')::bigint <= 2147483647
                    AND required_index.content_version::bigint <= 2147483647
                  THEN (delivered_index.payload->>'content_version')::bigint
                    >= required_index.content_version::bigint
                  ELSE false
                END
                ELSE false
              END
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

  /** Future retry/lease deadlines are hints; polling remains the recovery path. */
  async nextRunInMs(options: OutboxClaimOptions): Promise<number | undefined> {
    validateClaim(1, options);
    const leaseMs = resolveOutboxLeaseMs();
    const rows = await sqlClient`
      SELECT EXTRACT(EPOCH FROM min(deadline)-now())*1000 AS delay_ms
      FROM (
        SELECT CASE WHEN status='pending' THEN available_at
          ELSE claimed_at+(${leaseMs}::text || ' milliseconds')::interval END AS deadline
        FROM telemetry.ml_outbox
        WHERE status IN ('pending','claimed')
          AND job_type=ANY(${options.jobTypes ?? ['feedback', 'onboard', 'repo_index', 'repo_refresh']}::text[])
          AND (${options.attempts ?? null}::text IS NULL
            OR (${options.attempts ?? null}='first' AND attempts=0)
            OR (${options.attempts ?? null}='retry' AND attempts>0))
      ) eligible WHERE deadline>now()
    `;
    return rows[0]?.delay_ms == null ? undefined : Math.max(0, Number(rows[0].delay_ms));
  }

  /**
   * Last local admission before onboarding transport. This transaction shares
   * user -> outbox lock order with profile/consent changes and ends before I/O.
   * Admission preceding revocation is already in flight: it cannot be unsent.
   * Versioned ML application and current-version readiness remain authoritative.
   */
  async prepareOnboardingDelivery(row: OutboxRow): Promise<boolean> {
    if (row.job_type !== 'onboard') return false;
    return sqlClient.begin(async tx => {
      const [profile] = await tx`SELECT profile_version,status FROM app.users
        WHERE user_id=${row.aggregate_id}::uuid FOR UPDATE`;
      const [claimed] = await tx`SELECT payload FROM telemetry.ml_outbox
        WHERE outbox_id=${row.outbox_id}::uuid AND aggregate_id=${row.aggregate_id}::uuid
          AND job_type='onboard' AND status='claimed' AND claim_token=${row.claim_token}::uuid
        FOR UPDATE`;
      if (!claimed) return false;
      const payload = claimed.payload as Record<string, unknown>;
      if (profile?.status === 'active'
        && payload.user_id === row.aggregate_id && row.payload.user_id === row.aggregate_id
        && String(payload.profile_version) === String(profile.profile_version)
        && String(row.payload.profile_version) === String(profile.profile_version)) return true;
      await tx`UPDATE telemetry.ml_outbox SET status='superseded',claim_token=NULL,claimed_at=NULL,
          last_error='Onboarding context no longer matches the current active profile.'
        WHERE outbox_id=${row.outbox_id}::uuid AND status='claimed'
          AND claim_token=${row.claim_token}::uuid`;
      return false;
    });
  }

  async markDelivered(row: OutboxRow): Promise<void> {
    await sqlClient`
      UPDATE telemetry.ml_outbox SET status='delivered',delivered_at=now(),claim_token=NULL,claimed_at=NULL,last_error=NULL
      WHERE outbox_id=${row.outbox_id}::uuid AND claim_token=${row.claim_token}::uuid
    `;
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
    const rows = await sqlClient`
      UPDATE telemetry.ml_outbox SET status='pending',attempts=0,available_at=now(),claimed_at=NULL,claim_token=NULL,last_error=NULL
      WHERE outbox_id=${outboxId}::uuid AND status='dead' RETURNING outbox_id
    `;
    return rows.length === 1;
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
        SELECT outbox_id,job_type,aggregate_id,created_at,payload->>'content_version' AS content_version
        FROM telemetry.ml_outbox
        WHERE outbox_id=${outboxId}::uuid AND status='dead'
          AND job_type IN ('repo_index','repo_refresh')
        FOR UPDATE
      `;
      const row = rows[0];
      if (!row) return false;
      // Validate stored text before binding a numeric SQL constant. CASE cannot
      // make a planner-folded cast of malformed parameter text safe.
      const rawContentVersion = String(row.content_version ?? '');
      const contentVersion = /^[1-9][0-9]{0,9}$/.test(rawContentVersion)
        ? Number(rawContentVersion) : null;
      if (row.job_type === 'repo_index' && (contentVersion === null || contentVersion > 2147483647)) return false;
      const successors = await tx`
        SELECT 1 FROM telemetry.ml_outbox
        WHERE aggregate_id=${String(row.aggregate_id)}::uuid
          AND job_type IN ('repo_index','repo_refresh')
          AND (${String(row.job_type)} <> 'repo_index' OR job_type='repo_index')
          AND status='delivered'
          AND CASE WHEN ${String(row.job_type)}='repo_index'
            THEN CASE
              WHEN payload->>'content_version' ~ '^[1-9][0-9]{0,9}$'
              THEN CASE
                WHEN (payload->>'content_version')::bigint <= 2147483647
                THEN (payload->>'content_version')::bigint >= ${contentVersion}::integer
                ELSE false
              END
              ELSE false
            END
            ELSE created_at>=${row.created_at as string}::timestamptz
          END
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

  async reconcileSupersededRepositoryJobs(limit = 100): Promise<number> {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    const rows = await sqlClient`
      WITH repairable AS (
        SELECT dead.outbox_id
        FROM telemetry.ml_outbox dead
        WHERE dead.status='dead'
          AND dead.job_type IN ('repo_index','repo_refresh')
          AND EXISTS (
            SELECT 1 FROM telemetry.ml_outbox successor
            WHERE successor.aggregate_id=dead.aggregate_id
              AND successor.job_type IN ('repo_index','repo_refresh')
              -- A metadata refresh cannot repair a failed content index.
              AND (dead.job_type <> 'repo_index' OR successor.job_type='repo_index')
              AND successor.status='delivered'
              AND CASE WHEN dead.job_type='repo_index'
                THEN CASE
                  WHEN dead.payload->>'content_version' ~ '^[1-9][0-9]{0,9}$'
                    AND successor.payload->>'content_version' ~ '^[1-9][0-9]{0,9}$'
                  THEN CASE
                    WHEN (dead.payload->>'content_version')::bigint <= 2147483647
                      AND (successor.payload->>'content_version')::bigint <= 2147483647
                    THEN (successor.payload->>'content_version')::bigint
                      >= (dead.payload->>'content_version')::bigint
                    ELSE false
                  END
                  ELSE false
                END
                ELSE successor.created_at>=dead.created_at
              END
              AND successor.outbox_id<>dead.outbox_id
          )
        ORDER BY dead.created_at
        LIMIT ${boundedLimit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE telemetry.ml_outbox dead
      SET status='superseded',claim_token=NULL,claimed_at=NULL,
          last_error='Historical repository job superseded by a delivered canonical successor.'
      FROM repairable
      WHERE dead.outbox_id=repairable.outbox_id
      RETURNING dead.outbox_id
    `;
    return rows.length;
  }
}
