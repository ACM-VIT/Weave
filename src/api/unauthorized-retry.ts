import { tokensHaveSameOwner } from './access-token-owner';

export type TokenResponse<TResponse> = {
  response: TResponse;
  token: string | null;
  generation: number;
};

type UnauthorizedRetryDependencies<TResponse extends { status: number }> = {
  result: TokenResponse<TResponse>;
  allowRefresh: boolean;
  getAccessToken: () => Promise<string | null>;
  refreshAccessToken: (attemptedToken: string) => Promise<string>;
  retry: (token: string) => Promise<TokenResponse<TResponse>>;
  assertSessionCurrent: (generation: number) => void;
};

export async function retryUnauthorizedResponse<TResponse extends { status: number }>({
  result,
  allowRefresh,
  getAccessToken,
  refreshAccessToken,
  retry,
  assertSessionCurrent,
}: UnauthorizedRetryDependencies<TResponse>): Promise<TokenResponse<TResponse>> {
  if (result.response.status !== 401 || !allowRefresh) return result;
  assertSessionCurrent(result.generation);

  const attemptedToken = result.token ?? await getAccessToken();
  assertSessionCurrent(result.generation);
  if (!attemptedToken) return result;

  // Another request may already have rotated the session while this 401 was
  // in flight. Reuse only a token owned by the same account; a newly logged-in
  // account must never receive a retry of the previous account's request.
  const latestToken = await getAccessToken();
  assertSessionCurrent(result.generation);
  if (latestToken && latestToken !== attemptedToken) {
    if (!tokensHaveSameOwner(attemptedToken, latestToken)) return result;
    const retried = await retry(latestToken);
    assertSessionCurrent(result.generation);
    return retried;
  }

  const refreshedToken = await refreshAccessToken(attemptedToken);
  assertSessionCurrent(result.generation);
  if (!tokensHaveSameOwner(attemptedToken, refreshedToken)) return result;
  const retried = await retry(refreshedToken);
  assertSessionCurrent(result.generation);
  return retried;
}
