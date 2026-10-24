import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import { pendingProtectedRepositoryRoute, postAuthenticationRoute, resolveOnboardingCompleted } from "../src/utils/auth-routing";
import { validateOAuthInitiationUrl } from "../src/utils/oauth-init-url";

describe("auth routing", () => {
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
});

describe("oauth init url", () => {
  const API_URL = 'https://weave-backend.example/api';

  test('OAuth initiation accepts only the backend continuation endpoint', () => {
    const url = 'https://weave-backend.example/api/auth/oauth/continue?oauth_attempt=state';
    assert.equal(validateOAuthInitiationUrl(url, API_URL), url);
  });

  test('OAuth initiation rejects direct provider and lookalike-host URLs', () => {
    for (const url of [
      'https://project.supabase.co/auth/v1/authorize?provider=github',
      'https://weave-backend.example.attacker.test/api/auth/oauth/continue',
      'https://attacker.test@weave-backend.example/api/auth/oauth/continue',
    ]) {
      assert.throws(
        () => validateOAuthInitiationUrl(url, API_URL),
        /incompatible authorization URL/i,
      );
    }
  });

  test('OAuth initiation rejects sibling and almost-matching backend paths', () => {
    for (const url of [
      'https://weave-backend.example/api/auth/oauth/github',
      'https://weave-backend.example/api/auth/oauth/continue/',
      'https://weave-backend.example/api/auth/callback',
    ]) {
      assert.throws(
        () => validateOAuthInitiationUrl(url, API_URL),
        /incompatible authorization URL/i,
      );
    }
  });

  test('OAuth initiation rejects missing and malformed URLs', () => {
    for (const value of [undefined, null, '', 'not a URL']) {
      assert.throws(
        () => validateOAuthInitiationUrl(value, API_URL),
        /incompatible authorization URL/i,
      );
    }
  });
});
