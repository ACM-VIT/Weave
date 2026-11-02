export class GitHubPublicAccessError extends Error {
  constructor(readonly code: 'rate_limited' | 'provider_unavailable' | 'public_only_credential_required', readonly retryAfterSeconds?: number) {
    super(code === 'public_only_credential_required'
      ? 'GitHub repository acquisition requires a verified public-only credential.'
      : 'GitHub public-only credential verification is temporarily unavailable.');
    this.name = 'GitHubPublicAccessError';
  }
}

/** Repository reads must never carry credentials capable of private access. */
export async function assertPublicGitHubCredential(
  token: string,
  fetcher: typeof fetch = fetch,
  signal: AbortSignal = AbortSignal.timeout(8_000),
): Promise<void> {
  const denied = () => new GitHubPublicAccessError('public_only_credential_required');
  if (!/^gh[po]_/.test(token)) throw denied();
  // This endpoint returns quota information, not repository metadata. The
  // provider's granted-scope header is authoritative; unknown token types fail closed.
  let response: Response;
  try {
    response = await fetcher('https://api.github.com/rate_limit', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'error', signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new GitHubPublicAccessError('provider_unavailable');
  }
  await response.body?.cancel();
  if (!response.ok) {
    const retry = Number(response.headers.get('retry-after'));
    throw new GitHubPublicAccessError(response.status === 403 || response.status === 429 ? 'rate_limited' : 'provider_unavailable',
      Number.isFinite(retry) && retry > 0 ? Math.min(Math.ceil(retry), 3_600) : undefined);
  }
  const scopes = response.headers.get('x-oauth-scopes');
  const allowed = new Set(['public_repo', 'read:user', 'user:email']);
  if (scopes === null || scopes.split(',').map(scope => scope.trim()).filter(Boolean).some(scope => !allowed.has(scope))) throw denied();
  signal.throwIfAborted();
}
