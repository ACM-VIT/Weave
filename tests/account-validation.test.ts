import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import { formatDateOfBirth, isValidDateOfBirth } from "../src/utils/date-of-birth";
import { isValidUsername, normalizeUsername } from "../src/utils/username";
import { oauthErrorMessage } from "../src/utils/oauth-errors";

describe("date of birth", () => {
  const TODAY = new Date(2026, 6, 22, 12, 0, 0);

  test('signup date of birth formatting and validation use calendar dates', () => {
    assert.equal(formatDateOfBirth(new Date(2000, 1, 29)), '2000-02-29');
    assert.equal(isValidDateOfBirth('2000-02-29', TODAY), true);
    assert.equal(isValidDateOfBirth('2001-02-29', TODAY), false);
    assert.equal(isValidDateOfBirth('2026-07-23', TODAY), false);
  });
});

describe("username", () => {
  test('username rule matches the production signup and profile contract', () => {
    assert.equal(isValidUsername('weave_user-2'), true);
    assert.equal(normalizeUsername('  weave_user-2  '), 'weave_user-2');
    assert.equal(isValidUsername('has spaces'), false);
    assert.equal(isValidUsername('contains.dot'), false);
    assert.equal(isValidUsername(''), false);
    assert.equal(isValidUsername('a'.repeat(51)), false);
  });
});

describe("oauth error message", () => {
  test('OAuth callback errors are safe and actionable for users', () => {
    assert.match(oauthErrorMessage('github_persona_sync_failed'), /not activated/i);
    assert.match(oauthErrorMessage('invalid_or_expired_oauth_state'), /expired/i);
    assert.match(oauthErrorMessage('oauth_account_not_found'), /sign up first/i);
    assert.equal(oauthErrorMessage('unexpected_internal_detail'), 'OAuth sign-in failed. Please try again.');
  });
});
