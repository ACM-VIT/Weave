import crypto from 'node:crypto';
import { sqlClient } from '../db/index.js';
import type { FeedGenerationOutcome } from './feedGenerationService.js';

export interface PrewarmJob { userId: string; feedVersion: bigint; profileVersion: bigint; claimToken: string; attempts: number }

/** One durable slot per user; SKIP LOCKED plus expiring tokens fences workers. */
export class FeedPrewarmService {
  constructor(private readonly client = sqlClient, private readonly leaseMs = 60_000) {
    if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new Error('Prewarm lease must be a positive integer.');
  }

  async claim(): Promise<PrewarmJob | null> {
    const token = crypto.randomUUID();
    const rows = await this.client.begin(async tx => tx`
      WITH ready AS (
        SELECT job.user_id,state.feed_version FROM telemetry.feed_prewarm_jobs job
        JOIN app.users u ON u.user_id=job.user_id AND u.status='active' AND job.profile_version=u.profile_version
        JOIN app.user_feed_state state ON state.user_id=job.user_id
        WHERE job.scheduled_at>now()-interval '7 days'
          AND ((job.status='pending' AND job.available_at<=now())
          OR (job.status='claimed' AND job.claimed_at<now()-(${this.leaseMs}::text || ' milliseconds')::interval))
        ORDER BY job.available_at,job.user_id FOR UPDATE OF job SKIP LOCKED LIMIT 1
      )
      UPDATE telemetry.feed_prewarm_jobs job SET status='claimed',feed_version=ready.feed_version,
        claim_token=${token}::uuid,claimed_at=now(),attempts=job.attempts+1
      FROM ready WHERE job.user_id=ready.user_id RETURNING job.*
    `);
    const row = rows[0];
    return row ? { userId: String(row.user_id),feedVersion: BigInt(row.feed_version),profileVersion: BigInt(row.profile_version),
      claimToken: token,attempts: Number(row.attempts) } : null;
  }

  async finish(job: PrewarmJob, outcome: FeedGenerationOutcome): Promise<void> {
    // A stale/coalesced attempt is not completion. The next claim adopts the
    // current feed version and retries after other generation work can finish.
    await this.client`
      UPDATE telemetry.feed_prewarm_jobs job SET
        status=CASE WHEN ${outcome.status === 'generated' || outcome.status === 'satisfied'} AND state.feed_version=${outcome.feedVersion.toString()}::bigint
          AND u.status='active' AND u.profile_version=job.profile_version
          THEN 'completed' ELSE 'pending' END,
        feed_version=state.feed_version,claim_token=NULL,claimed_at=NULL,
        available_at=now()+interval '1 second',last_error=NULL
      FROM app.user_feed_state state JOIN app.users u ON u.user_id=state.user_id WHERE job.user_id=${job.userId}::uuid
        AND state.user_id=job.user_id AND job.claim_token=${job.claimToken}::uuid AND job.status='claimed'
        AND job.feed_version=${job.feedVersion.toString()}::bigint
        AND job.profile_version=${job.profileVersion.toString()}::bigint
        AND job.claimed_at>now()-(${this.leaseMs}::text || ' milliseconds')::interval
        AND job.scheduled_at>now()-interval '7 days'
    `;
  }

  async nextRunInMs(): Promise<number | undefined> {
    const rows = await this.client`
      SELECT (extract(epoch FROM (min(CASE WHEN job.status='pending' THEN job.available_at
        ELSE job.claimed_at+(${this.leaseMs}::text || ' milliseconds')::interval END)-now()))*1000)
        ::double precision AS delay_ms
      FROM telemetry.feed_prewarm_jobs job
      JOIN app.users u ON u.user_id=job.user_id AND u.status='active' AND job.profile_version=u.profile_version
      JOIN app.user_feed_state state ON state.user_id=job.user_id
      WHERE job.status IN ('pending','claimed') AND job.scheduled_at>now()-interval '7 days'
    `;
    return rows[0]?.delay_ms == null ? undefined : Math.max(0, Math.ceil(Number(rows[0].delay_ms)));
  }

  async isCurrent(job: PrewarmJob): Promise<boolean> {
    const rows = await this.client`
      SELECT 1 FROM telemetry.feed_prewarm_jobs target
      JOIN app.users u ON u.user_id=target.user_id AND u.status='active'
      JOIN app.user_feed_state state ON state.user_id=target.user_id
      WHERE target.user_id=${job.userId}::uuid AND target.status='claimed'
        AND target.claim_token=${job.claimToken}::uuid
        AND target.profile_version=${job.profileVersion.toString()}::bigint
        AND u.profile_version=target.profile_version
        AND target.feed_version=${job.feedVersion.toString()}::bigint
        AND state.feed_version=target.feed_version
        AND target.claimed_at>now()-(${this.leaseMs}::text || ' milliseconds')::interval
        AND target.scheduled_at>now()-interval '7 days'
    `;
    return rows.length === 1;
  }

  /** Bound cleanup work; retries never move the original scheduling horizon. */
  async expire(): Promise<number> {
    const rows = await this.client`
      WITH expired AS (
        SELECT user_id FROM telemetry.feed_prewarm_jobs
        WHERE status IN ('pending','claimed') AND scheduled_at<=now()-interval '7 days'
        ORDER BY scheduled_at,user_id FOR UPDATE SKIP LOCKED LIMIT 100
      )
      UPDATE telemetry.feed_prewarm_jobs job SET status='expired',claim_token=NULL,claimed_at=NULL,
        last_error='retry_horizon_expired'
      FROM expired WHERE job.user_id=expired.user_id RETURNING job.user_id
    `;
    return rows.length;
  }

  async status(): Promise<Record<string, number>> {
    // Cardinality is one row/user, with a hard query budget for the operations endpoint.
    return this.client.begin(async tx => {
      await tx`SET LOCAL statement_timeout='2000ms'`;
      const rows = await tx`
        SELECT count(*) FILTER (WHERE status='pending')::int AS pending,
          count(*) FILTER (WHERE status='claimed')::int AS claimed,
          count(*) FILTER (WHERE status='expired')::int AS expired,
          count(*) FILTER (WHERE status IN ('pending','claimed') AND attempts>1)::int AS retrying,
          count(*) FILTER (WHERE status='claimed' AND claimed_at<=now()-(${this.leaseMs}::text || ' milliseconds')::interval)::int AS expired_claims,
          coalesce(extract(epoch FROM now()-min(scheduled_at) FILTER (WHERE status IN ('pending','claimed'))),0)::int AS oldest_pending_seconds
        FROM telemetry.feed_prewarm_jobs
      `;
      return Object.fromEntries(Object.entries(rows[0]).map(([key,value]) => [key,Number(value)]));
    });
  }

  async retry(job: PrewarmJob): Promise<void> {
    const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(job.attempts, 6));
    await this.client`
      UPDATE telemetry.feed_prewarm_jobs SET status='pending',claim_token=NULL,claimed_at=NULL,
        available_at=now()+(${delayMs}::text || ' milliseconds')::interval,last_error='generation_failed'
      WHERE user_id=${job.userId}::uuid AND claim_token=${job.claimToken}::uuid AND status='claimed'
        AND scheduled_at>now()-interval '7 days'
        AND claimed_at>now()-(${this.leaseMs}::text || ' milliseconds')::interval
    `;
  }
}
