const OAUTH_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  github_identity_incomplete: 'GitHub did not return a usable profile identity. Check the GitHub OAuth app permissions and try again.',
  github_persona_sync_failed: 'We could not import your GitHub profile right now. Your account was not activated; please try again.',
  invalid_or_expired_oauth_state: 'This sign-in attempt expired. Please start again.',
  oauth_exchange_failed: 'The provider sign-in could not be verified. Please try again.',
  oauth_account_not_found: 'No Weave account is linked to this provider yet. Sign up first so we can create your profile.',
  oauth_provider_error: 'The provider cancelled or rejected this sign-in attempt.',
  oauth_temporarily_unavailable: 'Sign-in is temporarily unavailable. Please try again shortly.',
};

export function oauthErrorMessage(errorCode: string): string {
  return OAUTH_ERROR_MESSAGES[errorCode]
    ?? 'OAuth sign-in failed. Please try again.';
}
