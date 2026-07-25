const LOCAL_REDIS_URL = 'redis://127.0.0.1:6379';
const REDIS_PLACEHOLDER = /(change-?me|example|placeholder|replace-?me|replace[_-]?with|your[_-])/i;

function nonBlank(value: string | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function decodedCredential(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function validateProductionRedisUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('REDIS_URL must be a valid absolute Redis URL in production.');
  }

  if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('REDIS_URL must use redis:// or rediss:// with a hostname in production.');
  }

  const username = decodedCredential(parsed.username);
  const password = decodedCredential(parsed.password);
  if (!username || !password) {
    throw new Error(
      'REDIS_URL must include a Redis ACL username and password in production.',
    );
  }
  if (password.length < 16 || REDIS_PLACEHOLDER.test(username) || REDIS_PLACEHOLDER.test(password)) {
    throw new Error(
      'REDIS_URL must contain non-placeholder ACL credentials and a password of at least 16 characters.',
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Error('REDIS_URL must not include query options or a fragment in production.');
  }
}

export function resolveRedisUrl(
  configuredUrl: string | undefined,
  nodeEnv: string | undefined,
): string {
  const value = nonBlank(configuredUrl);
  if (!value && nodeEnv === 'production') {
    throw new Error('Missing required production environment variable: REDIS_URL');
  }
  const resolved = value ?? LOCAL_REDIS_URL;
  if (nodeEnv === 'production') validateProductionRedisUrl(resolved);
  return resolved;
}

export function validateProductionIntegrations(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (env.NODE_ENV !== 'production') return;

  const missing = ['GITHUB_TOKEN']
    .filter((name) => !nonBlank(env[name]));
  if (missing.length > 0) {
    throw new Error(
      `Missing required production environment variable${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
    );
  }
}
