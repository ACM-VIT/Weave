import { API_URL } from './config';

const readJson = async (response: Response) => {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Auth service returned an invalid response (${response.status})`);
  }
};

export const register = async (email: string, password: string, fullName: string) => {
  const response = await fetch(`${API_URL}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ 
      email, 
      password, 
      username: email.split('@')[0], // Generate a default username based on email
      full_name: fullName 
    }),
  });

  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(data.error || 'Failed to register');
  }
  return data.data; // Expected { accessToken, user }
};

export const login = async (email: string, password: string) => {
  const response = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  });

  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(data.error || 'Failed to login');
  }
  return data.data; // Expected { accessToken, user }
};

export const logout = async () => {
  const response = await fetch(`${API_URL}/auth/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  });

  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(data.error || 'Failed to logout');
  }
  return data;
};

export const getOAuthUrl = async (
  provider: 'github' | 'google',
  redirectUri: string,
): Promise<string> => {
  const params = new URLSearchParams({ redirect_uri: redirectUri });
  const response = await fetch(`${API_URL}/auth/oauth/${provider}?${params}`);
  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(data.error || `Failed to get ${provider} OAuth URL`);
  }
  return data.data.url as string;
};

export const exchangeCode = async (code: string): Promise<{ accessToken: string; user: any }> => {
  const response = await fetch(`${API_URL}/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ code }),
  });
  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(data.error || 'Failed to exchange authorization code');
  }
  return data.data as { accessToken: string; user: any };
};

export const requestPasswordReset = async (email: string): Promise<string> => {
  const response = await fetch(`${API_URL}/auth/password/reset/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email }),
  });
  const data = await readJson(response);
  if (!response.ok) throw new Error(data.error || 'Unable to request a password reset.');
  return data.data?.message ?? 'If an account exists for that email, a reset link has been sent.';
};

export const confirmPasswordReset = async (
  accessToken: string,
  refreshToken: string,
  password: string,
): Promise<string> => {
  const response = await fetch(`${API_URL}/auth/password/reset/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      password,
    }),
  });
  const data = await readJson(response);
  if (!response.ok) throw new Error(data.error || 'Unable to reset your password.');
  return data.data?.message ?? 'Password updated successfully.';
};
