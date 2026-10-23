export type OAuthProvider = 'github' | 'google';
export type OAuthIntent = 'login' | 'signup';

export function oauthLoginNeedsSignup(
  authIntent: OAuthIntent,
  productProfileExists: boolean,
): boolean {
  return authIntent === 'login' && !productProfileExists;
}

export function loginOnboardingCompleted(
  existingOnboardingCompleted: boolean | null | undefined,
): boolean {
  // Authentication must never complete onboarding. The migration is the
  // authority that marks legacy accounts complete; a missing repair profile
  // therefore starts incomplete.
  return existingOnboardingCompleted === true;
}

export function initialOAuthOnboardingCompleted(
  authIntent: OAuthIntent,
  existingOnboardingCompleted: boolean | null | undefined,
): boolean {
  if (authIntent !== 'login') return false;
  return loginOnboardingCompleted(existingOnboardingCompleted);
}
