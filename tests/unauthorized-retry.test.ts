import assert from 'node:assert/strict';
import test from 'node:test';

import { isTerminalRefreshError } from '../src/api/session-errors';
import {
  retryUnauthorizedResponse,
  type TokenResponse,
} from '../src/api/unauthorized-retry';

type TestResponse = { status: number };

function result(
  status: number,
  token: string | null,
  generation = 7,
): TokenResponse<TestResponse> {
  return { response: { status }, token, generation };
}

function tokenFor(owner: string, marker: string): string {
  const payload = Buffer.from(JSON.stringify({ userId: owner, marker })).toString('base64url');
  return `header.${payload}.signature`;
}

test('an explicitly non-refreshing request returns its 401 unchanged', async () => {
  const initial = result(401, 'expired-token');
  let dependencyCalls = 0;

  const received = await retryUnauthorizedResponse({
    result: initial,
    allowRefresh: false,
    getAccessToken: async () => {
      dependencyCalls += 1;
      return 'expired-token';
    },
    refreshAccessToken: async () => {
      dependencyCalls += 1;
      return 'fresh-token';
    },
    retry: async () => {
      dependencyCalls += 1;
      return result(200, 'fresh-token');
    },
    assertSessionCurrent: () => undefined,
  });

  assert.equal(received, initial);
  assert.equal(dependencyCalls, 0);
});

test('an unauthorized request refreshes once and retries once', async () => {
  const calls: string[] = [];
  const expiredToken = tokenFor('user-a', 'expired');
  const freshToken = tokenFor('user-a', 'fresh');

  const received = await retryUnauthorizedResponse({
    result: result(401, expiredToken),
    allowRefresh: true,
    getAccessToken: async () => {
      calls.push('get:expired-token');
      return expiredToken;
    },
    refreshAccessToken: async () => {
      calls.push('refresh');
      return freshToken;
    },
    retry: async (token) => {
      calls.push(`retry:${token}`);
      return result(200, token);
    },
    assertSessionCurrent: () => undefined,
  });

  assert.deepEqual(received, result(200, freshToken));
  assert.deepEqual(calls, ['get:expired-token', 'refresh', `retry:${freshToken}`]);
});

test('a refresh result owned by another account is never used for retry', async () => {
  const attemptedToken = tokenFor('user-a', 'expired');
  const otherAccountToken = tokenFor('user-b', 'refreshed-cookie');
  let retryCalls = 0;
  const initial = result(401, attemptedToken);

  const received = await retryUnauthorizedResponse({
    result: initial,
    allowRefresh: true,
    getAccessToken: async () => attemptedToken,
    refreshAccessToken: async () => otherAccountToken,
    retry: async (token) => {
      retryCalls += 1;
      return result(200, token);
    },
    assertSessionCurrent: () => undefined,
  });

  assert.equal(received, initial);
  assert.equal(retryCalls, 0);
});

test('a stale unauthorized response reuses the latest stored token', async () => {
  const calls: string[] = [];
  const staleToken = tokenFor('user-a', 'stale');
  const latestToken = tokenFor('user-a', 'latest');

  const received = await retryUnauthorizedResponse({
    result: result(401, staleToken),
    allowRefresh: true,
    getAccessToken: async () => {
      calls.push('get:latest-token');
      return latestToken;
    },
    refreshAccessToken: async () => {
      calls.push('refresh');
      return 'unexpected-token';
    },
    retry: async (token) => {
      calls.push(`retry:${token}`);
      return result(200, token);
    },
    assertSessionCurrent: () => undefined,
  });

  assert.deepEqual(received, result(200, latestToken));
  assert.deepEqual(calls, ['get:latest-token', `retry:${latestToken}`]);
});

test('a stale unauthorized response is never retried as a different account', async () => {
  const staleToken = tokenFor('user-a', 'stale');
  const replacementToken = tokenFor('user-b', 'new-login');
  let refreshCalls = 0;
  let retryCalls = 0;

  const initial = result(401, staleToken);
  const received = await retryUnauthorizedResponse({
    result: initial,
    allowRefresh: true,
    getAccessToken: async () => replacementToken,
    refreshAccessToken: async () => {
      refreshCalls += 1;
      return replacementToken;
    },
    retry: async (token) => {
      retryCalls += 1;
      return result(200, token);
    },
    assertSessionCurrent: () => undefined,
  });

  assert.equal(received, initial);
  assert.equal(refreshCalls, 0);
  assert.equal(retryCalls, 0);
});

test('an opaque replacement token fails closed instead of retrying', async () => {
  const initial = result(401, tokenFor('user-a', 'stale'));
  let retryCalls = 0;

  const received = await retryUnauthorizedResponse({
    result: initial,
    allowRefresh: true,
    getAccessToken: async () => 'not-a-jwt',
    refreshAccessToken: async () => 'unexpected',
    retry: async (token) => {
      retryCalls += 1;
      return result(200, token);
    },
    assertSessionCurrent: () => undefined,
  });

  assert.equal(received, initial);
  assert.equal(retryCalls, 0);
});

test('a failed retry is returned without an unbounded refresh loop', async () => {
  let refreshCalls = 0;
  let retryCalls = 0;
  const expiredToken = tokenFor('user-a', 'expired');
  const freshToken = tokenFor('user-a', 'fresh');

  const received = await retryUnauthorizedResponse({
    result: result(401, expiredToken),
    allowRefresh: true,
    getAccessToken: async () => expiredToken,
    refreshAccessToken: async () => {
      refreshCalls += 1;
      return freshToken;
    },
    retry: async (token) => {
      retryCalls += 1;
      return result(401, token);
    },
    assertSessionCurrent: () => undefined,
  });

  assert.deepEqual(received, result(401, freshToken));
  assert.equal(refreshCalls, 1);
  assert.equal(retryCalls, 1);
});

test('refresh failures distinguish invalid sessions from transient outages', () => {
  for (const status of [401, 403, 404]) {
    assert.equal(isTerminalRefreshError(Object.assign(new Error(), { status })), true);
  }
  for (const status of [400, 408, 429, 500, 503]) {
    assert.equal(isTerminalRefreshError(Object.assign(new Error(), { status })), false);
  }
  assert.equal(isTerminalRefreshError(new Error('network failure')), false);
  assert.equal(isTerminalRefreshError({ status: '401' }), false);
});
