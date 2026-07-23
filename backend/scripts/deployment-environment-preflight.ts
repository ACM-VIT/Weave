import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requiredVariables = [
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'JWT_SECRET',
  'CLIENT_URL',
  'BACKEND_URL',
  'OAUTH_REDIRECT_ORIGINS',
  'REDIS_URL',
  'GITHUB_TOKEN',
  'ML_SERVICE_URL',
  'INTERNAL_API_SECRET',
  'DB_SCHEMA_V2_READS',
  'DB_SCHEMA_V2_WRITES',
  'FEED_V2',
  'FEED_RESERVATIONS',
  'FEED_V2_CANARY_PERCENT',
  'ML_V2_RECOMMENDATIONS',
  'ML_FEEDBACK_OUTBOX',
  'ML_QDRANT_ONLY',
  'TRENDING_FALLBACK',
] as const;

type DeploymentEnvironment = Readonly<Record<string, string | undefined>>;

function value(env: DeploymentEnvironment, name: string): string {
  return env[name]?.trim() ?? '';
}

function isPrivateIpv4(hostname: string): boolean {
  const [first, second] = hostname.split('.').map(Number);
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

export function isPrivateDeploymentHostname(rawHostname: string): boolean {
  const hostname = rawHostname.trim().toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!hostname) return true;
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.home.arpa')
  ) return true;

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) return isPrivateIpv4(hostname);
  if (ipVersion === 6) {
    if (hostname === '::' || hostname === '::1') return true;
    if (/^f[cd]/.test(hostname) || /^fe[89ab]/.test(hostname) || hostname.startsWith('::ffff:')) {
      return true;
    }
    return false;
  }

  return !hostname.includes('.');
}

function publicHttpsUrl(rawValue: string, name: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || isPrivateDeploymentHostname(parsed.hostname)
  ) {
    throw new Error(`${name} must use HTTPS with a public hostname and no credentials.`);
  }
  return parsed;
}

export function validateDeploymentEnvironment(env: DeploymentEnvironment = process.env): void {
  if (env.NODE_ENV !== 'production') {
    throw new Error('Deployment requires NODE_ENV=production.');
  }

  const missing = requiredVariables.filter((name) => !value(env, name));
  if (missing.length > 0) {
    throw new Error(`Missing required production variables: ${missing.join(', ')}.`);
  }

  const forbiddenFlags = [
    'ADOPT_LEGACY_SCHEMA',
    'BOOTSTRAP_SUPABASE_AUTH_STUB',
    'ALLOW_REMOTE_DATABASE_RESET',
    'RESET_V2_DATABASE',
  ] as const;
  const disabledFlagValues = new Set(['', '0', 'false', 'no']);
  const enabledForbiddenFlags = forbiddenFlags.filter(
    (name) => !disabledFlagValues.has(value(env, name).toLowerCase()),
  );
  if (enabledForbiddenFlags.length > 0) {
    throw new Error(
      `Unsafe one-time database flags are forbidden in automated deployment: ${enabledForbiddenFlags.join(', ')}.`,
    );
  }

  const requiredV2Flags = [
    'DB_SCHEMA_V2_READS',
    'DB_SCHEMA_V2_WRITES',
    'FEED_V2',
    'FEED_RESERVATIONS',
    'ML_V2_RECOMMENDATIONS',
    'ML_FEEDBACK_OUTBOX',
    'ML_QDRANT_ONLY',
  ] as const;
  const enabledFlagValues = new Set(['1', 'true', 'yes', 'on']);
  const disabledV2Flags = requiredV2Flags.filter(
    (name) => !enabledFlagValues.has(value(env, name).toLowerCase()),
  );
  if (disabledV2Flags.length > 0) {
    throw new Error(
      `Strict V2 deployment requires these flags to be enabled: ${disabledV2Flags.join(', ')}.`,
    );
  }
  if (Number(value(env, 'FEED_V2_CANARY_PERCENT')) !== 100) {
    throw new Error('Strict V2 deployment requires FEED_V2_CANARY_PERCENT=100.');
  }
  if (!disabledFlagValues.has(value(env, 'TRENDING_FALLBACK').toLowerCase())) {
    throw new Error(
      'Strict V2 deployment requires TRENDING_FALLBACK=false so ML failures fail closed.',
    );
  }

  if (value(env, 'WORKER_ROLE')) {
    throw new Error('WORKER_ROLE must be blank in the shared production environment file.');
  }

  const backendUrl = publicHttpsUrl(value(env, 'BACKEND_URL'), 'BACKEND_URL');
  if (backendUrl.pathname !== '/' || backendUrl.search || backendUrl.hash) {
    throw new Error('BACKEND_URL must be a public HTTPS origin without a path, query, or fragment.');
  }

  if (value(env, 'CLIENT_URL') !== 'ghsocial://callback') {
    throw new Error('CLIENT_URL must be the production mobile callback ghsocial://callback.');
  }

  const allowedOAuthRedirects = value(env, 'OAUTH_REDIRECT_ORIGINS')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!allowedOAuthRedirects.includes('ghsocial://callback')) {
    throw new Error('OAUTH_REDIRECT_ORIGINS must include ghsocial://callback.');
  }
  for (const redirect of allowedOAuthRedirects) {
    if (redirect === 'ghsocial://callback') continue;
    const redirectUrl = publicHttpsUrl(redirect, 'OAUTH_REDIRECT_ORIGINS entries');
    if (redirectUrl.search || redirectUrl.hash) {
      throw new Error('OAUTH_REDIRECT_ORIGINS entries cannot contain a query or fragment.');
    }
  }

  if (value(env, 'JWT_SECRET').length < 64) {
    throw new Error('JWT_SECRET must contain at least 64 characters.');
  }
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  validateDeploymentEnvironment();
  console.log('Production deployment environment preflight passed.');
}
