import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import React, { act, useEffect, useState } from 'react';
import { create } from 'react-test-renderer';
import ts from 'typescript';

import { SessionLifecycle } from '../src/api/session-lifecycle';

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
}: { segments?: string[]; viewer?: Viewer | null } = {}) {
  const fonts = deferred<void>();
  const session = deferred<string | null>();
  const events: string[] = [];
  const redirects: string[] = [];
  let navigationMounts = 0;
  let navigationUnmounts = 0;
  let splashHides = 0;
  let storedToken: string | null | undefined;
  let profileRequest: Promise<Viewer> | undefined;
  let auth!: {
    user: Viewer | null;
    isLoading: boolean;
    setSession: (session: { accessToken: string; sessionGeneration: number }) => Promise<void>;
  };
  session.promise.then(token => { storedToken = token; });
  const router = { replace: (path: string) => { redirects.push(path); } };
  const lifecycle = new SessionLifecycle();

  const mocks: Record<string, unknown> = {
    '@/global.css': {},
    'expo-router': {
      useSegments: () => segments,
      useRouter: () => router,
      Stack: () => {
        useEffect(() => {
          navigationMounts += 1;
          return () => { navigationUnmounts += 1; };
        }, []);
        return null;
      },
    },
    'expo-router/head': () => null,
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
      refreshSession: async () => { throw Object.assign(new Error('No session'), { status: 401 }); },
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

  function loadSource(path: string): Record<string, any> {
    const filename = resolve(path);
    const nativeRequire = createRequire(filename);
    const module = { exports: {} };
    const javascript = ts.transpileModule(readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
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

  const authModule = loadSource('src/store/AuthContext.tsx');
  function AuthProbe() { auth = authModule.useAuth(); return null; }
  mocks['../store/AuthContext'] = {
    ...authModule,
    AuthProvider: ({ children }: { children: React.ReactNode }) => React.createElement(
      authModule.AuthProvider, null, children, React.createElement(AuthProbe),
    ),
  };
  const Layout = loadSource('src/app/_layout.tsx').default;
  let root: ReturnType<typeof create>;
  return {
    fonts, session, events, redirects, lifecycle,
    get auth() { return auth; },
    setStoredToken(token: string) { storedToken = token; },
    setProfileRequest(request: Promise<Viewer>) { profileRequest = request; },
    get navigationMounts() { return navigationMounts; },
    get navigationUnmounts() { return navigationUnmounts; },
    get splashHides() { return splashHides; },
    async mount() {
      await act(async () => { root = create(React.createElement(Layout)); });
      // AuthProvider deliberately defers its restore by one timer turn.
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    },
    async unmount() { await act(async () => { root.unmount(); }); },
  };
}

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test('session restoration starts while fonts are pending; fonts alone cannot reveal navigation', async () => {
  const app = startup();
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
    assert.deepEqual(app.redirects, ['/(tabs)/home']);
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
