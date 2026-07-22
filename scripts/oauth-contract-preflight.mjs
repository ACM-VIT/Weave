import { createHash, randomBytes } from 'node:crypto';

const OAUTH_CONTINUATION_PATH = '/api/auth/oauth/continue';
const OAUTH_ATTEMPT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROVIDERS = ['github', 'google'];

export function createSyntheticCodeChallenge() {
  const verifier = randomBytes(32).toString('base64url');
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function validateOAuthContinuationUrl(value, backendUrl, provider) {
  let backend;
  let continuation;
  try {
    backend = new URL(backendUrl);
    continuation = new URL(typeof value === 'string' ? value : '');
  } catch {
    throw new Error(`${provider} OAuth preflight returned an invalid authorization URL.`);
  }

  const attempt = continuation.searchParams.get('oauth_attempt');
  if (
    continuation.origin !== backend.origin
    || continuation.pathname !== OAUTH_CONTINUATION_PATH
    || continuation.username
    || continuation.password
    || !attempt
    || !OAUTH_ATTEMPT_PATTERN.test(attempt)
  ) {
    throw new Error(
      `${provider} OAuth preflight expected the deployed backend continuation contract, `
      + `but received ${continuation.origin}${continuation.pathname}.`,
    );
  }

  return continuation.toString();
}

export async function preflightOAuthContract(
  backendUrl,
  {
    fetchImpl = globalThis.fetch,
    challengeFactory = createSyntheticCodeChallenge,
    timeoutMs = 10_000,
  } = {},
) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('This Node.js runtime does not provide fetch for the OAuth preflight.');
  }

  return Promise.all(PROVIDERS.map(async (provider) => {
    const requestUrl = new URL(`${backendUrl}/auth/oauth/${provider}`);
    requestUrl.searchParams.set('redirect_uri', 'ghsocial://callback');
    requestUrl.searchParams.set('code_challenge', challengeFactory());
    requestUrl.searchParams.set('auth_intent', 'login');

    let response;
    try {
      response = await fetchImpl(requestUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${provider} OAuth preflight could not reach ${requestUrl.origin}: ${detail}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`${provider} OAuth preflight received a non-JSON HTTP ${response.status} response.`);
    }

    if (!response.ok) {
      throw new Error(`${provider} OAuth preflight failed with HTTP ${response.status}.`);
    }
    if (payload?.success !== true) {
      throw new Error(`${provider} OAuth preflight received an unsuccessful contract response.`);
    }

    return validateOAuthContinuationUrl(payload?.data?.url, backendUrl, provider);
  }));
}
