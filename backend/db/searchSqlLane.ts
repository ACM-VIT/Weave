import type { TransactionSql } from 'postgres';
import { performance } from 'node:perf_hooks';
import { createSearchSqlClient, SEARCH_SQL_CONNECTIONS } from './index.js';
import { SearchRateLimitError } from '../services/searchService.js';
import { checkSearchWork, searchStatementTimeout, settleSearchWork, type SearchWork } from '../services/searchWork.js';

const MAX_QUEUED_SEARCH_SQL = 16;
type Slot = { client?: ReturnType<typeof createSearchSqlClient>; busy: boolean };
type Lease = { slot: Slot; release: () => void };
const slots: Slot[] = Array.from({ length: SEARCH_SQL_CONNECTIONS }, () => ({ busy: false }));
type Waiting = { work: SearchWork; resolve: (lease: Lease) => void; reject: (error: unknown) => void; cleanup: () => void };

/** Only admitted operations may call begin; no unbounded driver acquisition queue. */
class SearchSqlAdmission {
  private active = 0;
  private stopped = false;
  private readonly drained: (() => void)[] = [];
  private readonly waiting = new Set<Waiting>();

  async acquire(work: SearchWork): Promise<Lease> {
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

  drain(): Promise<void> {
    return this.active ? new Promise(resolve => this.drained.push(resolve)) : Promise.resolve();
  }

  private grant(): Lease {
    const slot = slots.find(candidate => !candidate.busy)!;
    slot.busy = true;
    this.active++;
    let released = false;
    return { slot, release: () => {
      if (released) return;
      released = true;
      slot.busy = false;
      this.active--;
      if (!this.active) this.drained.splice(0).forEach(resolve => resolve());
      while (!this.stopped && this.active < SEARCH_SQL_CONNECTIONS && this.waiting.size) {
        const entry = this.waiting.values().next().value!;
        this.waiting.delete(entry);
        entry.cleanup();
        try { checkSearchWork(entry.work); }
        catch (error) { entry.reject(error); continue; }
        entry.resolve(this.grant());
      }
    } };
  }
}

const admission = new SearchSqlAdmission();
let closing: Promise<void> | undefined;
const observers = new Set<() => void>();
const debugRestorations = new Map<ReturnType<typeof createSearchSqlClient>, () => void>();

function observeClient(client: ReturnType<typeof createSearchSqlClient>): void {
  if (!observers.size || debugRestorations.has(client)) return;
  const previousDebug = client.sql.options.debug;
  const debug: Exclude<typeof previousDebug, boolean> = (...args) => {
    if (typeof previousDebug === 'function') previousDebug.apply(client.sql.options, args);
    for (const observer of observers) observer();
  };
  client.sql.options.debug = debug;
  debugRestorations.set(client, () => {
    if (client.sql.options.debug === debug) client.sql.options.debug = previousDebug;
    debugRestorations.delete(client);
  });
}

/** Observe query activity without exposing SQL text or access to the exclusive slots. */
export function observeSearchSqlQueries(observer: () => void): () => void {
  if (!slots.some(slot => slot.client)) throw new Error('Search SQL must be initialized before observing queries.');
  const notify = () => observer();
  observers.add(notify);
  for (const slot of slots) if (slot.client) observeClient(slot.client);
  return () => {
    observers.delete(notify);
    if (!observers.size) for (const restore of debugRestorations.values()) restore();
  };
}

function initializeSlot(slot: Slot) {
  if (slot.client) return slot.client;
  const client = createSearchSqlClient();
  observeClient(client);
  return slot.client = client;
}

export async function searchSql<T>(work: SearchWork, query: (sql: TransactionSql) => Promise<T>): Promise<T> {
  const { slot, release } = await admission.acquire(work);
  let owned: ReturnType<typeof createSearchSqlClient> | undefined;
  let callback: Promise<{ value: T }> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => { void owned?.destroy(); };
  try {
    checkSearchWork(work);
    if (closing) throw new Error('Search SQL is shutting down.');
    owned = initializeSlot(slot);
    work.signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, Math.max(1, Math.ceil(work.deadline - performance.now())));
    if (work.signal.aborted) { abort(); checkSearchWork(work); }
    const result = await owned.sql.begin(sql => callback = (async () => {
      checkSearchWork(work);
      // This bounded integer is generated locally, never supplied as SQL input.
      // Simple protocol avoids a parameter-description round trip. Dispatch it
      // first so PostgreSQL applies the transaction-local deadline before any
      // pipelined search SQL, and settle both operations before releasing a slot.
      const timeout = sql.unsafe(`SET LOCAL statement_timeout = ${searchStatementTimeout(work)}`).simple().execute();
      const result = Promise.resolve().then(() => { checkSearchWork(work); return query(sql); });
      const [, value] = await settleSearchWork([timeout, result] as const);
      checkSearchWork(work);
      return { value };
    })());
    checkSearchWork(work);
    return result.value;
  } catch (error) {
    // A rejected custom socket factory leaves the pinned driver's connection in
    // its connecting queue. Never reuse a failed client, even before its deadline.
    await owned?.destroy();
    throw error;
  } finally {
    // begin() itself races its scope against connection close. Track our callback
    // separately; no owner may reuse this slot while that work is still settling.
    if (callback) await Promise.allSettled([callback]);
    if (owned?.disposal) {
      await owned.disposal;
      debugRestorations.get(owned)?.();
      if (slot.client === owned) slot.client = undefined;
    }
    clearTimeout(timer);
    work.signal.removeEventListener('abort', abort);
    release();
  }
}

/** Idempotent; unused workers create no clients. Wait for actual owned work too. */
export function closeSearchSql(): Promise<void> {
  if (closing) return closing;
  admission.stop();
  return closing = Promise.all([
    ...slots.flatMap(slot => slot.client ? [slot.client.destroy()] : []),
    admission.drain(),
  ]).then(() => undefined);
}
