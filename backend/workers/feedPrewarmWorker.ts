import { performance } from 'node:perf_hooks';
import { FeedPrewarmService } from '../services/feedPrewarmService.js';
import type { FeedGenerationService } from '../services/feedGenerationService.js';
import { observeMetric } from '../observability/metrics.js';
import type { AdaptiveWorkerReport } from '../runtime/workerSupervisor.js';
import { workerErrorSummary } from '../runtime/workerError.js';

export class FeedPrewarmWorker {
  constructor(
    private readonly queue: Pick<FeedPrewarmService, 'claim' | 'finish' | 'retry' | 'nextRunInMs' | 'isCurrent' | 'expire'>,
    private readonly generation: Pick<FeedGenerationService, 'generate'>,
  ) {}

  async runOnce(): Promise<AdaptiveWorkerReport> {
    const expired = await this.queue.expire();
    const job = await this.queue.claim();
    if (!job) return { processed: expired, nextRunInMs: await this.queue.nextRunInMs() };
    const started = performance.now();
    try {
      const result = await this.generation.generate(job.userId, 45, [], 'prewarm', undefined, {
        feedVersion: job.feedVersion,
        isCurrent: () => this.queue.isCurrent(job),
      });
      await this.queue.finish(job, result);
    } catch (error) {
      console.error('[FeedPrewarm] Generation failed; scheduling durable retry:', workerErrorSummary(error));
      await this.queue.retry(job);
    } finally {
      observeMetric('feed_prewarm_run_ms', performance.now()-started);
    }
    return { processed: 1 };
  }
}
