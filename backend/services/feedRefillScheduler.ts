import { incrementMetric } from '../observability/metrics.js';

interface RefillJob {
  userId: string;
  version: bigint;
  sessionId: string;
}

/** Best-effort precomputation. An unserved queue is never a durable obligation. */
export class FeedRefillScheduler {
  private readonly jobs = new Map<string, RefillJob>();
  private readonly pending: string[] = [];
  private readonly active = new Set<Promise<void>>();
  private scheduled = false;
  private stopping = false;

  constructor(
    readonly lowWatermark: number,
    private readonly refill: (job: RefillJob) => Promise<unknown>,
    private readonly capacity = 128,
    private readonly concurrency = 2,
  ) {
    if (!Number.isInteger(lowWatermark) || lowWatermark < 1 || lowWatermark > 99
      || !Number.isInteger(capacity) || capacity < 1 || capacity > 128
      || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) {
      throw new Error('Feed refill scheduler exceeds its bounded capacity.');
    }
  }

  schedule(userId: string, version: bigint, sessionId: string): void {
    if (this.stopping) return;
    const key = JSON.stringify([userId, version.toString()]);
    if (this.jobs.has(key)) return;
    if (this.jobs.size >= this.capacity) {
      incrementMetric('feed_v2_prefill_capacity_skips_total');
      return;
    }
    this.jobs.set(key, { userId, version, sessionId });
    this.pending.push(key);
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => { this.scheduled = false; this.drain(); });
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const key of this.pending) this.jobs.delete(key);
    this.pending.length = 0;
    // These are actual generations, including lock release, not timed observers.
    await Promise.allSettled(this.active);
  }

  private drain(): void {
    while (!this.stopping && this.active.size < this.concurrency && this.pending.length > 0) {
      const key = this.pending.shift()!;
      const job = this.jobs.get(key)!;
      // Retain the key and worker slot until the actual generation settles.
      // A timeout/cancelled observer must not create overlapping background work.
      const work: Promise<void> = Promise.resolve().then(async () => { await this.refill(job); }).catch(error => {
        incrementMetric('feed_v2_prefill_failures_total');
        console.error('[FeedRefillScheduler] Background refill failed:', error);
      }).finally(() => {
        this.active.delete(work);
        this.jobs.delete(key);
        this.drain();
      });
      this.active.add(work);
    }
  }
}
