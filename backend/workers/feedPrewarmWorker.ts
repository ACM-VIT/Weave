import { performance } from 'node:perf_hooks';
import { FeedPrewarmService } from '../services/feedPrewarmService.js';
import type { FeedGenerationService } from '../services/feedGenerationService.js';
import { observeMetric } from '../observability/metrics.js';

export class FeedPrewarmWorker {
  constructor(
    private readonly queue: FeedPrewarmService,
    private readonly generation: Pick<FeedGenerationService, 'generate'>,
  ) {}

  async runOnce(): Promise<number> {
    const job = await this.queue.claim();
    if (!job) return 0;
    const started = performance.now();
    try {
      const result = await this.generation.generate(job.userId, 45, [], 'prewarm');
      await this.queue.finish(job, result);
    } catch (error) {
      await this.queue.retry(job);
      console.error('[FeedPrewarm] Generation failed; durable retry scheduled.');
    } finally {
      observeMetric('feed_prewarm_run_ms', performance.now()-started);
    }
    return 1;
  }
}
