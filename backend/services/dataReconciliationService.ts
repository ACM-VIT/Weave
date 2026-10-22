import { sqlClient } from '../db/index.js';
import { resolveOutboxLeaseMs } from './outboxService.js';
import type postgres from 'postgres';
import { performance } from 'node:perf_hooks';
import { observeMetric } from '../observability/metrics.js';

type Scope = 'repositories' | 'users';

export interface CounterBatchResult {
  scanned: number;
  locked: number;
  updated: number;
  skipped: number;
  sweepComplete: boolean;
  busy: boolean;
}

export interface CounterReconciliationResult {
  repositories: CounterBatchResult;
  users: CounterBatchResult;
  hasMore: boolean;
}

export const DEFAULT_COUNTER_BATCH_SIZE = 250;

export class DataReconciliationService {
  constructor(
    private readonly client: typeof sqlClient = sqlClient,
    private readonly batchSize = DEFAULT_COUNTER_BATCH_SIZE,
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
      throw new Error('Counter reconciliation batch size must be an integer between 1 and 1000.');
    }
  }

  async reconcileCounters(): Promise<CounterReconciliationResult> {
    const progress = await this.client`
      SELECT completed_sweeps FROM telemetry.counter_reconciliation_progress
      WHERE scope IN ('repositories','users')
    `;
    if (progress.length !== 2) throw new Error('Counter reconciliation progress is missing. Run database migrations.');
    // Pin the target before either transaction. Otherwise a smaller scope can
    // repeatedly start a new sweep while the larger scope is still catching up.
    const [repositorySweep, userSweep] = progress.map(row => BigInt(row.completed_sweeps));
    const targetSweep = (repositorySweep < userSweep ? repositorySweep : userSweep) + 1n;
    // Separate transactions avoid holding repository and user counter locks
    // together, or reversing the foreground repository -> user lock order.
    const repositories = await this.reconcileBatch('repositories', targetSweep);
    const users = await this.reconcileBatch('users', targetSweep);
    return { repositories, users, hasMore: [repositories, users].some(
      result => !result.sweepComplete || result.skipped > 0 || result.busy,
    ) };
  }

  private async reconcileBatch(scope: Scope, targetSweep: bigint): Promise<CounterBatchResult> {
    const started = performance.now();
    const result = await this.client.begin('isolation level read committed', async tx => {
      await tx`SELECT set_config('statement_timeout','3000',true),set_config('lock_timeout','250',true)`;
      const progress = await tx`
        SELECT last_id,upper_id,completed_sweeps FROM telemetry.counter_reconciliation_progress
        WHERE scope=${scope} FOR UPDATE SKIP LOCKED
      `;
      if (!progress.length) {
        const exists = await tx`SELECT 1 FROM telemetry.counter_reconciliation_progress WHERE scope=${scope}`;
        if (!exists.length) throw new Error('Counter reconciliation progress is missing. Run database migrations.');
        return { scanned: 0, locked: 0, updated: 0, skipped: 0, sweepComplete: false, busy: true };
      }
      if (BigInt(progress[0].completed_sweeps) >= targetSweep) {
        return { scanned: 0, locked: 0, updated: 0, skipped: 0, sweepComplete: true, busy: false };
      }
      const table = scope === 'repositories' ? 'app.repo_engagement' : 'app.user_stats';
      const column = scope === 'repositories' ? 'repo_id' : 'user_id';
      let upper = progress[0].upper_id as string | null;
      const last = progress[0].last_id as string | null;
      if (!upper) {
        const maximum = await tx.unsafe(`SELECT ${column} AS id FROM ${table} ORDER BY ${column} DESC LIMIT 1`);
        upper = (maximum[0]?.id as string | undefined) ?? null;
      }
      // Bound the candidate scan itself before locking, rather than letting
      // SKIP LOCKED scan an arbitrarily large locked prefix to fill a batch.
      const candidates = upper ? await tx.unsafe(`
        SELECT ${column} AS id FROM ${table}
        WHERE ($1::uuid IS NULL OR ${column}>$1::uuid) AND ${column}<=$2::uuid
        ORDER BY ${column} LIMIT $3
      `, [last, upper, this.batchSize]) : [];
      const ids = candidates.map(row => String(row.id));
      const locked = ids.length ? await tx.unsafe(`
        SELECT ${column} AS id FROM ${table} WHERE ${column}=ANY($1::uuid[])
        ORDER BY ${column} FOR UPDATE SKIP LOCKED
      `, [ids]) : [];
      const lockedIds = locked.map(row => String(row.id));
      // This MUST be a new READ COMMITTED statement after counter locks are
      // acquired. Counting in the locking statement can use an older snapshot
      // and overwrite a concurrent writer's committed increment after waiting.
      const updated = lockedIds.length
        ? scope === 'repositories' ? await this.repairRepositories(tx, lockedIds) : await this.repairUsers(tx, lockedIds)
        : [];
      const sweepComplete = candidates.length < this.batchSize || ids.at(-1) === upper;
      await tx`
        UPDATE telemetry.counter_reconciliation_progress
        SET last_id=${sweepComplete ? null : ids.at(-1)!}::uuid,
          upper_id=${sweepComplete ? null : upper}::uuid,
          completed_sweeps=completed_sweeps+${sweepComplete ? 1 : 0},updated_at=now()
        WHERE scope=${scope}
      `;
      return { scanned: ids.length, locked: lockedIds.length, updated: updated.length,
        skipped: ids.length-lockedIds.length, sweepComplete, busy: false };
    });
    observeMetric('counter_reconciliation_batch_ms', performance.now()-started, { scope });
    for (const outcome of ['scanned','updated','skipped'] as const) {
      observeMetric('counter_reconciliation_rows', result[outcome], { scope, outcome });
    }
    return result;
  }

  private repairRepositories(tx: postgres.TransactionSql, ids: string[]) {
    return tx`
      WITH reactions AS (
        SELECT repo_id,count(*) FILTER (WHERE reaction='like')::integer AS likes,
          count(*) FILTER (WHERE reaction='dislike')::integer AS dislikes
        FROM app.reactions WHERE repo_id=ANY(${ids}::uuid[]) GROUP BY repo_id
      ), saves AS (
        SELECT repo_id,count(*)::integer AS saves FROM app.saves WHERE repo_id=ANY(${ids}::uuid[]) GROUP BY repo_id
      ), comments AS (
        SELECT repo_id,count(*)::integer AS comments FROM app.comments WHERE repo_id=ANY(${ids}::uuid[]) GROUP BY repo_id
      ), impressions AS (
        SELECT repo_id,sum(impressions)::bigint AS views FROM telemetry.user_repo_engagement
        WHERE repo_id=ANY(${ids}::uuid[]) GROUP BY repo_id
      ), totals AS (
        SELECT id AS repo_id,COALESCE(r.likes,0) AS likes,COALESCE(r.dislikes,0) AS dislikes,
          COALESCE(s.saves,0) AS saves,COALESCE(c.comments,0) AS comments,COALESCE(i.views,0) AS views
        FROM unnest(${ids}::uuid[]) AS id
        LEFT JOIN reactions r ON r.repo_id=id LEFT JOIN saves s ON s.repo_id=id
        LEFT JOIN comments c ON c.repo_id=id LEFT JOIN impressions i ON i.repo_id=id
      )
      UPDATE app.repo_engagement e SET likes_count=t.likes,dislikes_count=t.dislikes,saves_count=t.saves,
        comments_count=t.comments,views_count=t.views,updated_at=now()
      FROM totals t WHERE e.repo_id=t.repo_id
        AND (e.likes_count,e.dislikes_count,e.saves_count,e.comments_count,e.views_count)
          IS DISTINCT FROM (t.likes,t.dislikes,t.saves,t.comments,t.views)
      RETURNING e.repo_id
    `;
  }

  private repairUsers(tx: postgres.TransactionSql, ids: string[]) {
    return tx`
      WITH reactions AS (
        SELECT user_id,count(*)::integer AS likes FROM app.reactions
        WHERE user_id=ANY(${ids}::uuid[]) AND reaction='like' GROUP BY user_id
      ), saves AS (
        SELECT user_id,count(*)::integer AS saves FROM app.saves WHERE user_id=ANY(${ids}::uuid[]) GROUP BY user_id
      ), totals AS (
        SELECT id AS user_id,COALESCE(r.likes,0) AS likes,COALESCE(s.saves,0) AS saves
        FROM unnest(${ids}::uuid[]) AS id
        LEFT JOIN reactions r ON r.user_id=id LEFT JOIN saves s ON s.user_id=id
      )
      UPDATE app.user_stats u SET likes_given_count=t.likes,saved_repos_count=t.saves,updated_at=now()
      FROM totals t WHERE u.user_id=t.user_id
        AND (u.likes_given_count,u.saved_repos_count) IS DISTINCT FROM (t.likes,t.saves)
      RETURNING u.user_id
    `;
  }

  async resetAbandonedClaims(leaseMs = resolveOutboxLeaseMs()): Promise<number> {
    const rows = await this.client`
      UPDATE telemetry.ml_outbox SET status='pending',claim_token=NULL,claimed_at=NULL,available_at=now()
      WHERE status='claimed' AND claimed_at < now()-(${leaseMs}::text || ' milliseconds')::interval RETURNING outbox_id
    `;
    return rows.length;
  }
}
