import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeSavedUserProfile } from '../src/utils/profile-state';

test('a saved profile replaces editable attributes without losing authenticated user state', () => {
  const current = {
    user_id: 'user-1',
    username: 'old-name',
    full_name: 'Old Name',
    bio: 'Old bio',
    followers_count: 4,
    onboarding_completed: true,
  };

  assert.deepEqual(
    mergeSavedUserProfile(current, {
      username: 'new-name',
      full_name: 'New Name',
      bio: 'New bio',
    }),
    {
      user_id: 'user-1',
      username: 'new-name',
      full_name: 'New Name',
      bio: 'New bio',
      followers_count: 4,
      onboarding_completed: true,
    },
  );
});

test('a late profile response cannot recreate a signed-out user', () => {
  assert.equal(
    mergeSavedUserProfile(null, {
      username: 'new-name',
      full_name: 'New Name',
      bio: 'New bio',
    }),
    null,
  );
});
