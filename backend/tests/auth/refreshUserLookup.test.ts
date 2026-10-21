import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { withRefreshUserLookupDeadline, RefreshUserLookupTimeoutError } from '../../services/refreshUserLookup.js';

test('refresh metadata deadline returns503 without rotating cookies or mutating tokens, even after a late read', async (t) => {
  let finishLookup!: (value: unknown) => void;
  const lookup = new Promise(resolve => { finishLookup = resolve; });
  let mutations = 0;
  const cookieChanges: string[] = [];
  const responses: { status: number; body: unknown }[] = [];
  const filename = fileURLToPath(new URL('../../controllers/authController.ts', import.meta.url));
  const module = { exports: {} as Record<string, any> };
  const nativeRequire = createRequire(filename);
  const mocks: Record<string, unknown> = {
    '../config/supabase.js': { supabaseAdmin: { auth: { admin: { getUserById: () => lookup } } } },
    '../config/redis.js': {},
    '../db/index.js': { db: {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ user_id: 'synthetic-viewer', expires_at: new Date(Date.now() + 60_000) }] }) }) }),
      transaction: async () => { mutations++; throw new Error('Unexpected rotation'); },
    } },
    '../db/v2Schema.js': { appRefreshTokens: { userId: 'id', expiresAt: 'expiry', tokenHash: 'hash' } },
    '../services/identityService.js': {},
    '../services/githubPersonaService.js': {},
    '../services/oauthPkceService.js': { OAuthPkceCoordinator: class {}, RedisOAuthAttemptStore: class {} },
    '../services/refreshUserLookup.js': { withRefreshUserLookupDeadline, RefreshUserLookupTimeoutError },
  };
  const fixtureEnv = { CLIENT_URL: 'http://127.0.0.1/callback', BACKEND_URL: 'http://127.0.0.1', JWT_SECRET: 'synthetic-refresh-unit-secret' };
  const previousEnv = Object.fromEntries(Object.keys(fixtureEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, fixtureEnv);
  t.after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const javascript = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', javascript)(
    (specifier: string) => specifier in mocks ? mocks[specifier] : nativeRequire(specifier), module, module.exports,
  );
  let status = 0;
  const res = {
    status(value: number) { status = value; return this; },
    json(body: unknown) { responses.push({ status, body }); return this; },
    cookie() { cookieChanges.push('set'); return this; },
    clearCookie() { cookieChanges.push('clear'); return this; },
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const request = module.exports.refreshToken({ cookies: { refresh_token: 'synthetic-existing-token' } }, res);
    await Promise.resolve(); await Promise.resolve();
    t.mock.timers.tick(10_000);
    await request;
    assert.deepEqual(responses, [{ status: 503, body: { success: false, error: 'Session refresh is temporarily unavailable. Please try again.' } }]);
    assert.equal(mutations, 0);
    assert.deepEqual(cookieChanges, []);
    finishLookup({ data: { user: { id: 'synthetic-viewer' } }, error: null });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(mutations, 0, 'late metadata must not resume the token transaction');
    assert.equal(responses.length, 1);
    assert.deepEqual(cookieChanges, []);
  } finally { t.mock.timers.reset(); }
});
