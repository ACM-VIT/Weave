import assert from 'node:assert/strict';
import test from 'node:test';

import {
  accessTokenOwner,
  selectCurrentSessionToken,
  tokensHaveSameOwner,
} from '../src/api/access-token-owner';

function tokenFor(owner: string, marker: string): string {
  const payload = Buffer.from(JSON.stringify({ userId: owner, marker })).toString('base64url');
  return `header.${payload}.signature`;
}

test('access token ownership reads the backend userId claim and fails closed', () => {
  assert.equal(accessTokenOwner(tokenFor('user-a', 'one')), 'user-a');
  assert.equal(accessTokenOwner('not-a-jwt'), null);
  assert.equal(accessTokenOwner('header.invalid!.signature'), null);
});

test('a rotated token is accepted only for the same authenticated account', () => {
  const oldToken = tokenFor('user-a', 'old');
  const rotatedToken = tokenFor('user-a', 'rotated');
  const otherAccountToken = tokenFor('user-b', 'login');

  assert.equal(tokensHaveSameOwner(oldToken, rotatedToken), true);
  assert.equal(tokensHaveSameOwner(oldToken, otherAccountToken), false);
  assert.equal(selectCurrentSessionToken(oldToken, rotatedToken), rotatedToken);
  assert.equal(selectCurrentSessionToken(oldToken, otherAccountToken), null);
  assert.equal(selectCurrentSessionToken(oldToken, null), null);
  assert.equal(selectCurrentSessionToken('opaque', 'opaque'), 'opaque');
});
