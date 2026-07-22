const LOCAL_REDIS_URL = 'redis://127.0.0.1:6379';

function nonBlank(value: string | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function resolveRedisUrl(
  configuredUrl: string | undefined,
  nodeEnv: string | undefined,
): string {
  const value = nonBlank(configuredUrl);
  if (value) return value;
  if (nodeEnv === 'production') {
    throw new Error('Missing required production environment variable: REDIS_URL');
  }
  return LOCAL_REDIS_URL;
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
