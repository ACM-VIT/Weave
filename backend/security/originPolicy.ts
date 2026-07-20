function normalizedOrigin(value: string): string {
  return value.trim().replace(/\/$/, '');
}

function isPrivateDevelopmentHost(hostname: string): boolean {
  if (['localhost', '127.0.0.1', '10.0.2.2'].includes(hostname)) return true;
  if (hostname.startsWith('10.') || hostname.startsWith('192.168.')) return true;
  const match = hostname.match(/^172\.(\d{1,2})\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

export function isCorsOriginAllowed(
  origin: string | undefined,
  configuredOrigins: string[],
  nodeEnv: string | undefined,
): boolean {
  if (!origin) return true;
  const normalized = normalizedOrigin(origin);
  if (configuredOrigins.map(normalizedOrigin).includes(normalized)) return true;
  if (nodeEnv === 'production') return false;

  try {
    const url = new URL(normalized);
    return ['http:', 'https:'].includes(url.protocol) && isPrivateDevelopmentHost(url.hostname);
  } catch {
    return false;
  }
}

export function resolveClientRedirect(
  value: unknown,
  fallback: string,
  configuredRedirects: string[],
  nodeEnv: string | undefined,
): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;

  try {
    const redirect = new URL(value);
    if (redirect.username || redirect.password) return fallback;
    if (nodeEnv !== 'production' && redirect.protocol === 'exp:') return redirect.toString();

    const allowed = [fallback, ...configuredRedirects].some((configured) => {
      try {
        const candidate = new URL(configured.trim());
        const isWeb = candidate.protocol === 'http:' || candidate.protocol === 'https:';
        return isWeb
          ? redirect.protocol === candidate.protocol && redirect.origin === candidate.origin
          : redirect.protocol === candidate.protocol && redirect.host === candidate.host;
      } catch {
        return false;
      }
    });
    return allowed ? redirect.toString() : fallback;
  } catch {
    return fallback;
  }
}
