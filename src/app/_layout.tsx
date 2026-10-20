import { KeyboardProvider } from 'react-native-keyboard-controller';
import '@/global.css';
import { useEffect, useRef } from 'react';
import {
  Stack,
  type Href,
  usePathname,
  useRouter,
  useSegments,
} from 'expo-router';
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

// Keep the splash screen visible while we fetch resources
SplashScreen.preventAutoHideAsync();

const sentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
Sentry.init({
  dsn: sentryDsn,
  enabled: Boolean(sentryDsn) && !__DEV__,
  sendDefaultPii: false,
  tracesSampleRate: 0.1,
});

function RootLayoutNav() {
  const { user, isLoading } = useAuth();
  const pathname = usePathname();
  const segments = useSegments();
  const router = useRouter();
  const queryClient = useQueryClient();
  const pendingProtectedRouteRef = useRef<RepositoryRouteHref | null>(null);
  const previousViewerRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    Sentry.setUser(user?.user_id ? { id: user.user_id } : null);
  }, [user?.user_id]);

  useEffect(() => {
    if (isLoading) return;
    const viewerUserId = user?.user_id ?? null;
    if (previousViewerRef.current !== undefined
      && previousViewerRef.current !== viewerUserId) {
      queryClient.clear();
    }
    previousViewerRef.current = viewerUserId;
  }, [isLoading, queryClient, user?.user_id]);

  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === '(auth)';
    const inOnboardingGroup = segments[0] === 'onboarding';
    const rootSegment = segments[0] as string | undefined;
    const inPublicRoute = rootSegment === 'terms' || rootSegment === 'privacy';
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
  }, [user, isLoading, pathname, segments, router]);

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

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error]);

  if (!loaded && !error) {
    return null;
  }

  return (
    <>
      <Head>
        <title>Weave — Discover open source</title>
        <meta name="description" content="Discover open-source repositories and connect with developers." />
        <meta name="theme-color" content="#151110" />
        <meta property="og:title" content="Weave — Discover open source" />
        <meta property="og:description" content="Discover open-source repositories and connect with developers." />
      </Head>
      <QueryClientProvider client={queryClient}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <KeyboardProvider>
            <AuthProvider>
              <RootLayoutNav />
            </AuthProvider>
          </KeyboardProvider>
        </GestureHandlerRootView>
      </QueryClientProvider>
    </>
  );
}

export default Sentry.wrap(Layout);
