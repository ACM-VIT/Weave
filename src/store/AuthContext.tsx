import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { getStorageItem } from '../utils/storage';
import { logout as logoutRequest } from '../api/auth';
import { apiV2, refreshSession, setSessionExpiredHandler } from '../api/client';
import { httpStatus } from '../api/session-errors';
import { authSessionLifecycle, SessionChangedError } from '../api/session-lifecycle';
import {
  isSessionRestoreBlocked,
  LogoutNotCompletedError,
  retireSessionIfCurrent,
  type AuthenticatedSession,
} from '../api/session-transitions';
import {
  DEVELOPMENT_PREVIEW_ENABLED,
  DEVELOPMENT_PREVIEW_USER,
} from '../config/development-preview';
import { resolveOnboardingCompleted } from '../utils/auth-routing';
import {
  mergeSavedUserProfile,
  type SavedUserProfileAttributes,
} from '../utils/profile-state';
import { restoreStartupSession } from './restore-session';
import { useQueryClient } from '@tanstack/react-query';
import { clearAccountQueryCache } from '../services/accountQueryCache';

interface User {
  user_id: string;
  username: string;
  email?: string;
  onboarding_completed: boolean;
  [key: string]: any;
}

export type EditableUserProfile = SavedUserProfileAttributes;

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  setSession: (session: AuthenticatedSession<any>) => Promise<void>;
  signOut: () => Promise<void>;
  checkOnboardingStatus: () => Promise<void>;
  updateUserProfile: (profile: EditableUserProfile) => void;
}

type UserProfileRequestPolicy = {
  allowRefresh?: boolean;
  clearUnauthorized?: boolean;
  logErrors?: boolean;
  sessionGeneration?: number;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(() => (
    DEVELOPMENT_PREVIEW_ENABLED ? DEVELOPMENT_PREVIEW_USER : null
  ));
  const [isLoading, setIsLoading] = useState(!DEVELOPMENT_PREVIEW_ENABLED);

  const fetchUserProfile = useCallback(async (
    token: string,
    {
      allowRefresh = true,
      clearUnauthorized = true,
      logErrors = true,
      sessionGeneration = authSessionLifecycle.currentGeneration(),
    }: UserProfileRequestPolicy = {},
  ) => {
    try {
      authSessionLifecycle.assertCurrent(sessionGeneration);
      const requestPolicy = { allowRefresh };
      const profile = await apiV2<Record<string, unknown>>('/users/me', {}, token, requestPolicy);
      authSessionLifecycle.assertCurrent(sessionGeneration);
      const completionStatus = typeof profile.onboarding_completed === 'boolean'
        ? profile.onboarding_completed
        : (await apiV2<{ completed: boolean }>('/onboarding/status', {}, token, requestPolicy)).completed;
      authSessionLifecycle.assertCurrent(sessionGeneration);
      setUser({
        ...profile,
        user_id: String(profile.user_id),
        username: String(profile.username),
        onboarding_completed: resolveOnboardingCompleted(profile, completionStatus),
      });
    } catch (error) {
      const status = httpStatus(error);
      const responseToken = typeof (error as { accessToken?: unknown })?.accessToken === 'string'
        ? (error as { accessToken: string }).accessToken
        : token;
      // A 404 means an older valid session predates its v2 product profile.
      // Clear it so the next login can run ensureIdentityProfile atomically.
      if (status === 404 || (status === 401 && clearUnauthorized)) {
        const retired = await retireSessionIfCurrent(sessionGeneration, responseToken);
        if (retired) {
          setUser(null);
        }
      }
      if (logErrors && !(error instanceof SessionChangedError)) {
        console.error('Failed to fetch user profile', error);
      }
      throw error;
    }
  }, []);

  const loadSession = useCallback(async () => {
    if (DEVELOPMENT_PREVIEW_ENABLED) {
      setUser(DEVELOPMENT_PREVIEW_USER);
      setIsLoading(false);
      return;
    }
    const sessionGeneration = authSessionLifecycle.currentGeneration();
    try {
      const restoreBlocked = await isSessionRestoreBlocked();
      authSessionLifecycle.assertCurrent(sessionGeneration);
      if (restoreBlocked) {
        // A previous logout or interrupted auth transition deliberately left a
        // durable marker. Stay anonymous and retry server-side cookie cleanup;
        // a later successful login is serialized after this request and wins.
        setIsLoading(false);
        void logoutRequest().catch((error) => {
          console.error('Failed to retry server session revocation', error);
        });
        return;
      }

      await restoreStartupSession({
        getAccessToken: () => getStorageItem('access_token'),
        refreshAccessToken: refreshSession,
        assertSessionCurrent: () => authSessionLifecycle.assertCurrent(sessionGeneration),
        // Startup recovery owns one bounded refresh cycle and reuses a token
        // already rotated by another request before attempting another refresh.
        loadUserProfile: (token, attempt) => fetchUserProfile(token, {
          allowRefresh: false,
          clearUnauthorized: attempt !== 'stored',
          logErrors: false,
          sessionGeneration,
        }),
      });
    } catch (e) {
      if (!(e instanceof SessionChangedError)) console.error('Failed to load session', e);
    } finally {
      if (authSessionLifecycle.isCurrent(sessionGeneration)) setIsLoading(false);
    }
  }, [fetchUserProfile]);

  const checkOnboardingStatus = useCallback(async () => {
    if (DEVELOPMENT_PREVIEW_ENABLED) return;
    const sessionGeneration = authSessionLifecycle.currentGeneration();
    const token = await getStorageItem('access_token');
    authSessionLifecycle.assertCurrent(sessionGeneration);
    if (token) {
      await fetchUserProfile(token, { sessionGeneration });
    }
  }, [fetchUserProfile]);

  const updateUserProfile = useCallback((profile: EditableUserProfile) => {
    setUser((current) => mergeSavedUserProfile(current, profile));
  }, []);

  const setSession = useCallback(async ({
    accessToken,
    sessionGeneration,
  }: AuthenticatedSession<any>) => {
    authSessionLifecycle.assertCurrent(sessionGeneration);
    const storedToken = await getStorageItem('access_token');
    authSessionLifecycle.assertCurrent(sessionGeneration);
    if (storedToken !== accessToken) throw new SessionChangedError();

    clearAccountQueryCache(queryClient);
    setUser(null);
    setIsLoading(true);
    try {
      await fetchUserProfile(accessToken, { sessionGeneration });
    } finally {
      if (authSessionLifecycle.isCurrent(sessionGeneration)) setIsLoading(false);
    }
  }, [fetchUserProfile, queryClient]);

  const signOut = useCallback(async () => {
    if (DEVELOPMENT_PREVIEW_ENABLED) {
      setUser(DEVELOPMENT_PREVIEW_USER);
      setIsLoading(false);
      return;
    }
    const previousUser = user;
    const logout = logoutRequest();
    clearAccountQueryCache(queryClient);
    setUser(null);
    setIsLoading(false);

    try {
      await logout;
    } catch (e) {
      if (e instanceof LogoutNotCompletedError) {
        setUser(previousUser);
        throw e;
      }
      console.error('Failed to revoke server session', e);
    }
  }, [user, queryClient]);

  useEffect(() => authSessionLifecycle.subscribe(() => {
    clearAccountQueryCache(queryClient);
    setUser(null);
    setIsLoading(false);
  }), [queryClient]);

  useEffect(() => {
    setSessionExpiredHandler(() => { clearAccountQueryCache(queryClient); setUser(null); });
    return () => setSessionExpiredHandler(null);
  }, [queryClient]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadSession();
    }, 0);

    return () => clearTimeout(timer);
  }, [loadSession]);

  return (
    <AuthContext.Provider value={{
      user,
      isLoading,
      setSession,
      signOut,
      checkOnboardingStatus,
      updateUserProfile,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
