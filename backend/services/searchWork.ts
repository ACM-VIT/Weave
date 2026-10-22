import { performance } from 'node:perf_hooks';

const SEARCH_BUDGET_MS = 5_000;
const SEARCH_STATEMENT_MS = 1_800;

export type SearchWork = { signal: AbortSignal; deadline: number };

/** One monotonic budget, including pool waits, retrieval and page hydration. */
export function createSearchWork(signal?: AbortSignal, deadline = performance.now() + SEARCH_BUDGET_MS): SearchWork {
  const budget = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())));
  return { signal: signal ? AbortSignal.any([signal, budget]) : budget, deadline };
}

export function checkSearchWork(work: SearchWork): void {
  work.signal.throwIfAborted();
  if (performance.now() >= work.deadline) throw new DOMException('Search deadline exceeded.', 'TimeoutError');
}

export function searchStatementTimeout(work: SearchWork): number {
  checkSearchWork(work);
  return Math.max(1, Math.min(SEARCH_STATEMENT_MS, Math.floor(work.deadline - performance.now())));
}

/** Failures must not release admission while sibling SQL is still using the pool. */
export async function settleSearchWork<T extends readonly unknown[]>(work: T) {
  try { return await Promise.all(work); }
  finally { await Promise.allSettled(work); }
}
