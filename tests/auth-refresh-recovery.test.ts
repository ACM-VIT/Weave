import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { act } from "react";
import { SessionLifecycle } from "../src/api/session-lifecycle";
import { loadSource, deferred, type Viewer, startup, fixtureToken, envelope } from "./support/startup-harness";

test('a hung initial profile exposes recovery without clearing credentials; retry rejects its late result', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const app = startup({ segments: ['(tabs)'] });
  const staleProfile = deferred<Viewer>();
  app.setProfileRequest(staleProfile.promise);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await app.mount(() => t.mock.timers.tick(0));
  try {
    await act(async () => { app.session.resolve('valid-stored-token'); app.fonts.resolve(); });
    await act(async () => { t.mock.timers.tick(15_000); });
    assert.ok(app.auth.startupError, 'a hung restoration must offer a visible recovery path');
    assert.equal(app.navigationMounts, 0);
    assert.equal(app.splashHides, 1);
    assert.equal(app.storedToken, 'valid-stored-token');

    await act(async () => {
      app.setProfileRequest(Promise.reject(new TypeError('Network request failed')));
      app.retry();
    });
    assert.ok(app.auth.startupError, 'a transient retry failure must remain recoverable');
    assert.equal(app.navigationMounts, 0);
    assert.equal(app.storedToken, 'valid-stored-token');

    app.setProfileRequest(Promise.resolve({ user_id: 'alice', username: 'updated', onboarding_completed: true }));
    await act(async () => { app.retry(); });
    assert.equal(app.auth.startupError, null);
    assert.equal(app.auth.user?.username, 'updated');
    assert.equal(app.navigationMounts, 1);
    await act(async () => {
      staleProfile.resolve({ user_id: 'alice', username: 'obsolete', onboarding_completed: true });
    });
    assert.equal(app.auth.user?.username, 'updated');
    assert.equal(app.storedToken, 'valid-stored-token');
    assert.equal(app.navigationMounts, 1);
  } finally {
    t.mock.timers.reset();
    await app.unmount();
  }
});

test('a hung anonymous refresh is bounded; a late refresh cannot replace a newer session', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const app = startup({ viewer: null, segments: ['(tabs)'] });
  const staleRefresh = deferred<string>();
  app.setRefreshRequest(staleRefresh.promise);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await app.mount(() => t.mock.timers.tick(0));
  try {
    await act(async () => { app.session.resolve(null); app.fonts.reject(new Error('font unavailable')); });
    await act(async () => { t.mock.timers.tick(15_000); });
    assert.ok(app.auth.startupError);
    assert.equal(app.navigationMounts, 0);
    assert.equal(app.splashHides, 1);
    app.setStoredToken('new-session-token');
    app.setProfileRequest(Promise.resolve({ user_id: 'bob', username: 'bob', onboarding_completed: true }));
    await act(async () => {
      await app.auth.setSession({ accessToken: 'new-session-token', sessionGeneration: app.lifecycle.currentGeneration() });
      staleRefresh.resolve('old-refresh-token');
    });
    assert.equal(app.auth.user?.user_id, 'bob');
    assert.equal(app.auth.startupError, null);
    assert.equal(app.storedToken, 'new-session-token');
    assert.equal(app.navigationMounts, 1);
  } finally {
    t.mock.timers.reset();
    await app.unmount();
  }
});

test('an aborted real refresh cannot persist a late token or retire credentials from a late rejection', async (t) => {
  for (const status of [200, 401]) {
    const lifecycle = new SessionLifecycle();
    const body = deferred<string>();
    const writes: string[] = [];
    let retirements = 0;
    let requestSignal: AbortSignal | null | undefined;
    const response = new Response(null, { status });
    response.text = () => body.promise;
    t.mock.method(globalThis, 'fetch', async (_url, options) => { requestSignal = options?.signal; return response; });
    const client = loadSource('src/api/client.ts', {
      './config': { API_URL: 'http://127.0.0.1:1/api' },
      '../utils/storage': { getStorageItem: async () => null },
      './session-lifecycle': {
        ...createRequire(resolve('src/api/client.ts'))('./session-lifecycle'),
        authSessionLifecycle: lifecycle,
      },
      './session-transitions': {
        isSessionRestoreBlocked: async () => false,
        retireSessionIfCurrent: async () => { retirements += 1; return true; },
        storeAccessTokenForLease: async (lease: { assertCurrent: () => void }, token: string) => {
          lease.assertCurrent(); writes.push(token);
        },
      },
    });
    const controller = new AbortController();
    const refresh = client.refreshSession(null, controller.signal);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(requestSignal, controller.signal, 'native fetch must receive the cancellation signal');
    controller.abort();
    body.resolve(JSON.stringify({ success: true, data: { accessToken: 'late-token' } }));
    await assert.rejects(refresh, { name: 'SessionChangedError' });
    assert.deepEqual(writes, []);
    assert.equal(retirements, 0);
    t.mock.restoreAll();
  }
});

test('aborting a refresh also guards retirement queued behind an earlier storage write', async (t) => {
  const { SessionLifecycle, SessionChangedError } = require('../src/api/session-lifecycle');
  const lifecycle = new SessionLifecycle();
  const body = deferred<Response>();
  const requestStarted = deferred<void>();
  const writeStarted = deferred<void>();
  const releaseWrite = deferred<void>();
  const retirementQueued = deferred<void>();
  const writes: string[] = [];
  const removals: string[] = [];
  const storage = {
    getStorageItem: async () => 'queue-blocker',
    getStorageItemStrict: async () => null,
    setStorageItem: async (key: string, value: string) => {
      writes.push(key);
      if (value === 'queue-blocker') { writeStarted.resolve(); await releaseWrite.promise; }
    },
    removeStorageItem: async (key: string) => { removals.push(key); },
  };
  const transitions = loadSource('src/api/session-transitions.ts', {
    '../utils/storage': storage,
    './session-lifecycle': { authSessionLifecycle: lifecycle, SessionChangedError },
  });
  const client = loadSource('src/api/client.ts', {
    './config': { API_URL: 'http://127.0.0.1:1' },
    '../utils/storage': storage,
    './session-lifecycle': { authSessionLifecycle: lifecycle, SessionChangedError },
    './session-transitions': {
      ...transitions,
      retireSessionIfCurrent: (...args: unknown[]) => {
        retirementQueued.resolve();
        return transitions.retireSessionIfCurrent(...args);
      },
    },
  });
  let response = body.promise;
  t.mock.method(globalThis, 'fetch', async () => { requestStarted.resolve(); return response; });
  const controller = new AbortController();
  const refresh = client.refreshSession(null, controller.signal);
  const rejected = assert.rejects(refresh, SessionChangedError);
  try {
    await requestStarted.promise;
    const blocker = transitions.storeAccessTokenForLease({
      generation: 0,
      assertCurrent: () => lifecycle.assertCurrent(0),
      isCurrent: () => lifecycle.isCurrent(0),
    }, 'queue-blocker');
    await writeStarted.promise;
    body.resolve(new Response(JSON.stringify({ error: 'expired' }), { status: 401 }));
    await retirementQueued.promise;
    controller.abort();
    releaseWrite.resolve();
    await blocker;
    await rejected;
    assert.deepEqual(writes, ['access_token'], 'no restore-block marker may be written after cancellation');
    assert.deepEqual(removals, []);
    assert.equal(lifecycle.currentGeneration(), 0);
    // An active, genuine auth rejection must still retire durable credentials.
    response = Promise.resolve(new Response(JSON.stringify({ error: 'expired' }), { status: 401 }));
    await assert.rejects(client.refreshSession(null, new AbortController().signal), { status: 401 });
    assert.deepEqual(writes, ['access_token', 'session_restore_blocked']);
    assert.deepEqual(removals, ['access_token']);
    assert.equal(lifecycle.currentGeneration(), 1);
  } finally {
    releaseWrite.resolve();
    t.mock.restoreAll();
  }
});

test('a stalled retry keeps recovery visible with progress and blocks duplicate submits until it completes', async (t) => {
  const app = startup({ segments: ['(tabs)'] });
  const initialProfile = deferred<Viewer>();
  app.setProfileRequest(initialProfile.promise);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await app.mount(() => t.mock.timers.tick(0));
  try {
    await act(async () => { app.session.resolve('valid-token'); app.fonts.resolve(); });
    await act(async () => { t.mock.timers.tick(15_000); });
    assert.ok(app.recoveryButton);
    const retryProfile = deferred<Viewer>();
    app.setProfileRequest(retryProfile.promise);
    await act(async () => { app.retry(); });
    assert.ok(app.recoveryButton, 'retry must not leave an empty screen after hiding the splash');
    assert.equal(app.recoveryButton.disabled, true);
    assert.deepEqual(app.recoveryButton.accessibilityState, { disabled: true, busy: true });
    assert.equal(app.recoveryButton.children.props.children, 'Restoring…');
    assert.equal(app.navigationMounts, 0);
    assert.equal(app.splashHides, 1);
    const restoresStarted = app.events.filter(event => event === 'session:start').length;
    await act(async () => { app.retry(); t.mock.timers.tick(14_999); });
    assert.equal(app.events.filter(event => event === 'session:start').length, restoresStarted);
    assert.equal(app.recoveryButton.disabled, true);
    assert.equal(app.auth.isLoading, true);
    await act(async () => {
      retryProfile.resolve({ user_id: 'alice', username: 'alice', onboarding_completed: true });
    });
    assert.equal(app.auth.startupError, null);
    assert.equal(app.auth.isLoading, false);
    assert.equal(app.recoveryButton, undefined);
    assert.equal(app.navigationMounts, 1);
    assert.equal(app.splashHides, 1);
    assert.equal(app.storedToken, 'valid-token');
  } finally {
    t.mock.timers.reset();
    await app.unmount();
  }
});

test('a slow real refresh retains its response and retry joins its cookie rotation', async (t) => {
  for (const retryBeforeResponse of [true, false]) {
    const app = startup({ segments: ['(tabs)'], realNetwork: true });
    const response = deferred<Response>();
    const freshToken = fixtureToken('alice');
    let refreshes = 0;
    let cookie = 'original';
    let requestSignal: AbortSignal | null | undefined;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (String(url).endsWith('/auth/refresh')) {
        refreshes++;
        requestSignal = options?.signal;
        const result = await response.promise;
        if (requestSignal?.aborted) throw new DOMException('Request aborted', 'AbortError');
        cookie = 'rotated';
        return result;
      }
      assert.ok(String(url).endsWith('/v2/users/me'));
      return envelope({ user_id: 'alice', username: 'alice', onboarding_completed: true });
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await app.mount(() => t.mock.timers.tick(0));
    try {
      await act(async () => { app.session.resolve(null); app.fonts.resolve(); });
      assert.equal(refreshes, 1);
      await act(async () => { t.mock.timers.tick(15_000); });
      assert.ok(app.recoveryButton);
      assert.equal(app.recoveryButton.disabled, false);
      assert.equal(app.lifecycle.currentGeneration(), 0, 'UI timeout must not revoke the refresh lease');
      assert.equal(requestSignal?.aborted ?? false, false, 'one-use rotation response must not be discarded');
      if (retryBeforeResponse) {
        await act(async () => { app.retry(); });
        assert.equal(app.recoveryButton.disabled, true);
        assert.equal(refreshes, 1, 'retry must join the same in-flight rotation');
      }
      await act(async () => { response.resolve(envelope({ accessToken: freshToken })); });
      assert.equal(cookie, 'rotated');
      assert.equal(app.storedToken, freshToken);
      if (!retryBeforeResponse) {
        assert.equal(app.auth.user, null, 'the timed-out attempt cannot reveal a late profile');
        assert.ok(app.auth.startupError);
        assert.equal(app.navigationMounts, 0);
        await act(async () => { app.retry(); });
      }
      assert.equal(refreshes, 1);
      assert.equal(app.auth.user?.user_id, 'alice');
      assert.equal(app.auth.startupError, null);
      assert.equal(app.auth.isLoading, false);
      assert.equal(app.navigationMounts, 1);
    } finally { t.mock.timers.reset(); await app.unmount(); t.mock.restoreAll(); }
  }
});

test('a retained slow refresh cannot overwrite a later logout or account switch', async (t) => {
  for (const transition of ['logout', 'account-switch']) {
    const app = startup({ segments: ['(tabs)'], realNetwork: true });
    const response = deferred<Response>();
    const calls: string[] = [];
    let cookie = 'original';
    const bobToken = fixtureToken('bob');
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const path = String(url);
      calls.push(path);
      if (path.endsWith('/auth/refresh')) {
        const result = await response.promise;
        if (options?.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
        cookie = 'old-rotation';
        return result;
      }
      if (path.endsWith('/auth/logout')) { cookie = 'signed-out'; return envelope({}); }
      assert.ok(path.endsWith('/v2/users/me'));
      return envelope({ user_id: 'bob', username: 'bob', onboarding_completed: true });
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await app.mount(() => t.mock.timers.tick(0));
    try {
      await act(async () => { app.session.resolve(null); app.fonts.resolve(); });
      await act(async () => { t.mock.timers.tick(15_000); });
      let next!: Promise<void>;
      await act(async () => {
        next = transition === 'logout' ? app.auth.signOut() : app.establish(bobToken, () => { cookie = 'bob-session'; });
      });
      assert.equal(app.lifecycle.currentGeneration(), 1);
      assert.equal(cookie, 'original', 'a new auth response must wait for the previous rotation');
      await act(async () => { response.resolve(envelope({ accessToken: fixtureToken('alice') })); await next; });
      assert.equal(app.auth.startupError, null);
      assert.equal(app.auth.isLoading, false);
      if (transition === 'logout') {
        assert.equal(app.auth.user, null);
        assert.equal(app.storedToken, null);
        assert.equal(cookie, 'signed-out', 'logout response must win after old rotation settles');
        assert.equal(calls.filter(path => path.endsWith('/v2/users/me')).length, 0);
      } else {
        assert.equal(app.auth.user?.user_id, 'bob');
        assert.equal(app.storedToken, bobToken, 'late old refresh must not overwrite new account credentials');
        assert.equal(cookie, 'bob-session', 'new account cookie must win after the old rotation settles');
      }
    } finally { t.mock.timers.reset(); await app.unmount(); t.mock.restoreAll(); }
  }
});

test('logout timeout reports an unsafe marker failure without restoring a superseded account', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  for (const superseded of [false, true]) {
    const app = startup({ realNetwork: true });
    const refreshResponse = deferred<Response>();
    const aliceToken = fixtureToken('alice');
    const bobToken = fixtureToken('bob');
    let logoutRequests = 0;
    let onboardingWrites = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const path = String(url);
      if (path.endsWith('/auth/refresh')) return refreshResponse.promise;
      if (path.endsWith('/auth/logout')) { logoutRequests++; return envelope({}); }
      if (path.endsWith('/v2/onboarding/complete')) { onboardingWrites++; return envelope({ completed: true, viewer: { completed: true, user_id: 'alice', username: 'alice', full_name: 'Alice', date_of_birth: '2000-01-01', onboarding_completed: true } }); }
      assert.ok(path.endsWith('/v2/users/me'));
      const owner = new Headers(options?.headers).get('Authorization') === `Bearer ${bobToken}` ? 'bob' : 'alice';
      return envelope({ user_id: owner, username: owner, onboarding_completed: true });
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await app.mount(() => t.mock.timers.tick(0));
    try {
      await act(async () => { app.session.resolve(aliceToken); app.fonts.resolve(); });
      assert.equal(app.auth.user?.user_id, 'alice');
      const previousCompletion = app.auth.completeOnboarding;
      let refresh!: Promise<unknown>;
      await act(async () => { refresh = app.refresh().catch(error => error); });
      app.failMarkerWrites(true);
      let logout!: Promise<unknown>;
      await act(async () => { logout = app.auth.signOut().catch(error => error); });
      let switchAccount: Promise<void> | undefined;
      if (superseded) {
        app.failMarkerWrites(false);
        await act(async () => { switchAccount = app.establish(bobToken); });
      }
      let result: unknown;
      await act(async () => { t.mock.timers.tick(15_000); result = await logout; });
      assert.equal(logoutRequests, 0, 'timeout must not bypass cookie response serialization');
      if (!superseded) {
        assert.equal((result as Error).name, 'LogoutNotCompletedError');
        assert.equal(app.auth.user?.user_id, 'alice', 'unsafe logout must restore the viewer and report failure');
        assert.equal(app.storedToken, aliceToken);
        const draft = { username: 'alice', full_name: 'Alice', date_of_birth: '2000-01-01', interests: ['react'] };
        await assert.rejects(previousCompletion(draft), { name: 'SessionChangedError' });
        assert.equal(onboardingWrites, 0, 'pre-logout callback remains fenced');
        await act(async () => { await app.auth.completeOnboarding(draft); });
        assert.equal(onboardingWrites, 1, 'the newly restored viewer can complete onboarding without another profile read');
      } else {
        assert.equal(app.auth.user, null, 'stale logout must not restore alice over the new account transition');
      }
      await act(async () => { refreshResponse.resolve(envelope({ accessToken: aliceToken })); await refresh; await switchAccount; });
      if (superseded) {
        assert.equal(app.auth.user?.user_id, 'bob');
        assert.equal(app.storedToken, bobToken);
      }
    } finally { t.mock.timers.reset(); await app.unmount(); }
  }
});

test('late logout preparation reconciles credentials before restoring the current viewer', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  for (const outcome of ['saved', 'failed', 'superseded']) {
    const app = startup({ realNetwork: true });
    const marker = deferred<void>();
    const refreshResponse = deferred<Response>();
    const aliceToken = fixtureToken('alice');
    const bobToken = fixtureToken('bob');
    let onboardingWrites = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const path = String(url);
      if (path.endsWith('/auth/refresh')) return refreshResponse.promise;
      if (path.endsWith('/v2/onboarding/complete')) { onboardingWrites++; return envelope({ completed: true, viewer: { completed: true, user_id: 'alice', username: 'alice', full_name: 'Alice', date_of_birth: '2000-01-01', onboarding_completed: true } }); }
      assert.ok(path.endsWith('/v2/users/me'), 'no out-of-order logout request may start');
      const owner = new Headers(options?.headers).get('Authorization') === `Bearer ${bobToken}` ? 'bob' : 'alice';
      return envelope({ user_id: owner, username: owner, onboarding_completed: true });
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await app.mount(() => t.mock.timers.tick(0));
    try {
      await act(async () => { app.session.resolve(aliceToken); app.fonts.resolve(); });
      const previousCompletion = app.auth.completeOnboarding;
      let refresh!: Promise<unknown>;
      await act(async () => { refresh = app.refresh().catch(error => error); });
      app.holdMarkerWrites(marker.promise);
      let logout!: Promise<unknown>;
      await act(async () => { logout = app.auth.signOut().catch(error => error); });
      let result: unknown;
      await act(async () => { t.mock.timers.tick(15_000); result = await logout; });
      assert.equal((result as Error).name, 'LogoutNotCompletedError');
      assert.equal(app.auth.user, null, 'unfinished cleanup must not restore a potentially unusable session');
      assert.equal(app.storedToken, aliceToken, 'the storage write is still pending');
      app.holdMarkerWrites(undefined);
      let switchAccount: Promise<void> | undefined;
      if (outcome === 'superseded') await act(async () => { switchAccount = app.establish(bobToken); });
      await act(async () => {
        if (outcome === 'saved') marker.resolve(); else marker.reject(new Error('Synthetic delayed marker failure'));
      });
      if (outcome === 'saved') {
        assert.equal(app.storedToken, null);
        assert.equal(app.auth.user, null, 'late successful cleanup must leave the viewer signed out');
      } else if (outcome === 'failed') {
        assert.equal(app.storedToken, aliceToken);
        assert.equal(app.auth.user?.user_id, 'alice', 'confirmed marker failure may restore only its current viewer');
        const draft = { username: 'alice', full_name: 'Alice', date_of_birth: '2000-01-01', interests: ['react'] };
        await assert.rejects(previousCompletion(draft), { name: 'SessionChangedError' });
        assert.equal(onboardingWrites, 0, 'pre-logout callback remains fenced after deferred recovery');
        await act(async () => { await app.auth.completeOnboarding(draft); });
        assert.equal(onboardingWrites, 1, 'deferred restoration binds the fresh completion callback to its recovery generation');
      } else {
        assert.equal(app.auth.user, null, 'late preparation must not restore the superseded viewer');
      }
      await act(async () => { refreshResponse.resolve(envelope({ accessToken: aliceToken })); await refresh; await switchAccount; });
      if (outcome === 'superseded') {
        assert.equal(app.auth.user?.user_id, 'bob');
        assert.equal(app.storedToken, bobToken);
      }
    } finally { t.mock.timers.reset(); await app.unmount(); }
  }
});


test('onboarding deadline fences the real apiV2 storage read immediately before fetch', async t => {
  const app = startup({ realNetwork: true });
  const token = fixtureToken('alice');
  let writes = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = String(url);
    assert.ok(path.endsWith('/v2/users/me') || path.endsWith('/v2/onboarding/complete'));
    const viewer = { user_id: 'alice', username: 'alice', full_name: 'Alice', date_of_birth: '2000-01-01', onboarding_completed: false };
    if (options?.method === 'PUT') { writes++; return envelope({ completed: true, viewer: { ...viewer, onboarding_completed: true } }); }
    return envelope(viewer);
  });
  await app.mount();
  try {
    await act(async () => { app.session.resolve(token); app.fonts.resolve(); });
    const lateRead = deferred<string | null>(); let reads = 0;
    app.setTokenReadOverride(() => ++reads === 1 ? Promise.resolve(token) : lateRead.promise);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let outcome: any;
    await act(async () => { void app.auth.completeOnboarding({ username: 'alice', full_name: 'Alice', date_of_birth: '2000-01-01', interests: ['react'] }).catch(error => { outcome = error; }); });
    assert.equal(reads, 2, 'the real client performs an additional session-token read before fetch');
    await act(async () => { t.mock.timers.tick(15_000); });
    assert.equal(app.auth.onboardingSave.status, 'idle', 'a deadline before actual fetch is a safe no-write outcome');
    assert.match(outcome?.message ?? '', /timed out/i);
    app.setTokenReadOverride(() => Promise.resolve(token));
    let retry: Promise<void> | undefined;
    await act(async () => { retry = app.auth.completeOnboarding({ username: 'alice', full_name: 'Alice', date_of_birth: '2000-01-01', interests: ['react'] }); });
    assert.equal(writes, 1, 'an unsent client preflight cannot retain the retirement lane after its deadline');
    await act(async () => retry);
    await act(async () => lateRead.resolve(token));
    assert.equal(writes, 1, 'beforeSend must fence a late transport preparation continuation');
  } finally { t.mock.timers.reset(); await app.unmount(); }
});

test('real apiV2 applies the onboarding send fence to exactly one 401 refresh retry', async t => {
  for (const expired of [false, true]) {
    const app = startup({ realNetwork: true });
    const oldToken = fixtureToken('alice');
    const rotatedToken = `synthetic.${Buffer.from(JSON.stringify({ userId: 'alice', rotated: true })).toString('base64url')}.signature`;
    const rotation = deferred<Response>(); let writes = 0, refreshes = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const path = String(url);
      if (path.endsWith('/auth/refresh')) { refreshes++; return rotation.promise; }
      if (path.endsWith('/v2/onboarding/complete')) {
        writes++;
        if (writes === 1) return new Response(JSON.stringify({ success: false, error: 'expired' }), { status: 401 });
        return envelope({ completed: true, viewer: { completed: true, user_id: 'alice', username: 'alice', full_name: 'Alice', date_of_birth: '2000-01-01', onboarding_completed: true } });
      }
      assert.ok(path.endsWith('/v2/users/me'));
      return envelope({ user_id: 'alice', username: 'alice', onboarding_completed: false });
    });
    await app.mount();
    try {
      await act(async () => { app.session.resolve(oldToken); app.fonts.resolve(); });
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let saving!: Promise<any>;
      await act(async () => { saving = app.auth.completeOnboarding({ username: 'alice', full_name: 'Alice', date_of_birth: '2000-01-01', interests: ['react'] }).then(() => null, error => error); });
      assert.equal(writes, 1); assert.equal(refreshes, 1);
      if (expired) await act(async () => { t.mock.timers.tick(15_000); });
      await act(async () => { rotation.resolve(envelope({ accessToken: rotatedToken, user: { id: 'alice' } })); });
      const result = await saving;
      assert.equal(refreshes, 1, 'a rejected send fence cannot trigger another refresh');
      assert.equal(writes, expired ? 1 : 2, 'only an unexpired flight may perform the existing single 401 retry');
      if (!expired) assert.equal(result, null);
      else assert.equal(app.auth.onboardingSave.status, 'idle', 'the first 401 plus blocked retry is a definite no-write outcome');
    } finally { t.mock.timers.reset(); await app.unmount(); }
  }
});

test('same-turn failed logout restores a fresh onboarding lease without reviving a retained callback', async t => {
  const app = startup({ realNetwork: true });
  const token = fixtureToken('alice'); let writes = 0;
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = String(url);
    if (path.endsWith('/auth/logout')) throw new TypeError('revocation unavailable');
    if (path.endsWith('/v2/onboarding/complete')) { writes++; return envelope({ completed: true, viewer: { completed: true, user_id: 'alice', username: 'alice', full_name: 'Alice', date_of_birth: '2000-01-01', onboarding_completed: true } }); }
    assert.ok(path.endsWith('/v2/users/me'));
    return envelope({ user_id: 'alice', username: 'alice', onboarding_completed: false });
  });
  await app.mount();
  try {
    await act(async () => { app.session.resolve(token); app.fonts.resolve(); });
    const oldCompletion = app.auth.completeOnboarding;
    app.failMarkerWrites(true);
    await act(async () => { await assert.rejects(app.auth.signOut(), { name: 'LogoutNotCompletedError' }); });
    assert.equal(app.auth.user?.user_id, 'alice');
    const draft = { username: 'alice', full_name: 'Alice', date_of_birth: '2000-01-01', interests: ['react'] };
    await assert.rejects(oldCompletion(draft), { name: 'SessionChangedError' });
    assert.equal(writes, 0);
    await act(async () => app.auth.completeOnboarding(draft));
    assert.equal(writes, 1);
  } finally { await app.unmount(); }
});
