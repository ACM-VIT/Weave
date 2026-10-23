import assert from 'node:assert/strict';
import test from 'node:test';

import {
  initialOAuthOnboardingCompleted,
  loginOnboardingCompleted,
  oauthLoginNeedsSignup,
} from '../../services/oauthProfilePolicy.js';

test('OAuth login cannot silently create a product account without signup data', () => {
  assert.equal(oauthLoginNeedsSignup('login', false), true);
  assert.equal(oauthLoginNeedsSignup('login', true), false);
  assert.equal(oauthLoginNeedsSignup('signup', false), false);
});

test('email login preserves incomplete and established onboarding state', () => {
  assert.equal(loginOnboardingCompleted(false), false);
  assert.equal(loginOnboardingCompleted(true), true);
  assert.equal(loginOnboardingCompleted(null), false);
  assert.equal(loginOnboardingCompleted(undefined), false);
});

test('Google OAuth login preserves incomplete and established onboarding state', () => {
  assert.equal(initialOAuthOnboardingCompleted('login', undefined), false);
  assert.equal(initialOAuthOnboardingCompleted('login', null), false);
  assert.equal(initialOAuthOnboardingCompleted('login', false), false);
  assert.equal(initialOAuthOnboardingCompleted('login', true), true);
});

test('OAuth signup and incomplete GitHub login remain incomplete until onboarding succeeds', () => {
  assert.equal(initialOAuthOnboardingCompleted('signup', undefined), false);
  assert.equal(initialOAuthOnboardingCompleted('signup', false), false);
  assert.equal(initialOAuthOnboardingCompleted('signup', true), false);
  assert.equal(initialOAuthOnboardingCompleted('login', false), false);
  assert.equal(initialOAuthOnboardingCompleted('login', true), true);
});
