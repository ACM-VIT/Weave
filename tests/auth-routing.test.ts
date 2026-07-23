import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveOnboardingCompleted } from '../src/utils/auth-routing';

test('routing trusts the backend completion flag and fails closed otherwise', () => {
  assert.equal(resolveOnboardingCompleted({ onboarding_completed: true }), true);
  assert.equal(resolveOnboardingCompleted({ onboarding_completed: false }), false);
  assert.equal(resolveOnboardingCompleted({ github_id: '123', topics: ['react'] }), false);
  assert.equal(resolveOnboardingCompleted({ onboarding_completed: 'true' }), false);
  assert.equal(resolveOnboardingCompleted({ topics: ['react'] }, true), true);
  assert.equal(resolveOnboardingCompleted({ onboarding_completed: false }, true), false);
});
