export type TokenResponse<TResponse> = {
  response: TResponse;
  token: string | null;
};

type UnauthorizedRetryDependencies<TResponse extends { status: number }> = {
  result: TokenResponse<TResponse>;
  allowRefresh: boolean;
  getAccessToken: () => Promise<string | null>;
  refreshAccessToken: () => Promise<string>;
  retry: (token: string) => Promise<TokenResponse<TResponse>>;
};

export async function retryUnauthorizedResponse<TResponse extends { status: number }>({
  result,
  allowRefresh,
  getAccessToken,
  refreshAccessToken,
  retry,
}: UnauthorizedRetryDependencies<TResponse>): Promise<TokenResponse<TResponse>> {
  if (result.response.status !== 401 || !allowRefresh) return result;

  const attemptedToken = result.token ?? await getAccessToken();
  if (!attemptedToken) return result;

  // Another request may already have rotated the session while this 401 was
  // in flight. Reuse its token instead of rotating the refresh cookie again.
  const latestToken = await getAccessToken();
  if (latestToken && latestToken !== attemptedToken) return retry(latestToken);

  return retry(await refreshAccessToken());
}
