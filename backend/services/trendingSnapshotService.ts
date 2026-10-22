import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { incrementMetric } from '../observability/metrics.js';

export type TrendingPeriod = 'daily' | 'weekly' | 'monthly';

export interface TrendingSnapshot {
  period: TrendingPeriod;
  snapshot_id: string;
  captured_at: Date | string;
  activation_version?: string | null;
}

export interface TrendingSnapshotSource {
  available(): Promise<readonly TrendingSnapshot[]>;
  cards(snapshotId: string): Promise<readonly Record<string, unknown>[]>;
}

export interface TrendingResponse {
  readonly body: string;
  readonly etag: string;
}

// Each API process holds at most three 100-card responses. Counters, content,
// summaries and repository status can be stale for at most this cache lifetime.
export const TRENDING_FRESHNESS_MS = 5_000;
export const TRENDING_QUERY_TIMEOUT_MS = 4_000;

export class TrendingUnavailableError extends Error {
  readonly statusCode = 503;
  constructor() { super('Trending refresh is temporarily unavailable. Try again shortly.'); }
}

interface CacheEntry {
  key: string;
  expiresAt: number;
  pending: boolean;
  response: Promise<TrendingResponse>;
}

export class TrendingSnapshotService {
  private readonly cache = new Map<TrendingPeriod, CacheEntry>();

  constructor(
    private readonly source: TrendingSnapshotSource,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async get(requestedPeriod?: TrendingPeriod): Promise<TrendingResponse> {
    // Revalidate the active snapshot on every request, including conditional
    // requests. This also works when ingestion runs in another process and
    // avoids relying on a local invalidation signal or another Redis cache.
    const available = await this.source.available();
    const period = available.find(row => row.period === requestedPeriod)?.period
      ?? available.find(row => row.period === 'daily')?.period
      ?? available[0]?.period ?? 'daily';
    const snapshot = available.find(row => row.period === period);
    const metadata = {
      period,
      available_periods: available.map(row => row.period),
      captured_at: snapshot ? new Date(snapshot.captured_at).toISOString() : null,
    };
    // Ingestion can replace the items of an existing snapshot ID on replay.
    // Its activation timestamp is the version fence even if computed_at stays put.
    const key = JSON.stringify([
      snapshot?.snapshot_id ?? null,
      snapshot?.activation_version ?? null,
      metadata,
    ]);
    const cached = this.cache.get(period);
    if (cached?.key === key && this.now() < cached.expiresAt) {
      incrementMetric('trending_snapshot_cache_total', { outcome: cached.pending ? 'coalesced' : 'hit' });
      return cached.response;
    }
    // At most one hydration per period may own a database slot. Expired work
    // must not accept new waiters or release admission before the query exits,
    // even if a new snapshot is activated while the old query is still running.
    if (cached?.pending) throw new TrendingUnavailableError();

    incrementMetric('trending_snapshot_cache_total', { outcome: 'miss' });
    const entry: CacheEntry = {
      key,
      // Start the freshness budget before hydration, not after a slow query.
      expiresAt: this.now() + TRENDING_FRESHNESS_MS,
      pending: true,
      response: Promise.resolve().then(async () => {
        const items = snapshot ? await this.source.cards(snapshot.snapshot_id) : [];
        if (this.now() >= entry.expiresAt) throw new TrendingUnavailableError();
        const body = JSON.stringify({ success: true, data: { ...metadata, items } });
        const response = { body, etag: `"${createHash('sha256').update(body).digest('hex')}"` };
        if (this.now() >= entry.expiresAt) throw new TrendingUnavailableError();
        return response;
      }),
    };
    this.cache.set(period, entry);
    const work = entry.response;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new TrendingUnavailableError()), TRENDING_FRESHNESS_MS);
    });
    entry.response = Promise.race([work, deadline]).finally(() => clearTimeout(timer));
    const release = (failed: boolean) => {
      entry.pending = false;
      // Deadline response completion is not query completion. Keep admission
      // occupied until work settles, and preserve identity-checked eviction.
      if ((failed || this.now() >= entry.expiresAt) && this.cache.get(period) === entry) this.cache.delete(period);
    };
    void work.then(() => release(false), () => release(true));
    return entry.response;
  }
}
