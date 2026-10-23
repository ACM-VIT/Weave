import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { SessionLifecycle, SessionChangedError } from '../src/api/session-lifecycle';

const owner = '00000000-0000-4000-8000-000000000001';
const peer = '00000000-0000-4000-8000-000000000002';
const token = (id: string, nonce = 1) => `header.${Buffer.from(JSON.stringify({ userId: id, nonce })).toString('base64url')}.signature`;
function scenario(t: test.TestContext, read: () => Promise<string | null>) {
  const lifecycle = new SessionLifecycle();
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const mocks: Record<string, unknown> = {
    [resolve('src/api/config.ts')]: { API_URL: 'http://weave.test/api' },
    [resolve('src/api/session-lifecycle.ts')]: { authSessionLifecycle: lifecycle, SessionChangedError },
    [resolve('src/utils/storage.ts')]: { getStorageItem: read },
    [resolve('src/api/session-transitions.ts')]: {
      isSessionRestoreBlocked: async () => false, retireSessionIfCurrent: async () => false,
      storeAccessTokenForLease: async () => undefined,
    },
  };
  const modules = new Map<string, any>();
  function load(filename: string): any {
    filename = resolve(filename);
    if (filename in mocks) return mocks[filename];
    if (modules.has(filename)) return modules.get(filename);
    const mod = { exports: {} }; modules.set(filename, mod.exports);
    const js = ts.transpileModule(readFileSync(filename, 'utf8'), {
      fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const nativeRequire = createRequire(filename);
    const boundary = (specifier: string) => specifier.startsWith('.')
      ? load(resolve(dirname(filename), `${specifier}.ts`)) : nativeRequire(specifier);
    new Function('require', 'module', 'exports', js)(boundary, mod, mod.exports);
    modules.set(filename, mod.exports); return mod.exports;
  }
  t.mock.method(globalThis, 'fetch', async (url: unknown, options: RequestInit) => {
    requests.push({ url: String(url), authorization: new Headers(options.headers).get('Authorization') });
    return Response.json({ success: true, data: {} });
  });
  return { api: load('src/api/githubImport.ts').githubImportApi, unlink: load('src/api/githubUnlink.ts').githubUnlinkApi, lifecycle, requests };
}

test('all import calls authenticate their first request without a refresh cookie', async t => {
  const app = scenario(t, async () => token(owner));
  const signal = new AbortController().signal;
  await app.api.status(signal, owner); await app.api.preview(signal, owner);
  await app.api.accept(owner, signal, owner); await app.api.revoke(signal, owner);
  await app.api.saveIdentity({ username: 'Tarun', full_name: 'Tarun', date_of_birth: '2005-01-01' }, signal, owner);
  assert.equal(app.requests.length, 5);
  assert.ok(app.requests.every(request => request.authorization === `Bearer ${token(owner)}`));
  assert.ok(app.requests.every(request => !request.url.includes('/auth/refresh')));
});

test('import calls reject another account token before any HTTP request', async t => {
  const app = scenario(t, async () => token(peer));
  await assert.rejects(app.api.preview(new AbortController().signal, owner), SessionChangedError);
  assert.deepEqual(app.requests, []);
});

test('a session change while loading a token cannot retarget deferred import work', async t => {
  let release!: (value: string) => void;
  const waiting = new Promise<string>(resolve => { release = resolve; });
  const app = scenario(t, () => waiting);
  const operation = app.api.accept(owner, new AbortController().signal, owner);
  const rejected = assert.rejects(operation, SessionChangedError);
  app.lifecycle.retire(app.lifecycle.currentGeneration()); release(token(peer));
  await rejected; assert.deepEqual(app.requests, []);
});

test('an aborted owner request never reaches HTTP after token storage settles', async t => {
  let release!: (value: string) => void;
  const app = scenario(t, () => new Promise(resolve => { release = resolve; }));
  const controller = new AbortController();
  const operation = app.api.revoke(controller.signal, owner);
  const rejected = assert.rejects(operation, { name: 'AbortError' });
  controller.abort(); release(token(owner)); await rejected;
  assert.deepEqual(app.requests, []);
});


test('unlink start, finish and status authenticate immediately with their bound owner', async t => {
  const app = scenario(t, async () => token(owner)); const signal = new AbortController().signal;
  await app.unlink.start('challenge','weave://callback',signal,owner);
  await app.unlink.finish('proof','verifier',signal,owner); await app.unlink.status(signal,owner);
  assert.equal(app.requests.length,3);
  assert.ok(app.requests.every(request=>request.authorization===`Bearer ${token(owner)}`));
  assert.ok(app.requests.every(request=>!request.url.includes('/auth/refresh')));
});

test('unlink completion cannot use another account token', async t => {
  const app = scenario(t, async () => token(peer));
  await assert.rejects(app.unlink.finish('proof','verifier',new AbortController().signal,owner),SessionChangedError);
  assert.deepEqual(app.requests,[]);
});
