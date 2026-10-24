import { setImmediate as yieldTurn, setTimeout as delay } from 'node:timers/promises';
import type { ReadmeSummaryService } from '../services/readmeSummaryService.js';

type Result = Awaited<ReturnType<ReadmeSummaryService['processOne']>>;
const STOP_ERRORS = new Set(['summary_provider_daily_quota_exhausted', 'summary_provider_policy_blocked',
  'summary_provider_http_401', 'summary_provider_http_403']);

/** Independent processing slots share the service's generator and RPM limiter. */
export async function runReadmeSummaryWorker(service: Pick<ReadmeSummaryService, 'processOne'>, options: {
  limit: number; concurrency: number; once: boolean; repoIds?: string[]; signal?: AbortSignal;
  onResult: (result: Result) => void;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Promise<{ processed: number; failures: number }> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new RangeError('--limit must be 1–100');
  // Two jobs bound provider admission/repair waits conservatively against the
  // existing five-minute job lease, including the minimum supported 1 RPM.
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 2) {
    throw new RangeError('--concurrency must be 1–2');
  }
  const stopped = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, stopped.signal]) : stopped.signal;
  const sleep = options.sleep ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  let issued = 0, processed = 0, failures = 0, exhausted = false;
  const worker = async () => {
    try {
      let turn = 0;
      while (!signal.aborted && !(options.once && (exhausted || issued >= options.limit))) {
        if (options.once) issued++;
        const result = await service.processOne(options.repoIds);
        if (result.status === 'idle') {
          if (options.once) { exhausted = true; return; }
          try { await sleep(3_000, signal); }
          catch (error) { if (!signal.aborted) throw error; }
          continue;
        }
        processed++;
        if (result.status === 'failed' || result.status === 'retry_scheduled') failures++;
        if (STOP_ERRORS.has(result.error ?? '')) stopped.abort();
        options.onResult(result);
        // A slow peer never blocks ready backlog. The daemon yields after each
        // --limit-sized turn; only an empty ready queue incurs the idle delay.
        if (!options.once && ++turn >= options.limit) { turn = 0; await yieldTurn(); }
      }
    } catch (error) { stopped.abort(); throw error; }
  };
  const results = await Promise.allSettled(Array.from({ length: options.concurrency }, worker));
  // Own every already-started processOne through shutdown, including when a
  // peer's claim/storage/logging throws. The CLI must not close SQL early.
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected) throw rejected.reason;
  return { processed, failures };
}
