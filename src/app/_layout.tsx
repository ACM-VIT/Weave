import { homeFeedQueryOptions } from '@/services/homeFeedQuery';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import '@/global.css';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Stack, type Href, usePathname, useRouter, useSegments, useGlobalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import * as Sentry from '@sentry/react-native';

import { AuthProvider, useAuth } from '../store/AuthContext';
import {
  pendingProtectedRepositoryRoute,
  postAuthenticationRoute,
} from '../utils/auth-routing';
import type { RepositoryRouteHref } from '../utils/repository-links';
import { REFERENCE_THEME } from '../constants/theme';

// Keep the splash screen visible while we fetch resources
SplashScreen.preventAutoHideAsync();

const sentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
Sentry.init({
  dsn: sentryDsn,
  enabled: Boolean(sentryDsn) && !__DEV__,
  sendDefaultPii: false,
  tracesSampleRate: 0.1,
});

function RootLayoutNav({ fontsReady }: { fontsReady: boolean }) {
  const { user, isLoading, startupError, retryStartupSession } = useAuth();
  const pathname = usePathname();
  const unlinkParams = useGlobalSearchParams<{ unlink_code?: string; unlink_error?: string }>();
  const unlinkCallback = pathname.endsWith('/callback') && Boolean(unlinkParams.unlink_code || unlinkParams.unlink_error);
  const queryClient = useQueryClient();
  const pendingProtectedRouteRef = useRef<RepositoryRouteHref | null>(null);
  const previousViewerRef = useRef<string | null | undefined>(undefined);
  const segments = useSegments();
  const router = useRouter();
  const inAuthGroup = segments[0] === '(auth)';
  const rootSegment = segments[0] as string | undefined;
  const inPublicRoute = inAuthGroup || rootSegment === 'terms' || rootSegment === 'privacy';
  const publicRouteReady = fontsReady && inPublicRoute;
  const isReady = fontsReady && !isLoading && !startupError;
  const [startupComplete, setStartupComplete] = useState(false);
  if (isReady && !startupComplete) setStartupComplete(true);
  const splashHidden = useRef(false);

  useEffect(() => {
    Sentry.setUser(user?.user_id ? { id: user.user_id } : null);
  }, [user?.user_id]);

  useEffect(() => {
    if (isLoading) return;
    const viewer = user?.user_id ?? null;
    if (previousViewerRef.current !== undefined && previousViewerRef.current !== viewer) queryClient.clear();
    previousViewerRef.current = viewer;
  }, [isLoading, queryClient, user?.user_id]);

  useEffect(() => {
    if (!isReady || unlinkCallback) return;

    const inOnboardingGroup = segments[0] === 'onboarding';
    const routeRequiresAuthentication = !inAuthGroup && !inPublicRoute;

    if (routeRequiresAuthentication
      && (!user || user.onboarding_completed === false)) {
      const protectedRoute = pendingProtectedRepositoryRoute(pathname);
      if (protectedRoute) pendingProtectedRouteRef.current = protectedRoute;
    }

    if (!user && !inAuthGroup && !inPublicRoute) {
      router.replace('/(auth)/login');
    } else if (user) {
      if (user.onboarding_completed === false && !inOnboardingGroup) {
        router.replace('/onboarding/create-profile');
      } else if (user.onboarding_completed === true && (inAuthGroup || inOnboardingGroup)) {
        const destination = postAuthenticationRoute(pendingProtectedRouteRef.current);
        pendingProtectedRouteRef.current = null;
        router.replace(destination as Href);
      }
    }
  }, [user, isReady, pathname, segments, router, inAuthGroup, inPublicRoute, unlinkCallback]);

  useEffect(() => {
    if (isLoading || startupError || !user?.user_id || user.onboarding_completed !== true || unlinkCallback) return;
    // The mounted Home screen joins this exact query and pagination controller.
    void queryClient.prefetchInfiniteQuery(homeFeedQueryOptions(queryClient, user.user_id));
  }, [isLoading, startupError, queryClient, user?.user_id, user?.onboarding_completed, unlinkCallback]);

  useEffect(() => {
    if (!splashHidden.current && fontsReady && (startupComplete || startupError || publicRouteReady)) {
      splashHidden.current = true;
      SplashScreen.hideAsync();
    }
  }, [fontsReady, startupComplete, startupError, publicRouteReady]);

  // Public auth routes must mount to exchange OAuth codes or recover an account
  // even if restoring an unrelated old session stalls or fails. Protected deep
  // links still wait behind the startup gate, including after a public route.
  // Later sign-in/profile transitions must not reset the mounted navigator.
  if (fontsReady && startupError && !startupComplete && !inPublicRoute) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 16, backgroundColor: REFERENCE_THEME.background }}>
        <Text accessibilityRole="alert" style={{ color: REFERENCE_THEME.text }}>
          {isLoading ? 'Restoring your session…' : startupError}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Try restoring session again"
          accessibilityState={{ disabled: isLoading, busy: isLoading }}
          disabled={isLoading}
          onPress={() => { if (!isLoading) void retryStartupSession(); }}
          style={{ padding: 16, backgroundColor: REFERENCE_THEME.accent, borderRadius: 9, opacity: isLoading ? 0.65 : 1 }}
        >
          <Text style={{ color: REFERENCE_THEME.background, textAlign: 'center' }}>
            {isLoading ? 'Restoring…' : 'Try again'}
          </Text>
        </Pressable>
      </View>
    );
  }
  if (!isReady && !startupComplete && !publicRouteReady) return null;

  return <Stack screenOptions={{ headerShown: false }} />;
}

const queryClient = new QueryClient();

function Layout() {
  const [loaded, error] = useFonts({
    'NataSans-Regular': require('../../assets/fonts/NataSans-Regular.ttf'),
    'NataSans-Medium': require('../../assets/fonts/NataSans-Medium.ttf'),
    'NataSans-SemiBold': require('../../assets/fonts/NataSans-SemiBold.ttf'),
    'NataSans-Bold': require('../../assets/fonts/NataSans-Bold.ttf'),
  });

  return (
    <>
      <Head>
        <title>weave</title>
        <meta name="description" content="Discover open-source repositories and connect with developers." />
        <meta name="theme-color" content="#151110" />
        <meta property="og:title" content="weave" />
        <meta property="og:description" content="Discover open-source repositories and connect with developers." />
      </Head>
      <QueryClientProvider client={queryClient}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <KeyboardProvider>
            <AuthProvider>
              <RootLayoutNav fontsReady={loaded || Boolean(error)} />
            </AuthProvider>
          </KeyboardProvider>
        </GestureHandlerRootView>
      </QueryClientProvider>
    </>
  );
}

export default Sentry.wrap(Layout);
