export type OAuthProvider = 'github' | 'google';
export type OAuthIntent = 'login' | 'signup';

export function oauthLoginNeedsSignup(
  authIntent: OAuthIntent,
  productProfileExists: boolean,
): boolean {
  return authIntent === 'login' && !productProfileExists;
}

export function requiresGitHubPersona(
  provider: OAuthProvider,
  existingOnboardingCompleted: boolean | null | undefined,
): boolean {
  return provider === 'github' && existingOnboardingCompleted !== true;
}

export function initialOAuthOnboardingCompleted(
  authIntent: OAuthIntent,
  githubPersonaRequired: boolean,
): boolean {
  return authIntent === 'login' && !githubPersonaRequired;
}
