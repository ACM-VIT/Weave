import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pendingProtectedRepositoryRoute,
  postAuthenticationRoute,
  resolveOnboardingCompleted,
} from '../src/utils/auth-routing';

test('routing trusts the backend completion flag and fails closed otherwise', () => {
  assert.equal(resolveOnboardingCompleted({ onboarding_completed: true }), true);
  assert.equal(resolveOnboardingCompleted({ onboarding_completed: false }), false);
  assert.equal(resolveOnboardingCompleted({ github_id: '123', topics: ['react'] }), false);
  assert.equal(resolveOnboardingCompleted({ onboarding_completed: 'true' }), false);
  assert.equal(resolveOnboardingCompleted({ topics: ['react'] }, true), true);
  assert.equal(resolveOnboardingCompleted({ onboarding_completed: false }, true), false);
});

test('only a canonical repository route is retained across authentication', () => {
  assert.deepEqual(pendingProtectedRepositoryRoute('/repository/7be6d88f'), {
    pathname: '/repository/[repoId]',
    params: { repoId: '7be6d88f' },
  });
  assert.deepEqual(pendingProtectedRepositoryRoute('/repository/repo%20id'), {
    pathname: '/repository/[repoId]',
    params: { repoId: 'repo id' },
  });
  assert.equal(pendingProtectedRepositoryRoute('/home'), null);
  assert.equal(pendingProtectedRepositoryRoute('/repository'), null);
  assert.equal(pendingProtectedRepositoryRoute('/repository/owner%2Frepo'), null);
  assert.equal(pendingProtectedRepositoryRoute('/repository/%E0%A4%A'), null);
  assert.equal(
    pendingProtectedRepositoryRoute('/repository/%5BrepoId%5D'),
    null,
    'a useSegments file placeholder is never retained as a concrete route',
  );
});

test('post-auth routing returns to a retained repository and otherwise uses home', () => {
  const repositoryRoute = pendingProtectedRepositoryRoute('/repository/7be6d88f');
  assert.deepEqual(postAuthenticationRoute(repositoryRoute), {
    pathname: '/repository/[repoId]',
    params: { repoId: '7be6d88f' },
  });
  assert.equal(postAuthenticationRoute(null), '/(tabs)/home');
});
