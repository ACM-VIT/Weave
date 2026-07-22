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
