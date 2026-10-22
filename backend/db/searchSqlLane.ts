import type { TransactionSql } from 'postgres';
import { performance } from 'node:perf_hooks';
import { createSearchSqlClient, SEARCH_SQL_CONNECTIONS } from './index.js';
import { SearchRateLimitError } from '../services/searchService.js';
import { checkSearchWork, searchStatementTimeout, type SearchWork } from '../services/searchWork.js';

const MAX_QUEUED_SEARCH_SQL = 16;
type Waiting = { work: SearchWork; resolve: (release: () => void) => void; reject: (error: unknown) => void; cleanup: () => void };

/** Only admitted operations may call begin; no unbounded driver acquisition queue. */
class SearchSqlAdmission {
  private active = 0;
  private stopped = false;
  private readonly waiting = new Set<Waiting>();

  async acquire(work: SearchWork): Promise<() => void> {
    checkSearchWork(work);
    if (this.stopped) throw new Error('Search SQL is shutting down.');
    if (this.active < SEARCH_SQL_CONNECTIONS) return this.grant();
    if (this.waiting.size >= MAX_QUEUED_SEARCH_SQL) throw new SearchRateLimitError('Search is busy. Try again shortly.');
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const remove = (error: unknown) => {
        if (!this.waiting.delete(entry)) return;
        entry.cleanup();
        reject(error);
      };
      const abort = () => remove(work.signal.reason);
      const entry: Waiting = { work, resolve, reject, cleanup: () => {
        clearTimeout(timer);
        work.signal.removeEventListener('abort', abort);
      } };
      this.waiting.add(entry);
      work.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => remove(new DOMException('Search deadline exceeded.', 'TimeoutError')),
        Math.max(1, Math.ceil(work.deadline - performance.now())));
      if (work.signal.aborted) abort();
    });
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.waiting) {
      this.waiting.delete(entry);
      entry.cleanup();
      entry.reject(new Error('Search SQL is shutting down.'));
    }
  }

  private grant(): () => void {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      while (!this.stopped && this.active < SEARCH_SQL_CONNECTIONS && this.waiting.size) {
        const entry = this.waiting.values().next().value!;
        this.waiting.delete(entry);
        entry.cleanup();
        try { checkSearchWork(entry.work); }
        catch (error) { entry.reject(error); continue; }
        entry.resolve(this.grant());
      }
    };
  }
}

const admission = new SearchSqlAdmission();
let client: ReturnType<typeof createSearchSqlClient> | undefined;
let closing: Promise<void> | undefined;

/** Observe query activity without exposing SQL text or access to the exclusive pool. */
export function observeSearchSqlQueries(observer: () => void): () => void {
  if (!client) throw new Error('Search SQL must be initialized before observing queries.');
  const observedClient = client;
  const previousDebug = observedClient.options.debug;
  let active = true;
  const debug: Exclude<typeof previousDebug, boolean> = (...args) => {
    if (typeof previousDebug === 'function') previousDebug.apply(observedClient.options, args);
    if (active) observer();
  };
  observedClient.options.debug = debug;
  return () => {
    active = false;
    if (observedClient.options.debug === debug) observedClient.options.debug = previousDebug;
  };
}

export async function searchSql<T>(work: SearchWork, query: (sql: TransactionSql) => Promise<T>): Promise<T> {
  const release = await admission.acquire(work);
  try {
    checkSearchWork(work);
    if (closing) throw new Error('Search SQL is shutting down.');
    client ??= createSearchSqlClient();
    const result = await client.begin(async sql => {
      // The exclusive lane has one permit per connection; begin owns that actual
      // connection until commit/rollback. Never race or abandon its settlement.
      checkSearchWork(work);
      await sql`SELECT set_config('statement_timeout', ${String(searchStatementTimeout(work))}, true)`;
      checkSearchWork(work);
      const value = await query(sql);
      checkSearchWork(work);
      return { value };
    });
    checkSearchWork(work);
    return result.value;
  } finally {
    release();
  }
}

/** Idempotent, and importing/calling this from an unused worker creates no pool. */
export function closeSearchSql(): Promise<void> {
  if (closing) return closing;
  admission.stop();
  return closing = client ? client.end({ timeout: 5 }) : Promise.resolve();
}
