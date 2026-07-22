import assert from 'node:assert/strict';
import test from 'node:test';

import {
  initialOAuthOnboardingCompleted,
  oauthLoginNeedsSignup,
  requiresGitHubPersona,
} from '../../services/oauthProfilePolicy.js';

test('OAuth login cannot silently create a product account without signup data', () => {
  assert.equal(oauthLoginNeedsSignup('login', false), true);
  assert.equal(oauthLoginNeedsSignup('login', true), false);
  assert.equal(oauthLoginNeedsSignup('signup', false), false);
});

test('new or incomplete GitHub identities require persona sync regardless of button used', () => {
  assert.equal(requiresGitHubPersona('github', undefined), true);
  assert.equal(requiresGitHubPersona('github', false), true);
  assert.equal(requiresGitHubPersona('github', true), false);
  assert.equal(requiresGitHubPersona('google', false), false);
});

test('login skips onboarding unless a first GitHub persona sync is still required', () => {
  assert.equal(initialOAuthOnboardingCompleted('login', false), true);
  assert.equal(initialOAuthOnboardingCompleted('login', true), false);
  assert.equal(initialOAuthOnboardingCompleted('signup', false), false);
  assert.equal(initialOAuthOnboardingCompleted('signup', true), false);
});
