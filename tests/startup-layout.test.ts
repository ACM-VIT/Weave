import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import React, { act, useEffect, useState } from 'react';
import { create } from 'react-test-renderer';
import ts from 'typescript';

import { SessionLifecycle } from '../src/api/session-lifecycle';

function loadSource(path: string, mocks: Record<string, unknown>): Record<string, any> {
  const filename = resolve(path);
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  const javascript = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const requireBoundary = (specifier: string) => {
    if (specifier in mocks) return mocks[specifier];
    if (specifier.endsWith('.ttf')) return 1;
    return nativeRequire(specifier);
  };
  new Function('require', 'module', 'exports', '__DEV__', javascript)(
    requireBoundary, module, module.exports, true,
  );
  return module.exports;
}

// Render the real layout and AuthProvider, replacing only native/platform and
// storage/network boundaries. In particular, keep the real QueryClientProvider
// and startup session restoration so provider ordering is exercised too.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type Viewer = { user_id: string; username: string; onboarding_completed: boolean };

function startup({
  segments = ['(auth)'],
  viewer = { user_id: 'alice', username: 'alice', onboarding_completed: true },
  realNetwork = false,
  mountCallback = false,
}: { segments?: string[]; viewer?: Viewer | null; realNetwork?: boolean; mountCallback?: boolean } = {}) {
  const fonts = deferred<void>();
  const session = deferred<string | null>();
  const events: string[] = [];
  const redirects: string[] = [];
  let navigationMounts = 0;
  let navigationUnmounts = 0;
  let splashHides = 0;
  let storedToken: string | null | undefined;
  let profileRequest: Promise<Viewer> | undefined;
  let refreshRequest: Promise<string> | undefined;
  let callbackScreen: React.ComponentType | undefined;
  let auth!: {
    user: Viewer | null;
    isLoading: boolean;
    setSession: (session: { accessToken: string; sessionGeneration: number }) => Promise<void>;
    startupError: string | null;
    retryStartupSession: () => Promise<void>;
    signOut: () => Promise<void>;
  };
  session.promise.then(token => { storedToken = token; });
  const router = { replace: (path: string) => { redirects.push(path); } };
  const lifecycle = new SessionLifecycle();

  const mocks: Record<string, unknown> = {
    '@/global.css': {},
    'expo-router': {
      useSegments: () => segments,
      useLocalSearchParams: () => ({ code: 'synthetic-oauth-code' }),
      useRouter: () => router,
      Stack: () => {
        useEffect(() => {
          navigationMounts += 1;
          return () => { navigationUnmounts += 1; };
        }, []);
        return callbackScreen ? React.createElement(callbackScreen) : null;
      },
    },
    'expo-router/head': () => null,
    'react-native': { View: 'View', Text: 'Text', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator', TouchableOpacity: 'TouchableOpacity' },
    '../constants/theme': { REFERENCE_THEME: { background: '#000', text: '#fff', textSecondary: '#aaa', accent: '#30D158' } },
    'expo-font': {
      useFonts: () => {
        const [state, setState] = useState<[boolean, Error | null]>([false, null]);
        useEffect(() => {
          events.push('fonts:start');
          let active = true;
          fonts.promise.then(
            () => { if (active) setState([true, null]); },
            (error) => { if (active) setState([false, error]); },
          );
          return () => { active = false; };
        }, []);
        return state;
      },
    },
    'expo-splash-screen': {
      preventAutoHideAsync: async () => undefined,
      hideAsync: async () => { splashHides += 1; },
    },
    'react-native-gesture-handler': {
      GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => children,
    },
    '@sentry/react-native': { init: () => undefined, setUser: () => undefined, wrap: (component: unknown) => component },
    '../utils/storage': {
      getStorageItem: () => {
        events.push('session:start');
        return storedToken === undefined ? session.promise : Promise.resolve(storedToken);
      },
    },
    '../api/auth': { logout: async () => undefined },
    '../api/client': {
      apiV2: async () => profileRequest ?? viewer,
      refreshSession: async () => {
        if (refreshRequest) return refreshRequest;
        throw Object.assign(new Error('No session'), { status: 401 });
      },
      setSessionExpiredHandler: () => undefined,
    },
    '../api/session-lifecycle': {
      ...createRequire(resolve('src/store/AuthContext.tsx'))('../api/session-lifecycle'),
      authSessionLifecycle: lifecycle,
    },
    '../api/session-transitions': {
      isSessionRestoreBlocked: async () => false,
      retireSessionIfCurrent: async () => false,
    },
    '../config/development-preview': { DEVELOPMENT_PREVIEW_ENABLED: false },
  };

  let realTransitions: Record<string, any> | undefined;
  if (realNetwork) {
    let restoreBlocked: string | null = null;
    const storage = {
      getStorageItem: (key: string) => key === 'access_token'
        ? storedToken === undefined ? session.promise : Promise.resolve(storedToken)
        : Promise.resolve(restoreBlocked),
      getStorageItemStrict: async (key: string) => key === 'access_token' ? storedToken ?? null : restoreBlocked,
      setStorageItem: async (key: string, value: string) => { if (key === 'access_token') storedToken = value; else restoreBlocked = value; },
      removeStorageItem: async (key: string) => { if (key === 'access_token') storedToken = null; else restoreBlocked = null; },
    };
    const sessionLifecycle = mocks['../api/session-lifecycle'];
    realTransitions = loadSource('src/api/session-transitions.ts', {
      '../utils/storage': storage, './session-lifecycle': sessionLifecycle,
    });
    const networkMocks = {
      './config': { API_URL: 'http://127.0.0.1:1/api' },
      '../utils/storage': storage, './session-lifecycle': sessionLifecycle,
      './session-transitions': realTransitions,
    };
    mocks['../utils/storage'] = storage;
    mocks['../api/session-transitions'] = realTransitions;
    mocks['../api/client'] = loadSource('src/api/client.ts', networkMocks);
    mocks['../api/auth'] = loadSource('src/api/auth.ts', networkMocks);
    mocks['@/api/auth'] = mocks['../api/auth'];
  }

  const authModule = loadSource('src/store/AuthContext.tsx', mocks);
  function AuthProbe() { auth = authModule.useAuth(); return null; }
  mocks['../store/AuthContext'] = {
    ...authModule,
    AuthProvider: ({ children }: { children: React.ReactNode }) => React.createElement(
      authModule.AuthProvider, null, children, React.createElement(AuthProbe),
    ),
  };
  if (mountCallback) {
    mocks['@/store/AuthContext'] = authModule;
    mocks['expo-web-browser'] = { maybeCompleteAuthSession: () => undefined };
    mocks['@/services/oauthClientPkce'] = {
      loadOAuthClientVerifier: async () => 'synthetic-client-verifier',
      clearOAuthClientVerifier: async () => undefined,
    };
    callbackScreen = loadSource('src/app/(auth)/callback.tsx', mocks).default;
  }
  const Layout = loadSource('src/app/_layout.tsx', mocks).default;
  let root: ReturnType<typeof create>;
  return {
    fonts, session, events, redirects, lifecycle,
    get auth() { return auth; },
    async establish(token: string, onRequest: () => void = () => undefined) {
      const session = await realTransitions!.establishSession(async () => {
        onRequest();
        return { accessToken: token, user: viewer };
      });
      await auth.setSession(session);
    },
    get storedToken() { return storedToken; },
    setStoredToken(token: string) { storedToken = token; },
    setProfileRequest(request: Promise<Viewer>) { profileRequest = request; },
    setRefreshRequest(request: Promise<string>) { refreshRequest = request; },
    navigate(next: string[]) { segments.splice(0, segments.length, ...next); root.update(React.createElement(Layout)); },
    retry() { root.root.findByProps({ accessibilityLabel: 'Try restoring session again' }).props.onPress(); },
    get recoveryButton() { return root.root.findAllByProps({ accessibilityLabel: 'Try restoring session again' })[0]?.props; },
    get navigationMounts() { return navigationMounts; },
    get navigationUnmounts() { return navigationUnmounts; },
    get splashHides() { return splashHides; },
    async mount(flushTimers?: () => void) {
      await act(async () => { root = create(React.createElement(Layout)); });
      // AuthProvider deliberately defers its restore by one timer turn.
      await act(async () => {
        if (flushTimers) flushTimers();
        else await new Promise(resolve => setTimeout(resolve, 0));
      });
    },
    async unmount() { await act(async () => { root.unmount(); }); },
  };
}

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test('session restoration starts while fonts are pending; fonts alone cannot reveal protected navigation', async () => {
  const app = startup({ segments: ['(tabs)'] });
  await app.mount();
  try {
    assert.ok(app.events.includes('fonts:start'));
    assert.ok(app.events.includes('session:start'), 'restoration must start before fonts settle');
    assert.equal(app.navigationMounts, 0);
    assert.equal(app.splashHides, 0);

    await act(async () => { app.fonts.resolve(); });
    assert.equal(app.navigationMounts, 0, 'no protected screen while session is unresolved');
    assert.equal(app.splashHides, 0);
    assert.deepEqual(app.redirects, []);

    await act(async () => { app.session.resolve('stored-token'); });
    assert.ok(app.navigationMounts > 0);
    assert.equal(app.splashHides, 1);
    assert.deepEqual(app.redirects, []);
  } finally {
    await app.unmount();
  }
});

test('a restored session still waits for fonts and preserves onboarding routing', async () => {
  const app = startup({ viewer: { user_id: 'new', username: 'new', onboarding_completed: false } });
  await app.mount();
  try {
    await act(async () => { app.session.resolve('stored-token'); });
    assert.equal(app.navigationMounts, 0);
    assert.equal(app.splashHides, 0);
    assert.deepEqual(app.redirects, []);

    await act(async () => { app.fonts.resolve(); });
    assert.ok(app.navigationMounts > 0);
    assert.equal(app.splashHides, 1);
    assert.deepEqual(app.redirects, ['/onboarding/create-profile']);
    assert.equal(app.events.filter(event => event === 'session:start').length, 1);
  } finally {
    await app.unmount();
  }
});

test('font failure releases the splash only after anonymous restoration and keeps sign-in routing', async () => {
  const app = startup({ segments: ['(tabs)'], viewer: null });
  await app.mount();
  try {
    await act(async () => { app.fonts.reject(new Error('font unavailable')); });
    assert.equal(app.splashHides, 0);
    assert.equal(app.navigationMounts, 0);

    await act(async () => { app.session.resolve(null); });
    assert.equal(app.splashHides, 1);
    assert.ok(app.navigationMounts > 0);
    assert.deepEqual(app.redirects, ['/(auth)/login']);
  } finally {
    await app.unmount();
  }
});

test('anonymous public routes remain public once both startup tasks finish', async () => {
  const app = startup({ segments: ['privacy'], viewer: null });
  await app.mount();
  try {
    await act(async () => { app.session.resolve(null); app.fonts.resolve(); });
    assert.ok(app.navigationMounts > 0);
    assert.equal(app.splashHides, 1);
    assert.deepEqual(app.redirects, []);
  } finally {
    await app.unmount();
  }
});

test('unmounting during startup cannot later hide the splash or navigate', async () => {
  const app = startup();
  await app.mount();
  await app.unmount();
  await act(async () => { app.session.resolve('stored-token'); app.fonts.resolve(); });
  assert.equal(app.navigationMounts, 0);
  assert.equal(app.splashHides, 0);
  assert.deepEqual(app.redirects, []);
});

test('post-startup sign-in preserves the navigator through delayed success and profile failure', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const app = startup({ viewer: null });
  await app.mount();
  try {
    await act(async () => { app.session.resolve(null); app.fonts.resolve(); });
    const profile = deferred<Viewer>();
    app.setStoredToken('login-token');
    app.setProfileRequest(profile.promise);
    let login!: Promise<unknown>;
    await act(async () => {
      login = app.auth.setSession({ accessToken: 'login-token', sessionGeneration: 0 });
    });
    assert.equal(app.auth.isLoading, true);
    assert.equal(app.navigationMounts, 1);
    assert.equal(app.navigationUnmounts, 0);
    await act(async () => {
      profile.resolve({ user_id: 'alice', username: 'alice', onboarding_completed: true });
      await login;
    });
    assert.equal(app.auth.user?.user_id, 'alice');
    assert.deepEqual(app.redirects, ['/(tabs)/home']);

    const failedProfile = deferred<Viewer>();
    app.setProfileRequest(failedProfile.promise);
    await act(async () => {
      login = app.auth.setSession({ accessToken: 'login-token', sessionGeneration: 0 })
        .catch(error => error);
    });
    assert.equal(app.auth.isLoading, true);
    assert.equal(app.navigationUnmounts, 0);
    const failure = Object.assign(new Error('profile unavailable'), { status: 503 });
    await act(async () => { failedProfile.reject(failure); assert.equal(await login, failure); });
    assert.equal(app.auth.isLoading, false);
    assert.equal(app.navigationMounts, 1);
    assert.equal(app.navigationUnmounts, 0);
    assert.equal(app.splashHides, 1);
  } finally {
    await app.unmount();
  }
});

test('a superseded post-startup session cannot reset navigation or replace the newer viewer', async () => {
  const app = startup({ viewer: null });
  await app.mount();
  try {
    await act(async () => { app.session.resolve(null); app.fonts.resolve(); });
    const staleProfile = deferred<Viewer>();
    app.setStoredToken('old-token');
    app.setProfileRequest(staleProfile.promise);
    let staleLogin!: Promise<unknown>;
    await act(async () => {
      staleLogin = app.auth.setSession({ accessToken: 'old-token', sessionGeneration: 0 })
        .catch(error => error);
    });
    await act(async () => { app.lifecycle.retire(0); });
    const newerProfile = deferred<Viewer>();
    app.setStoredToken('new-token');
    app.setProfileRequest(newerProfile.promise);
    let newerLogin!: Promise<void>;
    await act(async () => {
      newerLogin = app.auth.setSession({ accessToken: 'new-token', sessionGeneration: 1 });
    });
    await act(async () => {
      newerProfile.resolve({ user_id: 'bob', username: 'bob', onboarding_completed: true });
      await newerLogin;
      staleProfile.resolve({ user_id: 'alice', username: 'alice', onboarding_completed: true });
      assert.equal((await staleLogin as Error).name, 'SessionChangedError');
    });
    assert.equal(app.auth.user?.user_id, 'bob');
    assert.equal(app.auth.isLoading, false);
    assert.equal(app.navigationMounts, 1);
    assert.equal(app.navigationUnmounts, 0);
    assert.equal(app.splashHides, 1);
  } finally {
    await app.unmount();
  }
});

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

test('superseding a pending startup cannot finish the newer session profile loading state', async () => {
  const app = startup();
  const staleProfile = deferred<Viewer>();
  app.setProfileRequest(staleProfile.promise);
  await app.mount();
  try {
    await act(async () => { app.session.resolve('old-token'); app.fonts.resolve(); });
    await act(async () => { app.lifecycle.retire(0); });
    const newProfile = deferred<Viewer>();
    app.setStoredToken('new-token');
    app.setProfileRequest(newProfile.promise);
    let login!: Promise<void>;
    await act(async () => {
      login = app.auth.setSession({ accessToken: 'new-token', sessionGeneration: 1 });
    });
    await act(async () => {
      staleProfile.resolve({ user_id: 'alice', username: 'obsolete', onboarding_completed: true });
    });
    assert.equal(app.auth.isLoading, true, 'old startup cleanup must not finish a newer profile request');
    assert.equal(app.auth.user, null);
    await act(async () => {
      newProfile.resolve({ user_id: 'bob', username: 'bob', onboarding_completed: true });
      await login;
    });
    assert.equal(app.auth.user?.user_id, 'bob');
    await act(async () => { await app.auth.signOut(); });
    assert.equal(app.auth.user, null);
  } finally {
    await app.unmount();
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

test('signing out during startup cancels the pending profile instead of restoring its viewer later', async () => {
  const app = startup();
  const staleProfile = deferred<Viewer>();
  app.setProfileRequest(staleProfile.promise);
  await app.mount();
  try {
    await act(async () => { app.session.resolve('old-token'); app.fonts.resolve(); });
    await act(async () => { await app.auth.signOut(); });
    await act(async () => {
      staleProfile.resolve({ user_id: 'alice', username: 'obsolete', onboarding_completed: true });
    });
    assert.equal(app.auth.user, null);
    assert.equal(app.auth.startupError, null);
    assert.equal(app.auth.isLoading, false);
    assert.equal(app.navigationMounts, 1);
  } finally {
    await app.unmount();
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


const fixtureToken = (owner: string) => `synthetic.${Buffer.from(JSON.stringify({ userId: owner })).toString('base64url')}.signature`;
const envelope = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

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

test('a cold real OAuth callback exchanges its code despite an unrelated restore failure', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const app = startup({ segments: ['(auth)', 'callback'], realNetwork: true, mountCallback: true });
  let profiles = 0;
  let exchanges = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = String(url);
    if (path.endsWith('/auth/exchange')) {
      exchanges++;
      return envelope({ accessToken: fixtureToken('alice'), user: { id: 'alice' } });
    }
    assert.ok(path.endsWith('/v2/users/me'));
    if (++profiles === 1) return new Response(JSON.stringify({ error: 'Temporary outage' }), { status: 503 });
    return envelope({ user_id: 'alice', username: 'alice', onboarding_completed: true });
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await app.mount(() => t.mock.timers.tick(0));
  try {
    await act(async () => { app.session.resolve(fixtureToken('alice')); });
    assert.ok(app.auth.startupError);
    await act(async () => { app.fonts.resolve(); });
    assert.equal(exchanges, 1, 'the actual callback screen must mount and exchange its code');
    assert.equal(app.auth.user?.user_id, 'alice');
    assert.equal(app.auth.startupError, null);
    assert.deepEqual(app.redirects, ['/(tabs)/home']);
  } finally { t.mock.timers.reset(); await app.unmount(); }
});


test('public account recovery can mount during restoration but protected deep links stay gated', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  for (const segments of [['(auth)', 'forgot-password'], ['(auth)', 'reset-password'], ['privacy'], ['terms'], ['(tabs)', 'home'], ['onboarding', 'create-profile'], ['repository', 'private-id']]) {
    const app = startup({ segments });
    const profile = deferred<Viewer>();
    app.setProfileRequest(profile.promise);
    await app.mount();
    try {
      await act(async () => { app.session.resolve('stored-token'); app.fonts.resolve(); });
      const publicRoute = segments[0] === '(auth)' || ['privacy', 'terms'].includes(segments[0]);
      assert.equal(app.navigationMounts, publicRoute ? 1 : 0, segments.join('/'));
      await act(async () => { profile.reject(new TypeError('offline')); });
      assert.ok(app.auth.startupError);
      assert.equal(app.navigationMounts, publicRoute ? 1 : 0, 'restore errors must not expose protected routes');
      assert.equal(app.splashHides, 1);
      assert.deepEqual(app.redirects, []);
    } finally { await app.unmount(); }
  }
});


test('leaving a public recovery route cannot reveal a protected route before startup settles', async () => {
  const app = startup({ segments: ['(auth)', 'forgot-password'] });
  await app.mount();
  try {
    await act(async () => { app.fonts.resolve(); });
    assert.equal(app.navigationMounts - app.navigationUnmounts, 1);
    await act(async () => { app.navigate(['(tabs)', 'home']); });
    assert.equal(app.navigationMounts - app.navigationUnmounts, 0, 'public route access must not release the protected startup gate');
    await act(async () => { app.session.resolve('valid-token'); });
    assert.equal(app.navigationMounts - app.navigationUnmounts, 1);
  } finally { await app.unmount(); }
});
