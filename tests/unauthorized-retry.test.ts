import assert from 'node:assert/strict';
import test from 'node:test';

import { isTerminalRefreshError } from '../src/api/session-errors';
import {
  retryUnauthorizedResponse,
  type TokenResponse,
} from '../src/api/unauthorized-retry';

type TestResponse = { status: number };

function result(status: number, token: string | null): TokenResponse<TestResponse> {
  return { response: { status }, token };
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
  });

  assert.equal(received, initial);
  assert.equal(dependencyCalls, 0);
});

test('an unauthorized request refreshes once and retries once', async () => {
  const calls: string[] = [];

  const received = await retryUnauthorizedResponse({
    result: result(401, 'expired-token'),
    allowRefresh: true,
    getAccessToken: async () => {
      calls.push('get:expired-token');
      return 'expired-token';
    },
    refreshAccessToken: async () => {
      calls.push('refresh');
      return 'fresh-token';
    },
    retry: async (token) => {
      calls.push(`retry:${token}`);
      return result(200, token);
    },
  });

  assert.deepEqual(received, result(200, 'fresh-token'));
  assert.deepEqual(calls, ['get:expired-token', 'refresh', 'retry:fresh-token']);
});

test('a stale unauthorized response reuses the latest stored token', async () => {
  const calls: string[] = [];

  const received = await retryUnauthorizedResponse({
    result: result(401, 'stale-token'),
    allowRefresh: true,
    getAccessToken: async () => {
      calls.push('get:latest-token');
      return 'latest-token';
    },
    refreshAccessToken: async () => {
      calls.push('refresh');
      return 'unexpected-token';
    },
    retry: async (token) => {
      calls.push(`retry:${token}`);
      return result(200, token);
    },
  });

  assert.deepEqual(received, result(200, 'latest-token'));
  assert.deepEqual(calls, ['get:latest-token', 'retry:latest-token']);
});

test('a failed retry is returned without an unbounded refresh loop', async () => {
  let refreshCalls = 0;
  let retryCalls = 0;

  const received = await retryUnauthorizedResponse({
    result: result(401, 'expired-token'),
    allowRefresh: true,
    getAccessToken: async () => 'expired-token',
    refreshAccessToken: async () => {
      refreshCalls += 1;
      return 'fresh-token';
    },
    retry: async (token) => {
      retryCalls += 1;
      return result(401, token);
    },
  });

  assert.deepEqual(received, result(401, 'fresh-token'));
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
