import assert from 'node:assert/strict';
import test from 'node:test';

import {
  followStateQueryKey,
  getFollowIdentity,
  getProfileFollowIdentity,
} from '../src/utils/follow-state';

test('follow state prefers the stable user id across screens', () => {
  const identity = getFollowIdentity(' user-123 ', 'DifferentUsername');

  assert.equal(identity, 'user-123');
  assert.deepEqual(followStateQueryKey(identity), ['user-follow-state', 'user-123']);
});

test('follow state normalizes username fallbacks when no user id is available', () => {
  assert.equal(getFollowIdentity(null, ' Navyaa '), 'navyaa');
  assert.equal(getFollowIdentity(undefined, '@Navyaa'), '@navyaa');
});

test('external profile follow state is namespaced separately from app users', () => {
  assert.equal(
    getProfileFollowIdentity(' profile-123 ', 'user-123', 'owner'),
    'profile:profile-123',
  );
  assert.equal(
    getProfileFollowIdentity(null, ' user-123 ', 'owner'),
    'user-123',
  );
});
