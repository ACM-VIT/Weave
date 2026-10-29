import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import React, { act, useEffect, useState } from "react";
import { create } from "react-test-renderer";
import ts from "typescript";
import { SessionLifecycle } from "../../src/api/session-lifecycle";

export function loadSource(path: string, mocks: Record<string, unknown>): Record<string, any> {
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

export // Render the real layout and AuthProvider, replacing only native/platform and
// storage/network boundaries. In particular, keep the real QueryClientProvider
// and startup session restoration so provider ordering is exercised too.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export type Viewer = { user_id: string; username: string; onboarding_completed: boolean; likes_given_count?: number };

export function startup({
  segments = ['(auth)'],
  viewer = { user_id: 'alice', username: 'alice', onboarding_completed: true },
  realNetwork = false,
  mountCallback = false,
  globalParams = {} as Record<string, string>,
  pathname = '/repository/test-repo',
}: { segments?: string[]; viewer?: Viewer | null; realNetwork?: boolean; mountCallback?: boolean; globalParams?: Record<string, string>; pathname?: string } = {}) {
  const fonts = deferred<void>();
  const session = deferred<string | null>();
  const events: string[] = [];
  const redirects: string[] = [];
  let navigationMounts = 0;
  let navigationUnmounts = 0;
  let splashHides = 0;
  let storedToken: string | null | undefined;
  let profileRequest: Promise<Viewer> | undefined;
  let feedRequest: Promise<any> | undefined;
  let feedClient: any;
  let refreshRequest: Promise<string> | undefined;
  let markerWritesFail = false;
  let pendingMarkerWrite: Promise<void> | undefined;
  let setExternalRestoreBlocked: (value: string | null) => void = () => { throw new Error('real storage required'); };
  let callbackScreen: React.ComponentType | undefined;
  let tokenReadOverride: (() => Promise<string | null>) | undefined;
  let auth!: {
    user: Viewer | null;
    isLoading: boolean;
    setSession: (session: { accessToken: string; sessionGeneration: number }) => Promise<void>;
    startupError: string | null;
    retryStartupSession: () => Promise<void>;
    signOut: () => Promise<void>;
    adjustLikesGivenCount: (eventId: string, delta: -1 | 1) => void;
    settleLikesGivenCountAdjustments: (eventIds: readonly string[]) => void;
    checkOnboardingStatus: () => Promise<void>;
    finishOnboarding: (data: import('../../src/api/onboarding').OnboardingData) => Promise<void>;
    completeOnboarding: (data: { username: string; full_name: string; date_of_birth: string; interests: string[] }) => Promise<void>;
    onboardingSave: { status: string; message: string | null };
    reconcileOnboarding: () => Promise<void>;
  };
  session.promise.then(token => { storedToken = token; });
  const router = { replace: (path: string) => { redirects.push(path); } };
  const lifecycle = new SessionLifecycle();

  const mocks: Record<string, unknown> = {
    '@/global.css': {},
    '@/components/onboarding/GithubUnlinkCallback': { GithubUnlinkCallback: () => null },
    'react-native-keyboard-controller': { KeyboardProvider: ({ children }: { children: React.ReactNode }) => children },
    'expo-router': {
      useSegments: () => segments,
      usePathname: () => pathname,
      useGlobalSearchParams: () => globalParams,
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
    '../api/feed-sessions': { feedSessions: () => ({ endAll: async () => undefined }) },
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
    setExternalRestoreBlocked = value => { restoreBlocked = value; };
    const storage = {
      getStorageItem: (key: string) => key === 'access_token'
        ? tokenReadOverride ? tokenReadOverride() : storedToken === undefined ? session.promise : Promise.resolve(storedToken)
        : Promise.resolve(restoreBlocked),
      getStorageItemStrict: async (key: string) => key === 'access_token' ? storedToken ?? null : restoreBlocked,
      setStorageItem: async (key: string, value: string) => {
        if (key === 'access_token') storedToken = value;
        else {
          events.push('marker:start');
          if (markerWritesFail) throw new Error('Synthetic marker storage failure');
          if (pendingMarkerWrite) await pendingMarkerWrite;
          restoreBlocked = value;
        }
      },
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

  const homeFeedModule = loadSource('src/services/homeFeedQuery.ts', {
    '../utils/storage': mocks['../utils/storage'],
    '../api/session-lifecycle': mocks['../api/session-lifecycle'],
    '../api/feed-sessions': {feedSessions: () => ({prepare: async (session: string) => session})},
    '../api/home-feed': {fetchHomeFeed: async () => {
      events.push('feed:prefetch');
      return feedRequest ?? {items:[],nextCursor:null,feedVersion:'1'};
    }},
  });
  mocks['@/services/homeFeedQuery'] = {...homeFeedModule, homeFeedQueryOptions: (client: unknown, owner: string) => {
    feedClient = client;
    return homeFeedModule.homeFeedQueryOptions(client, owner);
  }};
  mocks['../api/onboarding'] = loadSource('src/api/onboarding.ts', {
    './client': mocks['../api/client'], './session-lifecycle': mocks['../api/session-lifecycle'],
  });
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
      clearOAuthClientVerifier: async () => { events.push('verifier:clear'); },
    };
    callbackScreen = loadSource('src/app/(auth)/callback.tsx', mocks).default;
  }
  const Layout = loadSource('src/app/_layout.tsx', mocks).default;
  let root: ReturnType<typeof create>;
  return {
    fonts, session, events, redirects, lifecycle,
    setFeedRequest(request: Promise<any>) { feedRequest = request; },
    get feedClient() { return feedClient; },
    homeFeedOptions(owner: string) { return homeFeedModule.homeFeedQueryOptions(feedClient, owner); },
    get auth() { return auth; },
    failMarkerWrites(value: boolean) { markerWritesFail = value; },
    holdMarkerWrites(value: Promise<void> | undefined) { pendingMarkerWrite = value; },
    refresh() { return (mocks['../api/client'] as any).refreshSession(storedToken) as Promise<string>; },
    isRestoreBlocked() { return realTransitions!.isSessionRestoreBlocked() as Promise<boolean>; },
    setExternalRestoreBlocked(value: string | null) { setExternalRestoreBlocked(value); },
    async establish(token: string, onRequest: () => void = () => undefined) {
      const session = await realTransitions!.establishSession(async () => {
        onRequest();
        return { accessToken: token, user: viewer };
      });
      await auth.setSession(session);
    },
    get storedToken() { return storedToken; },
    setStoredToken(token: string) { storedToken = token; },
    setTokenReadOverride(next: (() => Promise<string | null>) | undefined) { tokenReadOverride = next; },
    setProfileRequest(request: Promise<Viewer>) { profileRequest = request; },
    setRefreshRequest(request: Promise<string>) { refreshRequest = request; },
    navigate(next: string[]) { segments.splice(0, segments.length, ...next); root.update(React.createElement(Layout)); },
    retryExchange() { root.root.findByProps({ accessibilityLabel: 'Retry authorization code exchange' }).props.onPress(); },
    get exchangeRetryButton() { return root.root.findAllByProps({ accessibilityLabel: 'Retry authorization code exchange' })[0]?.props; },
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

export const fixtureToken = (owner: string) => `synthetic.${Buffer.from(JSON.stringify({ userId: owner })).toString('base64url')}.signature`;

export const envelope = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
