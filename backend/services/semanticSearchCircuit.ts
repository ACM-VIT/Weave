import { performance } from 'node:perf_hooks';
import { incrementMetric, observeMetric } from '../observability/metrics.js';

export class SemanticSearchUnavailableError extends Error {}

/** One bounded, process-local circuit for semantic retrieval, never other ML APIs. */
export class SemanticSearchCircuit {
  private failures = 0;
  private openUntil = 0;
  private epoch = 0;
  private active = 0;
  private probe = false;

  constructor(
    private readonly budgetMs = 1_800,
    private readonly cooldownMs = 10_000,
    private readonly now = () => performance.now(),
  ) {}

  async run<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const started = this.now();
    const recovering = this.openUntil !== 0;
    if ((recovering && (started < this.openUntil || this.probe)) || this.active >= 8) {
      incrementMetric('search_semantic_requests', { outcome: 'skipped' });
      throw new SemanticSearchUnavailableError('Semantic search circuit is unavailable.');
    }
    if (recovering) this.probe = true;
    const epoch = this.epoch;
    this.active++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    let outcome = 'success';
    let expired = false;
    // Admission is retained until the actual transport settles, even if it ignores abort.
    const work = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    }).finally(() => {
      this.active--;
      if (recovering) this.probe = false;
    });
    const interrupted = new Promise<never>((_resolve, reject) => {
      cancel = () => {
        reject(signal!.reason);
        controller.abort(signal!.reason);
      };
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => {
        expired = true;
        const error = new SemanticSearchUnavailableError('Semantic search latency budget exceeded.');
        reject(error);
        controller.abort(error);
      }, this.budgetMs);
    });
    try {
      const value = await Promise.race([work, interrupted]);
      signal?.throwIfAborted();
      if (epoch === this.epoch) {
        this.failures = 0;
        this.openUntil = 0;
        if (recovering) incrementMetric('search_semantic_circuit', { transition: 'recovered' });
      }
      return value;
    } catch (error) {
      outcome = signal?.aborted ? 'cancelled' : expired ? 'timeout' : 'failure';
      if (outcome !== 'cancelled' && epoch === this.epoch) {
        if (recovering || ++this.failures >= 3) {
          this.openUntil = this.now() + this.cooldownMs;
          this.epoch++;
          incrementMetric('search_semantic_circuit', { transition: 'opened' });
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (cancel) signal?.removeEventListener('abort', cancel);
      incrementMetric('search_semantic_requests', { outcome });
      observeMetric('search_semantic_duration_ms', this.now() - started, { outcome });
    }
  }
}
