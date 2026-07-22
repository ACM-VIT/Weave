import assert from 'node:assert/strict';
import test from 'node:test';

import { restoreStartupSession } from '../src/store/restore-session';

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

test('startup keeps a valid stored access token without refreshing', async () => {
  const calls: string[] = [];

  const state = await restoreStartupSession({
    getAccessToken: async () => {
      calls.push('get:stored');
      return 'valid-token';
    },
    refreshAccessToken: async () => {
      calls.push('refresh');
      return 'unexpected-token';
    },
    loadUserProfile: async (token, attempt) => {
      calls.push(`profile:${attempt}:${token}`);
    },
  });

  assert.equal(state, 'authenticated');
  assert.deepEqual(calls, ['get:stored', 'profile:stored:valid-token']);
});

test('startup refreshes an expired stored token and retries the profile once', async () => {
  const calls: string[] = [];

  const state = await restoreStartupSession({
    getAccessToken: async () => {
      calls.push('get:stored');
      return 'expired-token';
    },
    refreshAccessToken: async () => {
      calls.push('refresh');
      return 'fresh-token';
    },
    loadUserProfile: async (token, attempt) => {
      calls.push(`profile:${attempt}:${token}`);
      if (token === 'expired-token') throw httpError(401);
    },
  });

  assert.equal(state, 'authenticated');
  assert.deepEqual(calls, [
    'get:stored',
    'profile:stored:expired-token',
    'get:stored',
    'refresh',
    'profile:refreshed:fresh-token',
  ]);
});

test('startup reuses a concurrently refreshed token instead of rotating again', async () => {
  const calls: string[] = [];
  const storedTokens = ['expired-token', 'concurrent-fresh-token'];

  const state = await restoreStartupSession({
    getAccessToken: async () => {
      const token = storedTokens.shift() ?? 'concurrent-fresh-token';
      calls.push(`get:${token}`);
      return token;
    },
    refreshAccessToken: async () => {
      calls.push('refresh');
      return 'unexpected-token';
    },
    loadUserProfile: async (token, attempt) => {
      calls.push(`profile:${attempt}:${token}`);
      if (attempt === 'stored') throw httpError(401);
    },
  });

  assert.equal(state, 'authenticated');
  assert.deepEqual(calls, [
    'get:expired-token',
    'profile:stored:expired-token',
    'get:concurrent-fresh-token',
    'profile:latest:concurrent-fresh-token',
  ]);
});

test('startup never starts a second refresh when the refreshed token is rejected', async () => {
  const calls: string[] = [];

  await assert.rejects(
    restoreStartupSession({
      getAccessToken: async () => 'expired-token',
      refreshAccessToken: async () => {
        calls.push('refresh');
        return 'rejected-fresh-token';
      },
      loadUserProfile: async (token, attempt) => {
        calls.push(`profile:${attempt}:${token}`);
        throw httpError(401);
      },
    }),
    (error: unknown) => (error as { status?: number }).status === 401,
  );

  assert.deepEqual(calls, [
    'profile:stored:expired-token',
    'refresh',
    'profile:refreshed:rejected-fresh-token',
  ]);
});

test('startup becomes anonymous when an expired token cannot be refreshed', async () => {
  const calls: string[] = [];

  const state = await restoreStartupSession({
    getAccessToken: async () => 'expired-token',
    refreshAccessToken: async () => {
      calls.push('refresh');
      throw httpError(401);
    },
    loadUserProfile: async (token, attempt) => {
      calls.push(`profile:${attempt}:${token}`);
      throw httpError(401);
    },
  });

  assert.equal(state, 'anonymous');
  assert.deepEqual(calls, ['profile:stored:expired-token', 'refresh']);
});

test('startup restores a cookie-backed session when no access token is stored', async () => {
  const calls: string[] = [];

  const state = await restoreStartupSession({
    getAccessToken: async () => null,
    refreshAccessToken: async () => {
      calls.push('refresh');
      return 'fresh-token';
    },
    loadUserProfile: async (token, attempt) => {
      calls.push(`profile:${attempt}:${token}`);
    },
  });

  assert.equal(state, 'authenticated');
  assert.deepEqual(calls, ['refresh', 'profile:refreshed:fresh-token']);
});

test('startup preserves a retryable session when refresh has a transient failure', async () => {
  await assert.rejects(
    restoreStartupSession({
      getAccessToken: async () => 'expired-token',
      refreshAccessToken: async () => {
        throw httpError(503);
      },
      loadUserProfile: async () => {
        throw httpError(401);
      },
    }),
    (error: unknown) => (error as { status?: number }).status === 503,
  );
});

test('startup does not refresh for non-authentication profile failures', async () => {
  let refreshCalls = 0;

  await assert.rejects(
    restoreStartupSession({
      getAccessToken: async () => 'valid-token',
      refreshAccessToken: async () => {
        refreshCalls += 1;
        return 'fresh-token';
      },
      loadUserProfile: async () => {
        throw httpError(503);
      },
    }),
    (error: unknown) => (error as { status?: number }).status === 503,
  );

  assert.equal(refreshCalls, 0);
});

test('startup does not refresh a valid legacy session whose product profile is missing', async () => {
  let refreshCalls = 0;

  await assert.rejects(
    restoreStartupSession({
      getAccessToken: async () => 'legacy-token',
      refreshAccessToken: async () => {
        refreshCalls += 1;
        return 'fresh-token';
      },
      loadUserProfile: async () => {
        throw httpError(404);
      },
    }),
    (error: unknown) => (error as { status?: number }).status === 404,
  );

  assert.equal(refreshCalls, 0);
});
