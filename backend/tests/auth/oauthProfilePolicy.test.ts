import assert from 'node:assert/strict';
import test from 'node:test';

import {
  initialOAuthOnboardingCompleted,
  loginOnboardingCompleted,
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

test('email login preserves incomplete and established onboarding state', () => {
  assert.equal(loginOnboardingCompleted(false), false);
  assert.equal(loginOnboardingCompleted(true), true);
  assert.equal(loginOnboardingCompleted(null), false);
  assert.equal(loginOnboardingCompleted(undefined), false);
});

test('Google OAuth login preserves incomplete and established onboarding state', () => {
  assert.equal(initialOAuthOnboardingCompleted('login', undefined, false), false);
  assert.equal(initialOAuthOnboardingCompleted('login', null, false), false);
  assert.equal(initialOAuthOnboardingCompleted('login', false, false), false);
  assert.equal(initialOAuthOnboardingCompleted('login', true, false), true);
});

test('OAuth signup and incomplete GitHub login remain incomplete until onboarding succeeds', () => {
  assert.equal(initialOAuthOnboardingCompleted('signup', undefined, false), false);
  assert.equal(initialOAuthOnboardingCompleted('signup', false, false), false);
  assert.equal(initialOAuthOnboardingCompleted('signup', true, false), false);
  assert.equal(initialOAuthOnboardingCompleted('login', false, true), false);
  assert.equal(initialOAuthOnboardingCompleted('login', true, false), true);
});
