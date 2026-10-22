import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeedReconciliationPersistencePort, FeedServeRequest } from '../../ports/feedPersistencePort.js';
import { FeedReconciliationWorker } from '../../workers/feedReconciliationWorker.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reservation = (n: number, userId = id(1)) => ({ userId, requestId: id(n), version: 3n, token: `token-${n}`, ttlMs: 1_000 });

function fixture(reservations: ReturnType<typeof reservation>[]) {
  const committed: string[] = [], released: string[] = [], batches: FeedServeRequest[][] = [];
  const durable = new Set<string>();
  const versionLookups: string[] = [], cleanups: string[] = [];
  const key = (request: FeedServeRequest) => `${request.userId}:${request.requestId}`;
  let singleChecks = 0;
  const persistence: FeedReconciliationPersistencePort = {
    getFeedVersion: async (userId) => { versionLookups.push(userId); return 3n; },
    hasServe: async (userId, requestId) => { singleChecks++; return durable.has(key({ userId, requestId })); },
    listServedRequests: async (requests) => { batches.push(requests); return requests.filter(request => durable.has(key(request))); },
  };
  const queue = {
    scanReservations: async () => reservations,
    commit: async (_user: string, _version: bigint, requestId: string, token: string) => {
      if (token === 'replaced-token') return false;
      committed.push(requestId); return true;
    },
    release: async (_user: string, _version: bigint, requestId: string, token: string) => {
      if (token === 'replaced-token') return false;
      released.push(requestId); return true;
    },
    deleteStaleVersions: async (userId: string) => { cleanups.push(userId); return 0; },
  };
  return { persistence, queue, committed, released, batches, durable, key, versionLookups, cleanups, singleChecks: () => singleChecks };
}

test('reconciliation batches durable existence without card hydration and preserves ownership', async () => {
  const first = reservation(10), missing = reservation(11), otherUser = reservation(10, id(2));
  const replaced = { ...reservation(12), token: 'replaced-token' };
  const f = fixture([first, first, missing, otherUser, replaced,
    { ...reservation(13), ttlMs: 20_000 }, { ...reservation(14), requestId: '' }]);
  f.durable.add(f.key(first));
  f.durable.add(f.key(replaced));
  assert.deepEqual(await new FeedReconciliationWorker(f.persistence, f.queue).runOnce(), { committed: 1, released: 2 });
  assert.deepEqual(f.committed, [first.requestId]);
  assert.deepEqual(f.released, [missing.requestId, otherUser.requestId]);
  assert.equal(f.batches.length, 1);
  assert.equal(f.batches[0].length, 4, 'duplicate, young and missing-ID reservations are not queried');
  assert.equal(f.singleChecks(), 2, 'only batch misses need a fresh pre-release existence check');
});

test('a serve committed after the batch snapshot is committed rather than released', async () => {
  const late = reservation(10), f = fixture([late]);
  f.persistence.listServedRequests = async () => { f.durable.add(f.key(late)); return []; };
  assert.deepEqual(await new FeedReconciliationWorker(f.persistence, f.queue).runOnce(), { committed: 1, released: 0 });
  assert.deepEqual(f.committed, [late.requestId]);
  assert.deepEqual(f.released, []);
});

test('failed existence reads never release reservations', async () => {
  for (const stage of ['batch', 'confirmation'] as const) {
    const f = fixture([reservation(10)]);
    if (stage === 'batch') f.persistence.listServedRequests = async () => { throw new Error('database unavailable'); };
    else f.persistence.hasServe = async () => { throw new Error('database unavailable'); };
    await assert.rejects(new FeedReconciliationWorker(f.persistence, f.queue).runOnce(), /database unavailable/);
    assert.deepEqual(f.released, []);
    assert.deepEqual(f.committed, []);
  }
});

test('reconciliation keeps each SQL existence lookup bounded across large scans', async () => {
  const reservations = Array.from({ length: 205 }, (_, n) => reservation(n + 10));
  const f = fixture(reservations);
  for (const value of reservations) f.durable.add(f.key(value));
  assert.deepEqual(await new FeedReconciliationWorker(f.persistence, f.queue).runOnce(), { committed: 205, released: 0 });
  assert.deepEqual(f.batches.map(batch => batch.length), [100, 100, 5]);
  assert.equal(f.singleChecks(), 0);
  assert.deepEqual(f.versionLookups, [id(1)], 'one current-version read across all reservation batches');
  assert.deepEqual(f.cleanups, [id(1)], 'one bounded cleanup per user, not per reservation');
});
