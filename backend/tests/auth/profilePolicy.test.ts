import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import { isValidDateOfBirth } from "../../utils/dateOfBirth.js";
import { initialOAuthOnboardingCompleted, loginOnboardingCompleted, oauthLoginNeedsSignup } from "../../services/oauthProfilePolicy.js";
import { githubIdentityFenceMatches } from "../../services/githubIdentityFence.js";

describe("dateOfBirth", () => {
  const TODAY = new Date('2026-07-22T12:00:00.000Z');

  test('date of birth validation accepts a real non-future calendar date', () => {
    assert.equal(isValidDateOfBirth('2000-02-29', TODAY), true);
    assert.equal(isValidDateOfBirth('2026-07-22', TODAY), true);
  });

  test('date of birth validation rejects missing, impossible, future, and implausibly old values', () => {
    assert.equal(isValidDateOfBirth(undefined, TODAY), false);
    assert.equal(isValidDateOfBirth('2001-02-29', TODAY), false);
    assert.equal(isValidDateOfBirth('2026-07-23', TODAY), false);
    assert.equal(isValidDateOfBirth('1899-12-31', TODAY), false);
    assert.equal(isValidDateOfBirth('22-07-2000', TODAY), false);
  });
});

describe("oauthProfilePolicy", () => {
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
});

describe("githubIdentityFence", () => {
  test('provider observations are bound to the exact unlink generation and state', () => {
    const old = { operationId: 'first', status: 'done' };
    assert.equal(githubIdentityFenceMatches(undefined, null), true);
    assert.equal(githubIdentityFenceMatches(null, old), false, 'pre-unlink login cannot relink');
    assert.equal(githubIdentityFenceMatches(undefined, old), false, 'unfenced callers cannot relink');
    assert.equal(githubIdentityFenceMatches(old, old), true, 'fresh post-terminal observation may relink');
    assert.equal(githubIdentityFenceMatches(old, { ...old, status: 'superseded' }), false);
    assert.equal(githubIdentityFenceMatches(old, { ...old, operationId: 'second' }), false);
    assert.equal(githubIdentityFenceMatches({ ...old, status: 'prepared' }, { ...old, status: 'prepared' }), false);
  });

  test('fresh different credential can supersede the same target across cleanup status changes', () => {
    const target = '10000000-0000-4000-8000-000000000001';
    const newer = '10000000-0000-4000-8000-000000000003';
    const observed = { operationId: 'stable', status: 'prepared', providerIdentityId: target };
    for (const status of ['prepared', 'done', 'superseded']) {
      const current = { ...observed, status };
      assert.equal(githubIdentityFenceMatches(observed, current, newer), true);
      assert.equal(githubIdentityFenceMatches(observed, current, target), false);
      assert.equal(githubIdentityFenceMatches(observed, current, null), false);
      assert.equal(githubIdentityFenceMatches(observed, { ...current, operationId: 'new-op' }, newer), false);
    }
    assert.equal(githubIdentityFenceMatches({operationId:'legacy',status:'prepared'}, {operationId:'legacy',status:'prepared'}, newer), false);
  });
});
