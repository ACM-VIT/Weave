import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SessionChangedError,
  SessionLifecycle,
} from '../src/api/session-lifecycle';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('a login waits for an older refresh and stale refresh cannot overwrite it', async () => {
  const lifecycle = new SessionLifecycle();
  const refreshResponse = deferred();
  const events: string[] = [];
  let storedToken = 'old-access-token';

  const refresh = lifecycle.runRefresh(async (lease) => {
    events.push('refresh:start');
    await refreshResponse.promise;
    lease.assertCurrent();
    storedToken = 'rotated-old-token';
    return storedToken;
  });
  const login = lifecycle.runTransition(async (lease) => {
    events.push('login:start');
    lease.assertCurrent();
    storedToken = 'new-login-token';
  });

  await Promise.resolve();
  assert.deepEqual(events, ['refresh:start']);

  refreshResponse.resolve();
  await assert.rejects(refresh, SessionChangedError);
  await login;

  assert.equal(storedToken, 'new-login-token');
  assert.deepEqual(events, ['refresh:start', 'login:start']);
});

test('a transition writes last even when an old refresh storage write already started', async () => {
  const lifecycle = new SessionLifecycle();
  const storageWrite = deferred();
  let storedToken = 'initial';

  const refresh = lifecycle.runRefresh(async (lease) => {
    lease.assertCurrent();
    await storageWrite.promise;
    storedToken = 'old-refresh-token';
    lease.assertCurrent();
    return storedToken;
  });
  const login = lifecycle.runTransition(async () => {
    storedToken = 'new-login-token';
  });

  storageWrite.resolve();
  await assert.rejects(refresh, SessionChangedError);
  await login;
  assert.equal(storedToken, 'new-login-token');
});

test('a stale terminal refresh cannot clear a newer login', async () => {
  const lifecycle = new SessionLifecycle();
  const refreshResponse = deferred();
  let storedToken: string | null = 'old-access-token';
  let expirationNotifications = 0;

  const refresh = lifecycle.runRefresh(async (lease) => {
    await refreshResponse.promise;
    lease.assertCurrent();
    storedToken = null;
    expirationNotifications += 1;
    throw Object.assign(new Error('expired'), { status: 401 });
  });
  const login = lifecycle.runTransition(async () => {
    storedToken = 'new-login-token';
  });

  refreshResponse.resolve();
  await assert.rejects(refresh, SessionChangedError);
  await login;

  assert.equal(storedToken, 'new-login-token');
  assert.equal(expirationNotifications, 0);
});

test('logout runs after refresh so its cookie-clearing response is last', async () => {
  const lifecycle = new SessionLifecycle();
  const refreshResponse = deferred();
  const events: string[] = [];

  const refresh = lifecycle.runRefresh(async (lease) => {
    events.push('refresh:request');
    await refreshResponse.promise;
    events.push('refresh:response-cookie');
    lease.assertCurrent();
    return 'rotated-token';
  });
  const logout = lifecycle.runTransition(async () => {
    events.push('logout:request');
    events.push('logout:clear-cookie');
  });

  await Promise.resolve();
  assert.deepEqual(events, ['refresh:request']);
  refreshResponse.resolve();
  await assert.rejects(refresh, SessionChangedError);
  await logout;

  assert.deepEqual(events, [
    'refresh:request',
    'refresh:response-cookie',
    'logout:request',
    'logout:clear-cookie',
  ]);
});

test('refreshes deduplicate only inside the same current generation', async () => {
  const lifecycle = new SessionLifecycle();
  const refreshResponse = deferred();
  let refreshCalls = 0;

  const operation = (label: string) => lifecycle.runRefresh(async () => {
    refreshCalls += 1;
    await refreshResponse.promise;
    return label;
  });

  const first = operation('first');
  const second = operation('second');
  assert.equal(first, second);
  assert.equal(refreshCalls, 1);

  const transition = lifecycle.runTransition(async () => undefined);
  await assert.rejects(() => operation('blocked'), SessionChangedError);
  refreshResponse.resolve();
  await assert.rejects(first, SessionChangedError);
  await transition;

  assert.equal(await operation('new-generation'), 'new-generation');
  assert.equal(refreshCalls, 2);
});

test('a superseded queued auth transition is skipped before its request starts', async () => {
  const lifecycle = new SessionLifecycle();
  const events: string[] = [];

  const first = lifecycle.runTransition(async () => {
    events.push('first:start');
  });
  const second = lifecycle.runTransition(async (lease) => {
    events.push('second:start');
    events.push(`second:current:${lease.isCurrent()}`);
  });

  await assert.rejects(first, SessionChangedError);
  await second;

  assert.deepEqual(events, [
    'second:start',
    'second:current:true',
  ]);
});

test('an in-flight superseded auth request settles before the newer request starts', async () => {
  const lifecycle = new SessionLifecycle();
  const firstStarted = deferred();
  const firstResponse = deferred();
  const events: string[] = [];

  const first = lifecycle.runTransition(async () => {
    events.push('first:start');
    firstStarted.resolve();
    await firstResponse.promise;
    events.push('first:response-cookie');
  });
  await firstStarted.promise;

  const second = lifecycle.runTransition(async () => {
    events.push('second:start');
    events.push('second:response-cookie');
  });

  firstResponse.resolve();
  await assert.rejects(first, SessionChangedError);
  await second;

  assert.deepEqual(events, [
    'first:start',
    'first:response-cookie',
    'second:start',
    'second:response-cookie',
  ]);
});

test('transition preparation runs immediately and remains effective when auth fails', async () => {
  const lifecycle = new SessionLifecycle();
  let restoreBlocked = false;
  let requestStarted = false;

  const transition = lifecycle.runTransition(async () => {
    requestStarted = true;
    throw new Error('invalid credentials');
  }, async () => {
    restoreBlocked = true;
    return undefined;
  });

  assert.equal(restoreBlocked, true);
  await assert.rejects(transition, /invalid credentials/);
  assert.equal(requestStarted, true);
  assert.equal(restoreBlocked, true);
});

test('a failed transition preparation releases the queue for the next login', async () => {
  const lifecycle = new SessionLifecycle();
  let firstRequestCalls = 0;

  const first = lifecycle.runTransition(async () => {
    firstRequestCalls += 1;
  }, async () => {
    throw new Error('secure storage unavailable');
  });
  await assert.rejects(first, /secure storage unavailable/);

  let secondRequestCalls = 0;
  await lifecycle.runTransition(async () => {
    secondRequestCalls += 1;
  });

  assert.equal(firstRequestCalls, 0);
  assert.equal(secondRequestCalls, 1);
});

test('retiring a session invalidates all old work and notifies loading-state owners', async () => {
  const lifecycle = new SessionLifecycle();
  const generation = lifecycle.currentGeneration();
  const notifications: number[] = [];
  const unsubscribe = lifecycle.subscribe((nextGeneration) => {
    notifications.push(nextGeneration);
  });

  assert.equal(lifecycle.retire(generation), true);
  assert.throws(() => lifecycle.assertCurrent(generation), SessionChangedError);
  assert.equal(lifecycle.retire(generation), false);
  assert.deepEqual(notifications, [generation + 1]);

  unsubscribe();
  await lifecycle.runTransition(async () => undefined);
  assert.deepEqual(notifications, [generation + 1]);
});
