import { httpStatus, isTerminalRefreshError } from '../api/session-errors';

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
