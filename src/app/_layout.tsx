import '@/global.css';
import { useEffect, useState } from 'react';
import { Stack, useRouter, useSegments } from "expo-router";
import Head from 'expo-router/head';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Sentry from '@sentry/react-native';

import { AuthProvider, useAuth } from '../store/AuthContext';

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
  const { user, isLoading } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const isReady = fontsReady && !isLoading;
  const [startupComplete, setStartupComplete] = useState(false);
  if (isReady && !startupComplete) setStartupComplete(true);

  useEffect(() => {
    Sentry.setUser(user?.user_id ? { id: user.user_id } : null);
  }, [user?.user_id]);

  useEffect(() => {
    if (!isReady) return;

    const inAuthGroup = segments[0] === '(auth)';
    const inOnboardingGroup = segments[0] === 'onboarding';
    const rootSegment = segments[0] as string | undefined;
    const inPublicRoute = rootSegment === 'terms' || rootSegment === 'privacy';

    if (!user && !inAuthGroup && !inPublicRoute) {
      router.replace('/(auth)/login');
    } else if (user) {
      if (user.onboarding_completed === false && !inOnboardingGroup) {
        router.replace('/onboarding/create-profile');
      } else if (user.onboarding_completed === true && (inAuthGroup || inOnboardingGroup)) {
        router.replace('/(tabs)/home');
      }
    }
  }, [user, isReady, segments, router]);

  useEffect(() => {
    if (startupComplete) {
      SplashScreen.hideAsync();
    }
  }, [startupComplete]);

  // Restore authentication in parallel with fonts, but never mount a route
  // (including a protected deep link) until both startup tasks have settled.
  // Later sign-in/profile transitions must not reset the mounted navigator.
  if (!isReady && !startupComplete) return null;

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
        <title>Weave — Discover open source</title>
        <meta name="description" content="Discover open-source repositories and connect with developers." />
        <meta name="theme-color" content="#151110" />
        <meta property="og:title" content="Weave — Discover open source" />
        <meta property="og:description" content="Discover open-source repositories and connect with developers." />
      </Head>
      <QueryClientProvider client={queryClient}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <AuthProvider>
            <RootLayoutNav fontsReady={loaded || Boolean(error)} />
          </AuthProvider>
        </GestureHandlerRootView>
      </QueryClientProvider>
    </>
  );
}

export default Sentry.wrap(Layout);
