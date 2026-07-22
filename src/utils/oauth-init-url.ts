const OAUTH_CONTINUATION_PATH = '/api/auth/oauth/continue';

export function validateOAuthInitiationUrl(value: unknown, apiUrl: string): string {
  let backend: URL;
  let authorization: URL;

  try {
    backend = new URL(apiUrl);
    authorization = new URL(typeof value === 'string' ? value : '');
  } catch {
    throw new Error('The deployed authentication service returned an incompatible authorization URL.');
  }

  if (
    authorization.origin !== backend.origin
    || authorization.pathname !== OAUTH_CONTINUATION_PATH
    || authorization.username
    || authorization.password
  ) {
    throw new Error('The deployed authentication service returned an incompatible authorization URL.');
  }

  return authorization.toString();
}
