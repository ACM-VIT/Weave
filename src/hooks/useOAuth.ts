import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { useState } from 'react';
import { useAuth } from '@/store/AuthContext';
import { getOAuthUrl, exchangeCode } from '@/api/auth';
import {
  clearOAuthClientVerifier,
  createOAuthClientPkce,
  persistOAuthClientVerifier,
} from '@/services/oauthClientPkce';
import { oauthErrorMessage } from '@/utils/oauth-errors';

export function useOAuth() {
  const { setSession } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signInWithProvider = async (
    provider: 'github' | 'google',
    authIntent: 'login' | 'signup' = 'login',
  ) => {
    setIsLoading(true);
    setError(null);

    try {
      const clientPkce = await createOAuthClientPkce();
      await persistOAuthClientVerifier(clientPkce.verifier);

      // Build the callback first so the backend returns to this exact Expo runtime.
      const redirectUri = Linking.createURL('callback');

      // Get the OAuth URL from our backend, including the current runtime callback.
      const oauthUrl = await getOAuthUrl(
        provider,
        redirectUri,
        clientPkce.challenge,
        authIntent,
      );
      
      // 3. Open the in-app browser — it will intercept the redirect automatically
      const result = await WebBrowser.openAuthSessionAsync(oauthUrl, redirectUri);

      if (result.type !== 'success') {
        // User cancelled or browser closed — not an error, just bail silently
        await clearOAuthClientVerifier().catch(() => undefined);
        return;
      }

      // 4. Parse the short-lived code from the redirected URL
      const parsed = Linking.parse(result.url);
      const code = parsed.queryParams?.code as string | undefined;

      if (!code) {
        const errorCode = parsed.queryParams?.error;
        const errMsg = typeof errorCode === 'string'
          ? oauthErrorMessage(errorCode)
          : 'OAuth sign-in failed: no authorization code was received.';
        await clearOAuthClientVerifier().catch(() => undefined);
        setError(errMsg);
        return;
      }

      // 5. Exchange code for our custom JWT + refresh token
      const data = await exchangeCode(code, clientPkce.verifier);
      await clearOAuthClientVerifier().catch(() => undefined);

      // 6. Persist session — AuthContext fetches profile which includes onboarding_completed.
      //    _layout.tsx will then automatically redirect to onboarding or tabs.
      await setSession(data);

    } catch (err: any) {
      await clearOAuthClientVerifier().catch(() => undefined);
      setError(err.message || 'OAuth sign-in failed');
    } finally {
      setIsLoading(false);
    }
  };

  return { signInWithProvider, isLoading, error };
}
