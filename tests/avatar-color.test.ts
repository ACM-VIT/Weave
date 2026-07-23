import assert from 'node:assert/strict';
import test from 'node:test';

import { getAvatarColor } from '../src/utils/avatar-color';

test('avatar colors stay stable for the same user identifier', () => {
  assert.equal(getAvatarColor('user-123'), getAvatarColor('user-123'));
  assert.equal(getAvatarColor(' Navyaa '), getAvatarColor('navyaa'));
});

test('avatar colors distribute common user identifiers across the palette', () => {
  const identifiers = ['alice', 'bob', 'charlie', 'diana', 'evan', 'fatima'];
  const colors = new Set(identifiers.map(getAvatarColor));

  assert.ok(colors.size >= 4);
});
