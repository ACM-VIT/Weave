import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { getStorageItem, setStorageItem, removeStorageItem } from '../utils/storage';
import { API_URL } from '../api/config';
import { apiV2, refreshSession, setSessionExpiredHandler } from '../api/client';
import {
  AUTH_BYPASS_ENABLED,
  AUTH_BYPASS_PROFILE_STORAGE_KEY,
  AUTH_BYPASS_USER,
} from '../constants/auth';

interface User {
  user_id: string;
  username: string;
  email?: string;
  onboarding_completed: boolean;
  [key: string]: any;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  setSession: (token: string, user: any) => Promise<void>;
  enterOnboardingPreview: () => Promise<void>;
  completeOnboardingPreview: () => void;
  signOut: () => Promise<void>;
  checkOnboardingStatus: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const isDemoModeEnabled =
  __DEV__ && process.env.EXPO_PUBLIC_DEMO_MODE === 'true';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadBypassUser = useCallback(async () => {
    const savedProfile = await getStorageItem(AUTH_BYPASS_PROFILE_STORAGE_KEY);
    if (!savedProfile) return AUTH_BYPASS_USER;

    try {
      const parsedProfile = JSON.parse(savedProfile);
      return {
        ...AUTH_BYPASS_USER,
        ...(typeof parsedProfile.username === 'string' ? { username: parsedProfile.username } : {}),
        ...(typeof parsedProfile.full_name === 'string' ? { full_name: parsedProfile.full_name } : {}),
        ...(typeof parsedProfile.bio === 'string' ? { bio: parsedProfile.bio } : {}),
      };
    } catch {
      return AUTH_BYPASS_USER;
    }
  }, []);

  const fetchUserProfile = useCallback(async (token: string) => {
    try {
      const profile = await apiV2<Record<string, unknown> & { topics?: unknown[] }>('/users/me', {}, token);
      setUser({
        ...profile,
        user_id: String(profile.user_id),
        username: String(profile.username),
        onboarding_completed: Array.isArray(profile.topics) && profile.topics.length > 0,
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      // A 404 means an older valid session predates its v2 product profile.
      // Clear it so the next login can run ensureIdentityProfile atomically.
      if (status === 401 || status === 404) {
        await removeStorageItem('access_token').catch(() => undefined);
        setUser(null);
        return;
      }
      console.error('Failed to fetch user profile', error);
    }
  }, []);

  const loadSession = useCallback(async () => {
    try {
      if (AUTH_BYPASS_ENABLED) {
        setUser(await loadBypassUser());
        return;
      }

      let token = await getStorageItem('access_token');
      if (!token) token = await refreshSession().catch(() => null);
      if (token) {
        await fetchUserProfile(token);
      }
    } catch (e) {
      console.error('Failed to load session', e);
    } finally {
      setIsLoading(false);
    }
  }, [fetchUserProfile, loadBypassUser]);

  const checkOnboardingStatus = async () => {
    if (AUTH_BYPASS_ENABLED) {
      setUser(await loadBypassUser());
      return;
    }

    const token = await getStorageItem('access_token');
    if (token) {
      await fetchUserProfile(token);
    }
  };

  const setSession = async (token: string, authUser: any) => {
    if (AUTH_BYPASS_ENABLED) {
      setUser(await loadBypassUser());
      return;
    }

    await setStorageItem('access_token', token);

    // Let routing move a newly-created account into onboarding immediately,
    // then replace this optimistic value with the canonical backend profile.
    setUser({
      ...authUser,
      user_id: authUser?.user_id ?? authUser?.id,
      username:
        authUser?.username ??
        authUser?.user_metadata?.user_name ??
        'new-user',
      onboarding_completed: false,
    });
    await fetchUserProfile(token);
  };

  const enterOnboardingPreview = async () => {
    if (!isDemoModeEnabled) return;

    // This preview is intentionally local-only: no auth or backend request.
    await removeStorageItem('access_token').catch(() => undefined);
    setUser({
      user_id: 'local-onboarding-preview',
      username: 'preview_user',
      full_name: 'Preview User',
      onboarding_completed: false,
      isPreview: true,
    });
  };

  const completeOnboardingPreview = () => {
    setUser((currentUser) =>
      currentUser?.isPreview
        ? { ...currentUser, onboarding_completed: true }
        : currentUser,
    );
  };

  const signOut = async () => {
    if (AUTH_BYPASS_ENABLED) {
      setUser(await loadBypassUser());
      return;
    }

    try {
      const token = await getStorageItem('access_token');
      await fetch(`${API_URL}/auth/logout`, { 
        method: 'POST',
        credentials: 'include',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
    } catch (e) {
      console.error(e);
    }
    
    try {
      await removeStorageItem('access_token');
    } catch (e) {
      console.error('Failed to clear session storage', e);
    } finally {
      setUser(null);
    }
  };

  useEffect(() => {
    setSessionExpiredHandler(() => setUser(null));
    return () => setSessionExpiredHandler(null);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadSession();
    }, 0);

    return () => clearTimeout(timer);
  }, [loadSession]);

  return (
    <AuthContext.Provider value={{ user, isLoading, setSession, enterOnboardingPreview, completeOnboardingPreview, signOut, checkOnboardingStatus }}>
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
