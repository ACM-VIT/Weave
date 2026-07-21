import assert from 'node:assert/strict';
import test from 'node:test';

import { githubIdentityFromAuthUser } from '../../services/identityService.js';

test('linked GitHub identity is extracted instead of first-provider user metadata', () => {
  const identity = githubIdentityFromAuthUser({
    identities: [
      { provider: 'google', id: 'google-subject', identity_data: { user_name: 'google-user' } },
      {
        provider: 'github',
        id: '1234567',
        identity_data: { provider_id: '1234567', preferred_username: 'octo-user' },
      },
    ],
  });
  assert.deepEqual(identity, { githubId: '1234567', githubHandle: 'octo-user' });
});

test('Google-only and malformed GitHub identities cannot populate GitHub columns', () => {
  assert.deepEqual(githubIdentityFromAuthUser({
    identities: [{ provider: 'google', id: '123', identity_data: { user_name: 'google-user' } }],
  }), { githubId: null, githubHandle: null });
  assert.deepEqual(githubIdentityFromAuthUser({
    identities: [{ provider: 'github', id: 'not-numeric', identity_data: { user_name: 'invalid_' } }],
  }), { githubId: null, githubHandle: null });
});
