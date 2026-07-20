import { API_URL } from './config';
import { getStorageItem, removeStorageItem, setStorageItem } from '../utils/storage';
import { createSingleFlight } from '../utils/single-flight';

type ApiEnvelope<T> = { success: true; data: T } | { success?: false; error?: string };

type RefreshResponse = {
  accessToken?: string;
  token?: string;
};

let sessionExpiredHandler: (() => void) | null = null;

export function setSessionExpiredHandler(handler: (() => void) | null) {
  sessionExpiredHandler = handler;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { throw new Error(`Backend returned invalid JSON (${response.status}).`); }
}

const refreshAccessToken = createSingleFlight(async (): Promise<string> => {
  try {
    const response = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    const payload = await readJson(response) as ApiEnvelope<RefreshResponse> | null;
    const token = payload && 'data' in payload
      ? payload.data.accessToken ?? payload.data.token
      : undefined;

    if (!response.ok || !token) {
      throw new Error('Your session has expired. Please log in again.');
    }

    await setStorageItem('access_token', token);
    return token;
  } catch (error) {
    await removeStorageItem('access_token').catch(() => undefined);
    sessionExpiredHandler?.();
    throw error;
  }
});

export function refreshSession(): Promise<string> {
  return refreshAccessToken();
}

async function requestV2(
  path: string,
  options: RequestInit,
  token?: string | null,
  allowRefresh = true,
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(`${API_URL}/v2${path}`, {
    ...options,
    credentials: 'include',
    headers,
  });

  if (response.status !== 401 || !allowRefresh) return response;

  const storedToken = token ?? await getStorageItem('access_token');
  if (!storedToken) return response;

  const refreshedToken = await refreshAccessToken();
  return requestV2(path, options, refreshedToken, false);
}

export async function apiV2<T>(
  path: string,
  options: RequestInit = {},
  token?: string | null,
): Promise<T> {
  const response = await requestV2(path, options, token);
  const payload = await readJson(response) as ApiEnvelope<T> | null;
  if (!response.ok) {
    const error = new Error(payload && 'error' in payload && payload.error
      ? payload.error : `Backend request failed (${response.status}).`);
    Object.assign(error, { status: response.status, retryAfter: response.headers.get('retry-after') });
    throw error;
  }
  if (!payload || !('data' in payload)) throw new Error('Backend response did not contain data.');
  return payload.data;
}

export async function apiV2Raw<T>(
  path: string,
  options: RequestInit = {},
  token?: string | null,
): Promise<{ data: T; response: Response }> {
  const response = await requestV2(path, options, token);
  const payload = await readJson(response) as T | { error?: string } | null;
  if (!response.ok) {
    const error = new Error(payload && typeof payload === 'object' && 'error' in payload && payload.error
      ? String(payload.error) : `Backend request failed (${response.status}).`);
    Object.assign(error, { status: response.status, retryAfter: response.headers.get('retry-after') });
    throw error;
  }
  return { data: payload as T, response };
}
