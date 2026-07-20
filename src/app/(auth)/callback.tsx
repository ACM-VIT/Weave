import { useEffect, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { useAuth } from '@/store/AuthContext';
import { exchangeCode } from '@/api/auth';

/**
 * OAuth Callback Screen — handles the deep-link redirect after OAuth completes.
 *
 * On native: expo-web-browser intercepts this automatically inside useOAuth,
 * so this screen is rarely seen. It serves as a fallback for edge cases
 * and is the primary handler on web targets.
 *
 * The backend redirects to: CLIENT_URL?code=<uuid>  (or ?error=<msg>)
 * Expo Router parses those into search params automatically.
 */
export default function OAuthCallbackScreen() {
  const { code, error: oauthError, flow } = useLocalSearchParams<{
    code?: string;
    error?: string;
    flow?: 'login' | 'signup';
  }>();
  const { setSession } = useAuth();
  const router = useRouter();
  const [exchangeError, setExchangeError] = useState<string | null>(null);
  const exchangedCodeRef = useRef<string | null>(null);
  const routeError = oauthError
    ? decodeURIComponent(oauthError)
    : code
      ? null
      : 'No authorization code received.';
  const errorMsg = routeError ?? exchangeError;

  useEffect(() => {
    if (oauthError || !code || exchangedCodeRef.current === code) return;
    exchangedCodeRef.current = code;

    // Exchange the short-lived code for a JWT — _layout.tsx handles the redirect after
    exchangeCode(code)
      .then((data) => setSession(data.accessToken, data.user, {
        requireOnboarding: flow === 'signup',
      }))
      .catch((err) => setExchangeError(err.message || 'Authentication failed'));
  }, [code, flow, oauthError, setSession]);

  if (errorMsg) {
    return (
      <View className="flex-1 bg-[#000000] items-center justify-center px-8">
        <Text className="text-white text-[20px] font-nataBold text-center mb-3">
          Sign-in failed
        </Text>
        <Text className="text-[rgba(235,235,245,0.6)] text-[14px] font-nata text-center mb-8">
          {errorMsg}
        </Text>
        <TouchableOpacity
          className="bg-[#FFFFFF] rounded-[9px] px-8 py-4"
          onPress={() => router.replace('/(auth)/login')}
        >
          <Text className="text-[#000000] font-nataBold text-[15px]">Back to Login</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-[#000000] items-center justify-center">
      <ActivityIndicator size="large" color="#63E08A" />
      <Text className="text-[rgba(235,235,245,0.6)] text-[14px] font-nata mt-4">
        Signing you in…
      </Text>
    </View>
  );
}
