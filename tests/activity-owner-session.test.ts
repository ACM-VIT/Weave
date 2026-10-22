import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { SessionLifecycle, SessionChangedError } from '../src/api/session-lifecycle';

const ownerA = '00000000-0000-4000-8000-000000000001';
const ownerB = '00000000-0000-4000-8000-000000000002';
const token = (owner: string) => `header.${Buffer.from(JSON.stringify({userId: owner})).toString('base64url')}.signature`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => {resolve = yes;});
  return {promise, resolve};
}

// Execute the actual detail-action helper, owner-bound factory, durable queue,
// batch sender and API client. Only persistence and network I/O are replaced.
function scenario(t: test.TestContext) {
  const lifecycle = new SessionLifecycle();
  let currentToken = token(ownerA);
  const read = deferred<any[]>();
  const stored = new Map<string, any[]>();
  const sent: {authorization: string | null; events: any[]}[] = [];
  const mocks: Record<string, unknown> = {
    [resolve('src/api/config.ts')]: {API_URL: 'http://weave.test/api'},
    [resolve('src/api/session-lifecycle.ts')]: {authSessionLifecycle: lifecycle, SessionChangedError},
    [resolve('src/utils/storage.ts')]: {getStorageItem: async () => currentToken},
    [resolve('src/api/session-transitions.ts')]: {
      isSessionRestoreBlocked: async () => false,
      retireSessionIfCurrent: async () => false,
      storeAccessTokenForLease: async () => undefined,
    },
    [resolve('src/services/activityOutboxStorage.ts')]: {
      loadActivityOutbox: async (owner: string) => {
        const rows = owner === ownerA && !stored.has(owner) ? await read.promise : stored.get(owner) ?? [];
        stored.set(owner, [...rows]); return rows;
      },
      appendActivityOutboxEvent: async (owner: string, event: any) => {
        stored.set(owner, [...stored.get(owner) ?? [], event]);
      },
      acknowledgeActivityOutboxEvents: async (owner: string, ids: Set<string>) => {
        stored.set(owner, (stored.get(owner) ?? []).filter(row => !ids.has(row.event_id)));
      },
    },
  };
  const modules = new Map<string, any>();
  function load(filename: string): any {
    filename = resolve(filename);
    if (filename in mocks) return mocks[filename];
    if (modules.has(filename)) return modules.get(filename);
    const mod = {exports: {}};
    modules.set(filename, mod.exports);
    const js = ts.transpileModule(readFileSync(filename, 'utf8'), {
      fileName: filename, compilerOptions: {module: ts.ModuleKind.CommonJS, esModuleInterop: true},
    }).outputText;
    const nativeRequire = createRequire(filename);
    const boundary = (specifier: string) => specifier.startsWith('.')
      ? load(resolve(dirname(filename), `${specifier}.ts`)) : nativeRequire(specifier);
    new Function('require', 'module', 'exports', js)(boundary, mod, mod.exports);
    modules.set(filename, mod.exports);
    return mod.exports;
  }
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    const events = JSON.parse(String(options.body)).events;
    sent.push({authorization: new Headers(options.headers).get('Authorization'), events});
    return Response.json({accepted: events.length, duplicates: 0, feed_version: '2',
      results: events.map((event: any) => ({event_id: event.event_id, status: 'accepted'}))});
  });
  const client = load(resolve('src/services/activityOutboxClient.ts'));
  return {client, lifecycle, read, stored, sent,
    switchTo(owner: string) {lifecycle.retire(lifecycle.currentGeneration()); currentToken = token(owner);},
  };
}

for (const action of ['share', 'github_open'] as const) {
  test(`account switch during ${action} enqueue keeps A events and never sends with B token`, async t => {
    const app = scenario(t);
    const operation = app.client.queueActivityForViewer(ownerA, {repo_id: ownerA, action});
    const rejected = assert.rejects(operation, SessionChangedError);
    app.switchTo(ownerB);
    app.read.resolve([]);
    await rejected;
    assert.deepEqual(app.sent, []);
    assert.equal(app.stored.get(ownerA)?.length, 1);
    const outbox = app.client.getActivityOutbox(ownerA);
    await assert.rejects(outbox.flush(token(ownerB)), SessionChangedError);
    assert.deepEqual(app.sent, []);
    app.switchTo(ownerA);
    await outbox.flush(token(ownerA));
    assert.equal(app.sent.length, 1);
    assert.equal(app.sent[0].authorization, `Bearer ${token(ownerA)}`);
    assert.equal(app.sent[0].events[0].event_type, action);
    assert.equal(app.stored.get(ownerA)?.length, 0);
  });
}

test('flush waiting on durable loading cannot survive a same-owner session change', async t => {
  const app = scenario(t);
  const outbox = app.client.getActivityOutbox(ownerA);
  const event = {event_id: ownerB, session_id: ownerA, client_occurred_at: new Date().toISOString(),
    repo_id: ownerA, action: 'share', serve_id: null, position: null};
  const flushed = assert.rejects(outbox.flush(token(ownerA)), SessionChangedError);
  app.switchTo(ownerA);
  app.read.resolve([event]);
  await flushed;
  assert.deepEqual(app.sent, []);
  assert.equal(await outbox.pendingCount(), 1);
  await outbox.flush(token(ownerA));
  assert.equal(app.sent.length, 1);
});
