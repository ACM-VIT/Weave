import crypto from 'node:crypto';

import { sqlClient } from '../db/index.js';
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

export function retryDelayMs(attempt: number, random = Math.random): number {
  const cap = 15 * 60_000;
  const maximum = Math.min(cap, 1_000 * 2 ** Math.max(0, attempt));
  return Math.floor(random() * maximum);
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

  async claim(limit = 50, leaseMs = 60_000): Promise<OutboxRow[]> {
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
        AND (
          candidate.job_type<>'repo_refresh'
          OR (
            EXISTS (
              SELECT 1 FROM telemetry.ml_outbox delivered_index
              WHERE delivered_index.aggregate_id=candidate.aggregate_id
                AND delivered_index.job_type='repo_index'
                AND delivered_index.status='delivered'
            )
            AND NOT EXISTS (
              SELECT 1 FROM telemetry.ml_outbox predecessor_index
              WHERE predecessor_index.aggregate_id=candidate.aggregate_id
                AND predecessor_index.job_type='repo_index'
                AND predecessor_index.created_at<=candidate.created_at
                AND predecessor_index.status<>'delivered'
                AND NOT EXISTS (
                  SELECT 1 FROM telemetry.ml_outbox successor_index
                  WHERE successor_index.aggregate_id=predecessor_index.aggregate_id
                    AND successor_index.job_type='repo_index'
                    AND successor_index.status='delivered'
                    AND successor_index.created_at>=predecessor_index.created_at
                )
            )
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

  async markDelivered(row: OutboxRow): Promise<void> {
    await sqlClient`
      UPDATE telemetry.ml_outbox SET status='delivered',delivered_at=now(),claim_token=NULL,claimed_at=NULL,last_error=NULL
      WHERE outbox_id=${row.outbox_id}::uuid AND claim_token=${row.claim_token}::uuid
    `;
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
              AND successor.status='delivered'
              AND successor.created_at>=dead.created_at
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
