import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { assertDisposableDatabase } from '../database/disposableDatabase.js';

const integration = process.env.RUN_SEARCH_SQL_INTEGRATION === '1' ? test : test.skip;

integration('real search SQL cancellation retires only its connection and later work can reuse admission', { timeout: 15_000 }, async t => {
  assertDisposableDatabase();
  const [{ sqlClient }, { searchSql, closeSearchSql }, { createSearchWork }] = await Promise.all([
    import('../../db/index.js'), import('../../db/searchSqlLane.js'), import('../../services/searchWork.js'),
  ]);
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await closeSearchSql();
    await sqlClient.end({ timeout: 1 });
  });
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  let cancelledPid = 0;
  const running = searchSql(createSearchWork(controller.signal), async sql => {
    cancelledPid = Number((await sql`SELECT pg_backend_pid() AS pid`)[0].pid);
    started();
    await sql`SELECT pg_sleep(10)`;
  });
  const rejected = assert.rejects(running);
  await Promise.race([began, running]);
  const visibleUntil = performance.now() + 1_000;
  let active = false;
  while (performance.now() < visibleUntil) {
    const row = (await sqlClient`SELECT state,query FROM pg_stat_activity WHERE pid=${cancelledPid}`)[0];
    if (row?.state === 'active' && String(row.query).includes('pg_sleep')) { active = true; break; }
    await delay(5);
  }
  assert.ok(active, 'the cancellation must interrupt real executing SQL, not merely a queued callback');
  // Another exclusive search slot must survive this owner's cancellation.
  let independentStarted!: () => void;
  const independentReady = new Promise<void>(resolve => { independentStarted = resolve; });
  const independent = searchSql(createSearchWork(), async sql => {
    assert.notEqual(Number((await sql`SELECT pg_backend_pid() AS pid`)[0].pid), cancelledPid);
    independentStarted();
    await sql`SELECT pg_sleep(0.05)`;
    return Number((await sql`SELECT 7 AS result`)[0].result);
  });
  await Promise.race([independentReady, independent]);
  const cancelledAt = performance.now();
  controller.abort(new Error('HTTP caller disconnected'));
  await rejected;
  const cancellationMs = performance.now() - cancelledAt;
  assert.ok(cancellationMs < 500, `obsolete SQL survived cancellation for ${cancellationMs} ms`);
  assert.equal(await independent, 7);
  // PostgreSQL need not observe TCP close during pg_sleep. The scoped server
  // statement deadline must still retire that work within the search budget.
  const retiredBy = performance.now() + 2_500;
  while ((await sqlClient`SELECT pid FROM pg_stat_activity WHERE pid=${cancelledPid}`).length > 0) {
    assert.ok(performance.now() < retiredBy, 'server SQL survived its cancellation/deadline bound');
    await delay(10);
  }
  const serverRetirementMs = performance.now() - cancelledAt;
  const replacement = await searchSql(createSearchWork(), async sql => {
    await sql`SELECT pg_sleep(0.05)`;
    return Number((await sql`SELECT pg_backend_pid() AS pid`)[0].pid);
  });
  assert.notEqual(replacement, cancelledPid, 'a stale cancel must never target the new owner');

  const deadlineAt = performance.now();
  await assert.rejects(searchSql(createSearchWork(undefined, performance.now() + 100),
    async sql => { await sql`SELECT pg_sleep(10)`; }));
  const deadlineMs = performance.now() - deadlineAt;
  assert.ok(deadlineMs < 500, `search deadline did not stop SQL: ${deadlineMs} ms`);
  assert.equal(await searchSql(createSearchWork(), async sql => Number((await sql`SELECT 11 AS result`)[0].result)), 11);
  t.diagnostic(JSON.stringify({ cancellationMs, serverRetirementMs, deadlineMs, cancelledConnectionRetired: true, independentAndReplacementQueries: 'passed' }));
});
