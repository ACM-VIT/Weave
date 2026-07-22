import assert from 'node:assert/strict';
import test from 'node:test';

import { isValidUsername, normalizeUsername } from '../src/utils/username';

test('username rule matches the production signup and profile contract', () => {
  assert.equal(isValidUsername('weave_user-2'), true);
  assert.equal(normalizeUsername('  weave_user-2  '), 'weave_user-2');
  assert.equal(isValidUsername('has spaces'), false);
  assert.equal(isValidUsername('contains.dot'), false);
  assert.equal(isValidUsername(''), false);
  assert.equal(isValidUsername('a'.repeat(51)), false);
});
