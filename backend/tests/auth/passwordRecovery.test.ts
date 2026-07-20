import assert from 'node:assert/strict';
import test from 'node:test';

import { updatePasswordFromRecoverySession } from '../../services/passwordRecoveryService.js';

const tokens = {
  access_token: 'recovery-access-token',
  refresh_token: 'recovery-refresh-token',
};

test('password recovery establishes the recovery session before updating', async () => {
  const calls: string[] = [];
  const auth = {
    async setSession(received: typeof tokens) {
      calls.push('set-session');
      assert.deepEqual(received, tokens);
      return { data: { session: { access_token: received.access_token } }, error: null };
    },
    async updateUser(attributes: { password: string }) {
      calls.push('update-user');
      assert.deepEqual(attributes, { password: 'a-secure-new-password' });
      return { error: null };
    },
  };

  const result = await updatePasswordFromRecoverySession(
    auth,
    tokens,
    'a-secure-new-password',
  );

  assert.equal(result, 'updated');
  assert.deepEqual(calls, ['set-session', 'update-user']);
});

test('password recovery never updates through an invalid session', async () => {
  let updateCalled = false;
  const auth = {
    async setSession() {
      return { data: { session: null }, error: new Error('expired') };
    },
    async updateUser() {
      updateCalled = true;
      return { error: null };
    },
  };

  const result = await updatePasswordFromRecoverySession(
    auth,
    tokens,
    'a-secure-new-password',
  );

  assert.equal(result, 'invalid-session');
  assert.equal(updateCalled, false);
});
