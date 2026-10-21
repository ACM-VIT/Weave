import { API_URL } from './config';
import { getStorageItem } from '../utils/storage';
import {
  accessTokenOwner,
  selectCurrentSessionToken,
  tokensHaveSameOwner,
} from './access-token-owner';
import { isTerminalRefreshStatus } from './session-errors';
import {
  authSessionLifecycle,
  SessionChangedError,
  type SessionLease,
} from './session-lifecycle';
import {
  isSessionRestoreBlocked,
  retireSessionIfCurrent,
  storeAccessTokenForLease,
} from './session-transitions';
import { retryUnauthorizedResponse, type TokenResponse } from './unauthorized-retry';

type ApiEnvelope<T> = { success: true; data: T } | { success?: false; error?: string };

type RefreshResponse = {
  accessToken?: string;
  token?: string;
  user?: { id?: string };
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

async function expireStoredSession(lease: SessionLease): Promise<void> {
  const retired = await retireSessionIfCurrent(lease.generation, undefined, lease.assertCurrent);
  if (!retired) throw new SessionChangedError();
  sessionExpiredHandler?.();
}

const refreshAccessToken = (
  expectedToken?: string | null,
  signal?: AbortSignal,
): Promise<string> => authSessionLifecycle.runRefresh(async (lease) => {
  // Startup cancellation is also checked at persistence boundaries. A fetch
  // implementation or a body read that settles late must not mutate a session.
  if (signal) {
    const sessionLease = lease;
    lease = {
      generation: sessionLease.generation,
      isCurrent: () => sessionLease.isCurrent() && !signal.aborted,
      assertCurrent: () => {
        sessionLease.assertCurrent();
        if (signal.aborted) throw new SessionChangedError();
      },
    };
  }
  lease.assertCurrent();
  if (await isSessionRestoreBlocked()) throw new SessionChangedError();
  lease.assertCurrent();

  const response = await fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json' },
    signal,
  });
  lease.assertCurrent();

  let payload: ApiEnvelope<RefreshResponse> | null;
  try {
    payload = await readJson(response) as ApiEnvelope<RefreshResponse> | null;
  } catch (error) {
    lease.assertCurrent();
    if (isTerminalRefreshStatus(response.status)) {
      await expireStoredSession(lease);
      Object.assign(error as object, { status: response.status });
    }
    throw error;
  }
  lease.assertCurrent();

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
    if (isTerminal) await expireStoredSession(lease);
    throw error;
  }

  const returnedOwner = accessTokenOwner(token);
  const responseOwner = refreshData?.user?.id;
  const ownerChanged = expectedToken
    ? !tokensHaveSameOwner(expectedToken, token)
    : false;
  const responseOwnerMismatch = typeof responseOwner === 'string'
    && (returnedOwner === null || responseOwner !== returnedOwner);
  if (ownerChanged || responseOwnerMismatch) {
    await retireSessionIfCurrent(lease.generation, undefined, lease.assertCurrent);
    throw new SessionChangedError();
  }

  await storeAccessTokenForLease(lease, token);
  return token;
});

export function refreshSession(expectedToken?: string | null, signal?: AbortSignal): Promise<string> {
  return refreshAccessToken(expectedToken, signal);
}

async function resolveRequestToken(
  requestedToken: string | null | undefined,
  generation: number,
): Promise<string | null> {
  if (await isSessionRestoreBlocked()) throw new SessionChangedError();
  authSessionLifecycle.assertCurrent(generation);
  if (!requestedToken) return null;

  const currentToken = await getStorageItem('access_token');
  authSessionLifecycle.assertCurrent(generation);
  const sessionToken = selectCurrentSessionToken(requestedToken, currentToken);
  if (!sessionToken) throw new SessionChangedError();
  return sessionToken;
}

async function sendV2Request(
  path: string,
  options: RequestInit,
  token?: string | null,
  generation = authSessionLifecycle.currentGeneration(),
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

  return { response, token: token ?? null, generation };
}

async function requestV2(
  path: string,
  options: RequestInit,
  token?: string | null,
  allowRefresh = true,
): Promise<TokenResponse<Response>> {
  const generation = authSessionLifecycle.currentGeneration();
  const requestToken = await resolveRequestToken(token, generation);
  authSessionLifecycle.assertCurrent(generation);
  const result = await sendV2Request(path, options, requestToken, generation);
  authSessionLifecycle.assertCurrent(generation);

  return retryUnauthorizedResponse({
    result,
    allowRefresh,
    getAccessToken: () => getStorageItem('access_token'),
    refreshAccessToken,
    retry: (retryToken) => sendV2Request(path, options, retryToken, generation),
    assertSessionCurrent: (requestGeneration) => {
      authSessionLifecycle.assertCurrent(requestGeneration);
    },
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
  authSessionLifecycle.assertCurrent(result.generation);
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
  authSessionLifecycle.assertCurrent(result.generation);
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
