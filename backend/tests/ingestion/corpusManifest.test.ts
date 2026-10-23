import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import express from 'express';
import { CorpusManifestService, InvalidManifestCursor, type CorpusManifestEntry, ManifestConfigurationError } from '../../services/corpusManifestService.js';
import { corpusManifestController } from '../../controllers/corpusManifestController.js';
import { requireInternalSecret } from '../../middlewares/internalAuthMiddleware.js';

const ids = [1, 2, 3].map((i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
const entry = (repo_id: string): CorpusManifestEntry => ({ repo_id, github_id: '1', full_name: 'owner/repo',
  content_hash: 'a', content_version: 1, content_updated_at: new Date(0).toISOString(), source_updated_at: null });

test('manifest keysets retain cutoff/limit and expire, reject tampering and domain/version changes', async () => {
  let now = 10_000;
  const calls: unknown[] = [];
  const service = new CorpusManifestService(async (after, cutoff, limit) => {
    calls.push([after, cutoff, limit]);
    return ids.filter((id) => !after || id > after).slice(0, limit).map(entry);
  }, 'fixture-key', () => now++);
  const page = await service.page(2);
  assert.equal(page.items.length, 2);
  assert.ok(page.next_cursor);
  const last = await service.page(2, page.next_cursor!);
  assert.deepEqual(last.items.map((item) => item.repo_id), [ids[2]]);
  assert.equal(last.next_cursor, null);
  assert.equal(last.as_of, page.as_of);
  assert.deepEqual(calls[1], [ids[1], page.as_of, 3]);
  await assert.rejects(service.page(1, page.next_cursor!), InvalidManifestCursor);
  await assert.rejects(service.page(2, page.next_cursor! + 'x'), InvalidManifestCursor);
  await assert.rejects(new CorpusManifestService(async () => [], 'other-key', () => now).page(2, page.next_cursor!), InvalidManifestCursor);
  now += 15 * 60_000;
  await assert.rejects(service.page(2, page.next_cursor!), InvalidManifestCursor);
  await assert.rejects(service.page(251), RangeError);
});

test('internal manifest HTTP authenticates before reading and distinguishes empty/error/stale', async () => {
  const old = process.env.INTERNAL_API_SECRET;
  process.env.INTERNAL_API_SECRET = 'manifest-http-test';
  let reads = 0, fail: unknown = false;
  const service = new CorpusManifestService(async () => { reads++; if (fail) throw fail; return []; }, 'key');
  const failures: string[] = [];
  const app = express();
  app.get('/manifest', requireInternalSecret, corpusManifestController(() => service, (category) => failures.push(category)));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}/manifest`;
  const get = (suffix = '') => fetch(url + suffix, { headers: { 'x-internal-secret': 'manifest-http-test' } });
  try {
    assert.equal((await fetch(url)).status, 401); assert.equal(reads, 0);
    assert.equal((await get('?limit=0')).status, 400); assert.equal(reads, 0);
    assert.equal((await get('?cursor=bad')).status, 409); assert.equal(reads, 0);
    const empty = await get(); assert.equal(empty.status, 200);
    assert.deepEqual(((await empty.json()) as {items: unknown[]}).items, []);
    for (const error of [new Error('private connection string'),
      Object.assign(new Error('private sql'), {code:'57014'}),
      Object.assign(new Error('private sql'), {code:'42P01'}),
      new ManifestConfigurationError('private key')]) {
      fail = error;
      assert.equal((await get()).status, 503);
    }
    assert.deepEqual(failures, ['unexpected','database_timeout','schema_missing','configuration']);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (old === undefined) delete process.env.INTERNAL_API_SECRET; else process.env.INTERNAL_API_SECRET = old;
  }
});


test('known domain-separated cursor is accepted while signed unsupported versions/domains are rejected', async () => {
  const now = 10_000;
  const service = new CorpusManifestService(async (after) => { assert.equal(after, ids[0]); return []; }, 'key', () => now);
  const make = (version: number, domain = 'corpus-manifest-v1:') => {
    const body = Buffer.from(JSON.stringify({ version, as_of: new Date(now).toISOString(),
      expires_at: now + 15*60_000, after: ids[0], limit: 2 })).toString('base64url');
    return `${body}.${crypto.createHmac('sha256','key').update(domain+body).digest('base64url')}`;
  };
  assert.deepEqual((await service.page(2, make(1))).items, []);
  await assert.rejects(service.page(2, make(2)), InvalidManifestCursor);
  await assert.rejects(service.page(2, make(1, '')), InvalidManifestCursor);
});
