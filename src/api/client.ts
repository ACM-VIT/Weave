import { API_URL } from './config';
import { getStorageItem, removeStorageItem, setStorageItem } from '../utils/storage';
import { createSingleFlight } from '../utils/single-flight';
import { isTerminalRefreshStatus } from './session-errors';
import { retryUnauthorizedResponse, type TokenResponse } from './unauthorized-retry';

type ApiEnvelope<T> = { success: true; data: T } | { success?: false; error?: string };

type RefreshResponse = {
  accessToken?: string;
  token?: string;
};

type ApiV2RequestPolicy = {
  allowRefresh?: boolean;
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

async function expireStoredSession(): Promise<void> {
  await removeStorageItem('access_token').catch(() => undefined);
  sessionExpiredHandler?.();
}

const refreshAccessToken = createSingleFlight(async (): Promise<string> => {
  const response = await fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });

  let payload: ApiEnvelope<RefreshResponse> | null;
  try {
    payload = await readJson(response) as ApiEnvelope<RefreshResponse> | null;
  } catch (error) {
    if (isTerminalRefreshStatus(response.status)) {
      await expireStoredSession();
      Object.assign(error as object, { status: response.status });
    }
    throw error;
  }

  const refreshData = payload
    && typeof payload === 'object'
    && 'data' in payload
    && payload.data
    && typeof payload.data === 'object'
    ? payload.data as RefreshResponse
    : null;
  const token = refreshData?.accessToken ?? refreshData?.token;

  if (!response.ok || !token) {
    const isTerminal = isTerminalRefreshStatus(response.status);
    const error = Object.assign(
      new Error(isTerminal
        ? 'Your session has expired. Please log in again.'
        : 'Could not refresh your session. Please try again.'),
      { status: response.status },
    );
    if (isTerminal) await expireStoredSession();
    throw error;
  }

  await setStorageItem('access_token', token);
  return token;
});

export function refreshSession(): Promise<string> {
  return refreshAccessToken();
}

async function sendV2Request(
  path: string,
  options: RequestInit,
  token?: string | null,
): Promise<TokenResponse<Response>> {
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

  return { response, token: token ?? null };
}

async function requestV2(
  path: string,
  options: RequestInit,
  token?: string | null,
  allowRefresh = true,
): Promise<TokenResponse<Response>> {
  return retryUnauthorizedResponse({
    result: await sendV2Request(path, options, token),
    allowRefresh,
    getAccessToken: () => getStorageItem('access_token'),
    refreshAccessToken,
    retry: (retryToken) => sendV2Request(path, options, retryToken),
  });
}

export async function apiV2<T>(
  path: string,
  options: RequestInit = {},
  token?: string | null,
  policy: ApiV2RequestPolicy = {},
): Promise<T> {
  const result = await requestV2(path, options, token, policy.allowRefresh ?? true);
  const { response } = result;
  const payload = await readJson(response) as ApiEnvelope<T> | null;
  if (!response.ok) {
    const error = new Error(payload && 'error' in payload && payload.error
      ? payload.error : `Backend request failed (${response.status}).`);
    Object.assign(error, {
      status: response.status,
      retryAfter: response.headers.get('retry-after'),
      accessToken: result.token,
    });
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
  const result = await requestV2(path, options, token);
  const { response } = result;
  const payload = await readJson(response) as T | { error?: string } | null;
  if (!response.ok) {
    const error = new Error(payload && typeof payload === 'object' && 'error' in payload && payload.error
      ? String(payload.error) : `Backend request failed (${response.status}).`);
    Object.assign(error, {
      status: response.status,
      retryAfter: response.headers.get('retry-after'),
      accessToken: result.token,
    });
    throw error;
  }
  return { data: payload as T, response };
}
