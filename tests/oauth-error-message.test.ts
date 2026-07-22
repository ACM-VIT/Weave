import assert from 'node:assert/strict';
import test from 'node:test';

import { oauthErrorMessage } from '../src/utils/oauth-errors';

test('OAuth callback errors are safe and actionable for users', () => {
  assert.match(oauthErrorMessage('github_persona_sync_failed'), /not activated/i);
  assert.match(oauthErrorMessage('invalid_or_expired_oauth_state'), /expired/i);
  assert.match(oauthErrorMessage('oauth_account_not_found'), /sign up first/i);
  assert.equal(oauthErrorMessage('unexpected_internal_detail'), 'OAuth sign-in failed. Please try again.');
});
