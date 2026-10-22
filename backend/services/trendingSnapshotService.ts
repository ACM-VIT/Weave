import { createHash } from 'node:crypto';
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
    private readonly now: () => number = Date.now,
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
    if (cached?.key === key && (cached.pending || this.now() < cached.expiresAt)) {
      incrementMetric('trending_snapshot_cache_total', { outcome: cached.pending ? 'coalesced' : 'hit' });
      return cached.response;
    }

    incrementMetric('trending_snapshot_cache_total', { outcome: 'miss' });
    const entry: CacheEntry = {
      key,
      // Start the freshness budget before hydration, not after a slow query.
      expiresAt: this.now() + TRENDING_FRESHNESS_MS,
      pending: true,
      response: Promise.resolve().then(async () => {
        const items = snapshot ? await this.source.cards(snapshot.snapshot_id) : [];
        const body = JSON.stringify({ success: true, data: { ...metadata, items } });
        return { body, etag: `"${createHash('sha256').update(body).digest('hex')}"` };
      }),
    };
    this.cache.set(period, entry);
    try {
      return await entry.response;
    } catch (error) {
      // A failed older request must not evict a newer snapshot's entry.
      if (this.cache.get(period) === entry) this.cache.delete(period);
      throw error;
    } finally {
      entry.pending = false;
    }
  }
}
