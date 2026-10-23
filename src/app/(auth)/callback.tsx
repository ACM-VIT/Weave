import { GithubUnlinkCallback } from '@/components/onboarding/GithubUnlinkCallback';
import { useEffect, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { useAuth } from '@/store/AuthContext';
import { exchangeCode } from '@/api/auth';
import { SessionRefreshPendingError } from '../../api/session-lifecycle';
import * as WebBrowser from 'expo-web-browser';
import {
  clearOAuthClientVerifier,
  loadOAuthClientVerifier,
} from '@/services/oauthClientPkce';

WebBrowser.maybeCompleteAuthSession();

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
  const { unlink_code, unlink_error } = useLocalSearchParams<{ unlink_code?: string; unlink_error?: string }>();
  if (unlink_code || unlink_error) return <GithubUnlinkCallback code={unlink_code} error={unlink_error} />;
  return <SignInCallbackScreen />;
}
function SignInCallbackScreen() {
  const { code, error: oauthError } = useLocalSearchParams<{ code?: string; error?: string }>();
  const { setSession } = useAuth();
  const router = useRouter();
  const [exchangeError, setExchangeError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  const [attempt, setAttempt] = useState(0);
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
    loadOAuthClientVerifier()
      .then((verifier) => {
        if (!verifier) throw new Error('This sign-in attempt is no longer available. Please try again.');
        return exchangeCode(code, verifier);
      })
      .then(async (data) => {
        await clearOAuthClientVerifier().catch(() => undefined);
        await setSession(data);
      })
      .catch((err) => {
        setRetryable(err instanceof SessionRefreshPendingError);
        setExchangeError(err.message || 'Authentication failed');
      });
  }, [code, oauthError, setSession, attempt]);

  if (errorMsg) {
    return (
      <View className="flex-1 bg-[#000000] items-center justify-center px-8">
        <Text className="text-white text-[20px] font-nataBold text-center mb-3">
          Sign-in failed
        </Text>
        <Text className="text-[rgba(235,235,245,0.6)] text-[14px] font-nata text-center mb-8">
          {errorMsg}
        </Text>
        {retryable ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Retry authorization code exchange"
            className="bg-[#63E08A] rounded-[9px] px-8 py-4 mb-4"
            onPress={() => {
              exchangedCodeRef.current = null;
              setRetryable(false);
              setExchangeError(null);
              setAttempt(current => current + 1);
            }}
          >
            <Text className="text-[#000000] font-nataBold text-[15px]">Try again</Text>
          </TouchableOpacity>
        ) : null}
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
