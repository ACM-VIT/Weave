import { httpStatus, isTerminalRefreshError } from '../api/session-errors';
import { SessionChangedError } from '../api/session-lifecycle';

export const STARTUP_SESSION_TIMEOUT_MS = 15_000;

export class StartupSessionTimeoutError extends Error {
  constructor() {
    super('Session restoration timed out. Check your connection and try again.');
    this.name = 'StartupSessionTimeoutError';
  }
}

/** Bound even non-cancellable storage reads, and abort fetch/body work too. */
export async function withStartupSessionDeadline(
  controller: AbortController,
  restore: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  let timedOut = false;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(timedOut ? new StartupSessionTimeoutError() : new SessionChangedError());
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, STARTUP_SESSION_TIMEOUT_MS);
  try {
    if (controller.signal.aborted) onAbort();
    await Promise.race([restore(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

export type StartupSessionState = 'authenticated' | 'anonymous';
export type StartupProfileAttempt = 'stored' | 'latest' | 'refreshed';

type StartupSessionDependencies = {
  getAccessToken: () => Promise<string | null>;
  refreshAccessToken: (expectedToken?: string | null) => Promise<string>;
  loadUserProfile: (token: string, attempt: StartupProfileAttempt) => Promise<void>;
  assertSessionCurrent?: () => void;
};

async function refreshForStartup(
  refreshAccessToken: (expectedToken?: string | null) => Promise<string>,
  expectedToken: string | null,
  assertSessionCurrent: () => void,
): Promise<string | null> {
  try {
    const token = await refreshAccessToken(expectedToken);
    assertSessionCurrent();
    return token;
  } catch (error) {
    if (isTerminalRefreshError(error)) return null;
    throw error;
  }
}

export async function restoreStartupSession({
  getAccessToken,
  refreshAccessToken,
  loadUserProfile,
  assertSessionCurrent = () => undefined,
}: StartupSessionDependencies): Promise<StartupSessionState> {
  const storedToken = await getAccessToken();
  assertSessionCurrent();

  if (storedToken) {
    try {
      await loadUserProfile(storedToken, 'stored');
      assertSessionCurrent();
      return 'authenticated';
    } catch (error) {
      if (httpStatus(error) !== 401) throw error;
    }

    const latestToken = await getAccessToken();
    assertSessionCurrent();
    if (latestToken && latestToken !== storedToken) {
      await loadUserProfile(latestToken, 'latest');
      assertSessionCurrent();
      return 'authenticated';
    }
  }

  const refreshedToken = await refreshForStartup(
    refreshAccessToken,
    storedToken,
    assertSessionCurrent,
  );
  if (!refreshedToken) return 'anonymous';

  await loadUserProfile(refreshedToken, 'refreshed');
  assertSessionCurrent();
  return 'authenticated';
}
