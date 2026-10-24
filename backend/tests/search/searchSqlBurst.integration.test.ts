import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { assertDisposableDatabase } from '../database/disposableDatabase.js';

const integration = process.env.RUN_SEARCH_SQL_INTEGRATION === '1' ? test : test.skip;

integration('rapid SQL searches bound admission, remove cancelled waiters and preserve surviving owners', {
  timeout: 15_000,
}, async t => {
  assertDisposableDatabase();
  const [{ sqlClient, SEARCH_SQL_CONNECTIONS }, { searchSql, closeSearchSql }, { createSearchWork }] = await Promise.all([
    import('../../db/index.js'), import('../../db/searchSqlLane.js'), import('../../services/searchWork.js'),
  ]);
  const controllers: AbortController[] = [];
  const operations: Promise<unknown>[] = [];
  function track<T>(operation: Promise<T>) {
    const result = operation.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    operations.push(result);
    return result;
  }
  function controller() { const value = new AbortController(); controllers.push(value); return value; }
  let releaseSurvivor!: () => void;
  const survivorGate = new Promise<void>(resolve => { releaseSurvivor = resolve; });
  t.after(async () => {
    releaseSurvivor();
    controllers.forEach(value => value.abort());
    await Promise.allSettled(operations);
    await closeSearchSql();
    await sqlClient.end({ timeout: 1 });
  });
  let ready!: () => void;
  const allOwnersReady = new Promise<void>(resolve => { ready = resolve; });
  const ownerPids: number[] = [];
  const ownerControllers = Array.from({ length: SEARCH_SQL_CONNECTIONS }, controller);
  const owners = ownerControllers.map((value, index) => track(searchSql(createSearchWork(value.signal), async sql => {
    ownerPids[index] = Number((await sql`SELECT pg_backend_pid() AS pid`)[0].pid);
    if (ownerPids.filter(Boolean).length === SEARCH_SQL_CONNECTIONS) ready();
    if (index === SEARCH_SQL_CONNECTIONS - 1) {
      await survivorGate;
      return Number((await sql`SELECT 77 AS result`)[0].result);
    }
    await sql`SELECT pg_sleep(10)`;
    return -1;
  })));
  await Promise.race([allOwnersReady, ...owners.map(operation => operation.then(result => {
    if (!result.ok) throw result.error;
    throw new Error('SQL owner settled before admission could be filled.');
  }))]);
  const retiringPids = ownerPids.slice(0, -1);
  const activeBy = performance.now() + 1_000;
  for (;;) {
    const active = await sqlClient`SELECT pid FROM pg_stat_activity
      WHERE pid=ANY(${retiringPids}::integer[]) AND state='active' AND query LIKE '%pg_sleep%'`;
    if (active.length === retiringPids.length) break;
    assert.ok(performance.now() < activeBy, 'fixture must cancel executing PostgreSQL statements');
    await delay(5);
  }

  const started: number[] = [];
  const queueWaitMs: number[] = [];
  const enqueue = (id: number) => {
    const value = controller();
    const submittedAt = performance.now();
    const result = track(searchSql(createSearchWork(value.signal), async sql => {
      started.push(id);
      queueWaitMs.push(performance.now() - submittedAt);
      await sql`SELECT pg_sleep(0.01)`;
      return Number((await sql`SELECT ${id}::integer AS result`)[0].result);
    }));
    return { controller: value, result };
  };
  const queued = Array.from({ length: 16 }, (_, index) => enqueue(index));
  const overflow = () => searchSql(createSearchWork(), async () => {
    throw new Error('overflow request must never reach a SQL callback');
  });
  await assert.rejects(overflow(), (error: { statusCode?: number }) => error.statusCode === 429);
  assert.deepEqual(started, [], 'all admitted connections remain exclusively owned');

  const cancelledAt = performance.now();
  queued.slice(0, 8).forEach(value => value.controller.abort(new Error('superseded queued search')));
  const cancelledWaiters = await Promise.all(queued.slice(0, 8).map(value => value.result));
  assert.ok(cancelledWaiters.every(result => !result.ok));
  const queuedCancellationMs = performance.now() - cancelledAt;
  assert.ok(queuedCancellationMs < 500, `queued cancellation took ${queuedCancellationMs} ms`);
  // Cancelled queue entries must free capacity before any connection is released.
  const replacements = Array.from({ length: 8 }, (_, index) => enqueue(index + 16));
  await assert.rejects(overflow(), (error: { statusCode?: number }) => error.statusCode === 429);

  const activeCancellationAt = performance.now();
  ownerControllers.slice(0, -1).forEach(value => value.abort(new Error('superseded executing search')));
  const retiredOwners = await Promise.all(owners.slice(0, -1));
  const activeCancellationMs = performance.now() - activeCancellationAt;
  assert.ok(retiredOwners.every(result => !result.ok));
  assert.ok(activeCancellationMs < 500, `active cancellation took ${activeCancellationMs} ms`);
  const survivors = await Promise.all([...queued.slice(8), ...replacements].map(value => value.result));
  assert.deepEqual(survivors.map(result => result.ok ? result.value : result.error),
    Array.from({ length: 16 }, (_, index) => index + 8));
  assert.deepEqual([...started].sort((a, b) => a - b), Array.from({ length: 16 }, (_, index) => index + 8),
    'cancelled waiters never execute, surviving and replacement requests execute once');
  releaseSurvivor();
  assert.deepEqual(await owners.at(-1), { ok: true, value: 77 }, 'one owner must survive peer cancellation');
  assert.equal(await searchSql(createSearchWork(), async sql => Number((await sql`SELECT 99 AS result`)[0].result)), 99);

  // TCP close may be noticed only after pg_sleep yields; scoped statement
  // deadlines still bound work left on PostgreSQL after caller cancellation.
  const retiredBy = activeCancellationAt + 2_500;
  while ((await sqlClient`SELECT pid FROM pg_stat_activity WHERE pid=ANY(${retiringPids}::integer[])`).length) {
    assert.ok(performance.now() < retiredBy, 'abandoned server statements exceeded their deadline bound');
    await delay(10);
  }
  t.diagnostic(JSON.stringify({ activeConnections: SEARCH_SQL_CONNECTIONS, queueCapacity: 16,
    cancelledQueued: 8, successfulQueued: survivors.length, queuedCancellationMs, activeCancellationMs,
    maxPoolWaitMs: Math.max(...queueWaitMs), serverRetirementMs: performance.now() - activeCancellationAt,
    scope: 'one local synthetic burst, not a production latency percentile' }));
});
