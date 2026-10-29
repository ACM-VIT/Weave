import type { Href } from 'expo-router';

export const REPOSITORY_ROUTE_PATHNAME = '/repository/[repoId]' as const;
export const WEAVE_NATIVE_SCHEME = 'ghsocial';

export type RepositoryRouteHref = Href & {
  pathname: typeof REPOSITORY_ROUTE_PATHNAME;
  params: { repoId: string; feedNavigation?:string };
};

export type RepositoryShareContent = {
  title: string;
  message: string;
  url: string;
};

/** Only repository destinations on the HTTPS GitHub origin are external actions. */
export function normalizeGitHubRepositoryUrl(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.hostname !== 'github.com'
      || url.port || url.username || url.password) return null;
    const [owner, repository] = url.pathname.split('/').slice(1);
    if (!/^[a-z\d-]+$/i.test(owner ?? '') || !/^[a-z\d_.-]+$/i.test(repository ?? '')) return null;
    return url.href;
  } catch {
    return null;
  }
}

function repositoryId(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('Repository ID is required.');
  return normalized;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '[::1]';
}

/**
 * EXPO_PUBLIC_WEB_URL is an origin, not a path prefix. Invalid, insecure, and
 * documented placeholder values are deliberately treated as unconfigured.
 */
export function normalizePublicWebUrl(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;

  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    const isAllowedProtocol = url.protocol === 'https:'
      || (url.protocol === 'http:' && isLoopbackHostname(hostname));
    const normalizedPath = url.pathname.replace(/\/+$/, '');

    if (!isAllowedProtocol
      || !hostname
      || hostname.endsWith('.example')
      || url.username
      || url.password
      || normalizedPath
      || url.search
      || url.hash) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

export function repositoryPath(repoId: string): `/repository/${string}` {
  return `/repository/${encodeURIComponent(repositoryId(repoId))}`;
}

export function repositoryHref(repoId: string,navigationToken?:string): RepositoryRouteHref {
  return {
    pathname: REPOSITORY_ROUTE_PATHNAME,
    params: { repoId: repositoryId(repoId),...(navigationToken?{feedNavigation:navigationToken}:{}) },
  } as RepositoryRouteHref;
}

export function buildRepositoryWebUrl(
  repoId: string,
  webBaseUrl: string | null | undefined,
): string | null {
  const origin = normalizePublicWebUrl(webBaseUrl);
  return origin ? `${origin}${repositoryPath(repoId)}` : null;
}

function decodeRepositorySegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded && !decoded.includes('/') ? decoded : null;
  } catch {
    return null;
  }
}

function repositoryIdFromPath(pathname: string): string | null {
  const withoutExpoPrefix = pathname.startsWith('/--/')
    ? pathname.slice(3)
    : pathname;
  const match = withoutExpoPrefix.match(/^\/repository\/([^/]+)\/?$/);
  return match ? decodeRepositorySegment(match[1]) : null;
}

/**
 * Parses only canonical Weave repository routes. HTTPS links are accepted only
 * for the configured public origin; arbitrary web URLs never become app routes.
 */
export function parseRepositoryIdFromLink(
  value: string,
  webBaseUrl?: string | null,
): string | null {
  const candidate = value.trim();
  if (!candidate) return null;

  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(candidate);
  if (!hasScheme) {
    try {
      return repositoryIdFromPath(new URL(candidate, 'https://weave.invalid').pathname);
    } catch {
      return null;
    }
  }

  try {
    const url = new URL(candidate);
    if (url.protocol === `${WEAVE_NATIVE_SCHEME}:`) {
      if (url.hostname && url.hostname !== 'repository') return null;
      const pathname = url.hostname === 'repository'
        ? `/repository${url.pathname}`
        : url.pathname;
      return repositoryIdFromPath(pathname);
    }

    if (url.protocol === 'exp:') {
      return repositoryIdFromPath(url.pathname);
    }

    if (url.protocol === 'https:' || url.protocol === 'http:') {
      const configuredOrigin = normalizePublicWebUrl(webBaseUrl);
      if (!configuredOrigin || url.origin !== configuredOrigin) return null;
      return repositoryIdFromPath(url.pathname);
    }

    return null;
  } catch {
    return null;
  }
}

export function repositoryHrefFromLink(
  value: string,
  webBaseUrl?: string | null,
): RepositoryRouteHref | null {
  const repoId = parseRepositoryIdFromLink(value, webBaseUrl);
  return repoId ? repositoryHref(repoId) : null;
}

export function resolveRepositoryShareUrl({
  repoId,
  webBaseUrl,
  nativeUrl,
}: {
  repoId: string;
  webBaseUrl?: string | null;
  nativeUrl: string;
}): string {
  const webUrl = buildRepositoryWebUrl(repoId, webBaseUrl);
  if (webUrl) return webUrl;

  const normalizedId = repositoryId(repoId);
  if (parseRepositoryIdFromLink(nativeUrl) !== normalizedId) {
    throw new Error('A valid native Weave repository link is required.');
  }
  return nativeUrl;
}

export function buildRepositoryShareContent(
  fullName: string | null | undefined,
  weaveUrl: string,
): RepositoryShareContent {
  const repositoryName = fullName?.trim() || 'this repository';
  return {
    title: `${repositoryName} on Weave`,
    message: `View ${repositoryName} on Weave:\n${weaveUrl}`,
    url: weaveUrl,
  };
}
