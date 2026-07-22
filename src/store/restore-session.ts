import { httpStatus, isTerminalRefreshError } from '../api/session-errors';

export type StartupSessionState = 'authenticated' | 'anonymous';
export type StartupProfileAttempt = 'stored' | 'latest' | 'refreshed';

type StartupSessionDependencies = {
  getAccessToken: () => Promise<string | null>;
  refreshAccessToken: () => Promise<string>;
  loadUserProfile: (token: string, attempt: StartupProfileAttempt) => Promise<void>;
};

async function refreshForStartup(
  refreshAccessToken: () => Promise<string>,
): Promise<string | null> {
  try {
    return await refreshAccessToken();
  } catch (error) {
    if (isTerminalRefreshError(error)) return null;
    throw error;
  }
}

export async function restoreStartupSession({
  getAccessToken,
  refreshAccessToken,
  loadUserProfile,
}: StartupSessionDependencies): Promise<StartupSessionState> {
  const storedToken = await getAccessToken();

  if (storedToken) {
    try {
      await loadUserProfile(storedToken, 'stored');
      return 'authenticated';
    } catch (error) {
      if (httpStatus(error) !== 401) throw error;
    }

    const latestToken = await getAccessToken();
    if (latestToken && latestToken !== storedToken) {
      await loadUserProfile(latestToken, 'latest');
      return 'authenticated';
    }
  }

  const refreshedToken = await refreshForStartup(refreshAccessToken);
  if (!refreshedToken) return 'anonymous';

  await loadUserProfile(refreshedToken, 'refreshed');
  return 'authenticated';
}
