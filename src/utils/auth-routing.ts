import {
  repositoryHrefFromLink,
  type RepositoryRouteHref,
} from './repository-links';

export const AUTHENTICATED_HOME_ROUTE = '/(tabs)/home' as const;

export function resolveOnboardingCompleted(
  profile: Record<string, unknown>,
  statusFallback?: unknown,
): boolean {
  // The backend and migration guarantee this boolean. Missing or malformed
  // state must route to onboarding instead of guessing from partial profile
  // fields such as a provider ID or one selected topic.
  if (typeof profile.onboarding_completed === 'boolean') {
    return profile.onboarding_completed;
  }
  return statusFallback === true;
}

/**
 * Repository details require an authenticated session. Remember only this
 * canonical protected route while login/onboarding is shown; arbitrary incoming
 * URLs must never become post-auth navigation targets.
 */
export function pendingProtectedRepositoryRoute(
  pathname: string,
): RepositoryRouteHref | null {
  const route = repositoryHrefFromLink(pathname);
  const repoId = route?.params.repoId;
  return repoId && !repoId.includes('[') && !repoId.includes(']') ? route : null;
}

export function postAuthenticationRoute(
  pendingRoute: RepositoryRouteHref | null,
): RepositoryRouteHref | typeof AUTHENTICATED_HOME_ROUTE {
  return pendingRoute ?? AUTHENTICATED_HOME_ROUTE;
}
