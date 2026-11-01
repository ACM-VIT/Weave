/** Repository reads must never carry credentials capable of private access. */
export async function assertPublicGitHubCredential(
  token: string,
  fetcher: typeof fetch = fetch,
  signal: AbortSignal = AbortSignal.timeout(8_000),
): Promise<void> {
  const denied = () => new Error('GitHub repository acquisition requires a verified public-only credential.');
  if (!/^gh[po]_/.test(token)) throw denied();
  // This endpoint returns quota information, not repository metadata. The
  // provider's granted-scope header is authoritative; unknown token types fail closed.
  const response = await fetcher('https://api.github.com/rate_limit', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error', signal,
  });
  await response.body?.cancel();
  const scopes = response.headers.get('x-oauth-scopes');
  const allowed = new Set(['public_repo', 'read:user', 'user:email']);
  if (!response.ok || scopes === null || scopes.split(',').map(scope => scope.trim()).filter(Boolean).some(scope => !allowed.has(scope))) throw denied();
  signal.throwIfAborted();
}
