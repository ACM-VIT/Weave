import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { getStorageItem, setStorageItem, removeStorageItem } from '../utils/storage';
import { API_URL } from '../api/config';
import { apiV2, refreshSession, setSessionExpiredHandler } from '../api/client';
import { resolveOnboardingCompleted } from '../utils/auth-routing';

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
  signOut: () => Promise<void>;
  checkOnboardingStatus: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchUserProfile = useCallback(async (token: string) => {
    try {
      const profile = await apiV2<Record<string, unknown>>('/users/me', {}, token);
      const completionStatus = typeof profile.onboarding_completed === 'boolean'
        ? profile.onboarding_completed
        : (await apiV2<{ completed: boolean }>('/onboarding/status', {}, token)).completed;
      setUser({
        ...profile,
        user_id: String(profile.user_id),
        username: String(profile.username),
        onboarding_completed: resolveOnboardingCompleted(profile, completionStatus),
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      // A 404 means an older valid session predates its v2 product profile.
      // Clear it so the next login can run ensureIdentityProfile atomically.
      if (status === 401 || status === 404) {
        await removeStorageItem('access_token').catch(() => undefined);
        setUser(null);
      }
      console.error('Failed to fetch user profile', error);
      throw error;
    }
  }, []);

  const loadSession = useCallback(async () => {
    try {
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
  }, [fetchUserProfile]);

  const checkOnboardingStatus = useCallback(async () => {
    const token = await getStorageItem('access_token');
    if (token) {
      await fetchUserProfile(token);
    }
  }, [fetchUserProfile]);

  const setSession = async (token: string, _authUser: any) => {
    await setStorageItem('access_token', token);
    setUser(null);
    setIsLoading(true);
    try {
      await fetchUserProfile(token);
    } finally {
      setIsLoading(false);
    }
  };

  const signOut = async () => {
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
    <AuthContext.Provider value={{ user, isLoading, setSession, signOut, checkOnboardingStatus }}>
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
