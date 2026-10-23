import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { Redis } from 'ioredis';
import { RedisFeedQueue } from '../../redis/feedQueue.js';

const integration = process.env.RUN_REDIS_INTEGRATION === '1' ? test : test.skip;

integration('reservation discovery bounds each cycle on large keyspaces and coalesces concurrent scans', async t => {
  const url = new URL(process.env.REDIS_TEST_URL ?? 'redis://127.0.0.1:6379/15');
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname === '/15');
  const redis = new Redis(url.toString(), { maxRetriesPerRequest: 1 });
  const queue = new RedisFeedQueue(redis, 30_000);
  const ownedKeys: string[] = [];
  t.after(async () => {
    try {
      for (let offset = 0; offset < ownedKeys.length; offset += 500) {
        await redis.del(...ownedKeys.slice(offset, offset + 500));
      }
    } finally { redis.disconnect(); }
  });
  const users = Array.from({ length: 8 }, () => crypto.randomUUID());
  const expected = new Set<string>();
  const requests: { user: string; request: string; token: string }[] = [];
  const entries = Array.from({ length: 24 }, () => ({
    repo_id: crypto.randomUUID(), score: 1, source: 'semantic', model_version: 'fixture', summary_id: null,
  }));
  for (const user of users) {
    ownedKeys.push(`feed:v2:${user}:0`, `feed:v2:${user}:1`, `feed:v2:version-index:${user}`,
      `feed:v2:reservation-index:${user}:0`, `feed:v2:reservation-index:${user}:1`);
    await queue.replace(user, 0n, entries, 60);
    await queue.replace(user, 1n, entries, 60);
    for (let n = 0; n < 12; n++) {
      const request = crypto.randomUUID();
      const token = crypto.randomUUID();
      requests.push({ user, request, token }); expected.add(`${user}:${request}`);
      ownedKeys.push(`feed:v2:reservation:${user}:0:${request}:meta`, `feed:v2:reservation:${user}:0:${request}:items`);
      await queue.reserve(user, 0n, request, 1, token);
    }
  }
  let recording = false;
  let commands: string[] = [];
  const send = redis.sendCommand;
  redis.sendCommand = function (...args: Parameters<typeof send>) {
    if (recording) commands.push(args[0].name);
    return send.apply(this, args);
  };
  const noisePrefix = `weave-114-fixture:${crypto.randomUUID()}:`;
  const measurements: { noiseKeys: number; cycles: number; scans: number; maxCommands: number }[] = [];
  let inserted = 0;
  for (const noiseKeys of [64, 16_384]) {
    for (; inserted < noiseKeys;) {
      const batch = redis.pipeline();
      for (let n = 0; n < 500 && inserted < noiseKeys; n++, inserted++) {
        const key = `${noisePrefix}${inserted}`; ownedKeys.push(key); batch.set(key, 'fixture', 'EX', 60);
      }
      const results = await batch.exec();
      assert.ok(results?.every(([error]) => !error));
    }
    const found = new Set<string>();
    let cycles = 0;
    let scans = 0;
    let maxCommands = 0;
    for (; cycles < 512 && found.size < expected.size; cycles++) {
      commands = []; recording = true;
      // A burst must share one cursor owner; otherwise concurrent scans skip ranges.
      const burst = await Promise.all(Array.from({ length: 32 }, () => queue.scanReservations()));
      recording = false;
      const cycleScans = commands.filter(name => name === 'scan').length;
      assert.equal(cycleScans, 2, 'a caller burst must not multiply keyspace scans');
      assert.ok(commands.length <= 600, `unbounded per-cycle work: ${commands.length} commands`);
      scans += cycleScans; maxCommands = Math.max(maxCommands, commands.length);
      for (const candidates of burst) {
        assert.equal(candidates, burst[0], 'all concurrent callers observe the same completed cursor cycle');
      }
      for (const candidate of burst[0]) {
        const identity = `${candidate.userId}:${candidate.requestId}`;
        assert.ok(expected.has(identity)); assert.equal(candidate.version, 0n);
        assert.ok(candidate.ttlMs > 0); found.add(identity);
      }
    }
    assert.deepEqual(found, expected, 'bounded discovery must eventually cover even reservations beyond the first index page');
    measurements.push({ noiseKeys, cycles, scans, maxCommands });
  }
  // Releasing an old reservation may recreate the old queue; indexed cleanup
  // must remove it while preserving the active version, without another SCAN.
  recording = false;
  for (const user of users) {
    await queue.deleteStaleVersions(user, 1n);
    assert.equal(await queue.depth(user, 0n), 0, 'remove the old queue before recovery recreates it');
    assert.equal(await redis.zscore(`feed:v2:version-index:${user}`, '0'), null);
  }
  for (const { user, request, token } of requests) assert.equal(await queue.release(user, 0n, request, token), true);
  for (const user of users) {
    assert.equal(await queue.depth(user, 0n), 12, 'successful releases restore exactly the reserved cards');
    assert.notEqual(await redis.zscore(`feed:v2:version-index:${user}`, '0'), null, 'recreated queues must be tracked again');
  }
  commands = []; recording = true;
  for (const user of users) await queue.deleteStaleVersions(user, 1n);
  recording = false;
  assert.equal(commands.filter(name => name === 'scan').length, 0);
  for (const user of users) {
    assert.equal(await queue.depth(user, 0n), 0);
    assert.equal(await queue.depth(user, 1n), entries.length);
  }
  t.diagnostic(JSON.stringify({ observersPerCycle: 32, reservations: expected.size, measurements }));
});

integration('oversized reservation indexes cannot expand one discovery cycle beyond its page budgets', async t => {
  const url = new URL(process.env.REDIS_TEST_URL ?? 'redis://127.0.0.1:6379/15');
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname === '/15');
  const redis = new Redis(url.toString(), { maxRetriesPerRequest: 1 });
  const queue = new RedisFeedQueue(redis, 30_000);
  const indexes: string[] = [];
  t.after(async () => { try { if (indexes.length) await redis.del(...indexes); } finally { redis.disconnect(); } });
  // Missing metadata simulates crash/expiry-era index records. Each index has
  // enough unique members to expose an unbounded zrange, and there are enough
  // indexes to expose an unbounded discovery page even on a tiny keyspace.
  for (let scope = 0; scope < 64; scope++) {
    const user = crypto.randomUUID();
    const index = `feed:v2:reservation-index:${user}:0`; indexes.push(index);
    const members = Array.from({ length: 64 }, () => `feed:v2:reservation:${user}:0:${crypto.randomUUID()}:meta`);
    await redis.zadd(index, ...members.flatMap(member => [Date.now() + 30_000, member]));
    await redis.expire(index, 60);
  }
  let indexReads = 0;
  let metadataReads = 0;
  const send = redis.sendCommand;
  redis.sendCommand = function (...args: Parameters<typeof send>) {
    if (args[0].name === 'zrange') indexReads++;
    if (args[0].name === 'eval') metadataReads++;
    return send.apply(this, args);
  };
  assert.deepEqual(await queue.scanReservations(), [], 'stale tracking must never manufacture a reservation');
  assert.ok(indexReads > 0 && indexReads <= 16, `index page escaped its budget: ${indexReads}`);
  assert.ok(metadataReads > 0 && metadataReads <= 128, `member pages escaped their budget: ${metadataReads}`);
  t.diagnostic(JSON.stringify({ indexedScopes: 64, membersPerScope: 64, indexReads, metadataReads }));
});
