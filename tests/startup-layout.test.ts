import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { act } from "react";
import { deferred, type Viewer, startup } from "./support/startup-harness";

test('session restoration starts while fonts are pending; fonts alone cannot reveal protected navigation', async () => {
  const app = startup({ segments: ['(tabs)'] });
  await app.mount();
  try {
    assert.ok(app.events.includes('fonts:start'));
    assert.ok(app.events.includes('session:start'), 'restoration must start before fonts settle');
    assert.equal(app.navigationMounts, 0);
    assert.equal(app.splashHides, 0);

    await act(async () => { app.fonts.resolve(); });
    assert.equal(app.navigationMounts, 0, 'no protected screen while session is unresolved');
    assert.equal(app.splashHides, 0);
    assert.deepEqual(app.redirects, []);

    await act(async () => { app.session.resolve('stored-token'); });
    assert.ok(app.navigationMounts > 0);
    assert.equal(app.splashHides, 1);
    assert.deepEqual(app.redirects, []);
  } finally {
    await app.unmount();
  }
});

test('a restored session still waits for fonts and preserves onboarding routing', async () => {
  const app = startup({ viewer: { user_id: 'new', username: 'new', onboarding_completed: false } });
  await app.mount();
  try {
    await act(async () => { app.session.resolve('stored-token'); });
    assert.equal(app.navigationMounts, 0);
    assert.equal(app.splashHides, 0);
    assert.deepEqual(app.redirects, []);

    await act(async () => { app.fonts.resolve(); });
    assert.ok(app.navigationMounts > 0);
    assert.equal(app.splashHides, 1);
    assert.deepEqual(app.redirects, ['/onboarding/create-profile']);
    assert.equal(app.events.filter(event => event === 'session:start').length, 1);
  } finally {
    await app.unmount();
  }
});

test('font failure releases the splash only after anonymous restoration and keeps sign-in routing', async () => {
  const app = startup({ segments: ['(tabs)'], viewer: null });
  await app.mount();
  try {
    await act(async () => { app.fonts.reject(new Error('font unavailable')); });
    assert.equal(app.splashHides, 0);
    assert.equal(app.navigationMounts, 0);

    await act(async () => { app.session.resolve(null); });
    assert.equal(app.splashHides, 1);
    assert.ok(app.navigationMounts > 0);
    assert.deepEqual(app.redirects, ['/(auth)/login']);
  } finally {
    await app.unmount();
  }
});

test('anonymous public routes remain public once both startup tasks finish', async () => {
  const app = startup({ segments: ['privacy'], viewer: null });
  await app.mount();
  try {
    await act(async () => { app.session.resolve(null); app.fonts.resolve(); });
    assert.ok(app.navigationMounts > 0);
    assert.equal(app.splashHides, 1);
    assert.deepEqual(app.redirects, []);
  } finally {
    await app.unmount();
  }
});

test('unmounting during startup cannot later hide the splash or navigate', async () => {
  const app = startup();
  await app.mount();
  await app.unmount();
  await act(async () => { app.session.resolve('stored-token'); app.fonts.resolve(); });
  assert.equal(app.navigationMounts, 0);
  assert.equal(app.splashHides, 0);
  assert.deepEqual(app.redirects, []);
});

test('post-startup sign-in preserves the navigator through delayed success and profile failure', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const app = startup({ viewer: null });
  await app.mount();
  try {
    await act(async () => { app.session.resolve(null); app.fonts.resolve(); });
    const profile = deferred<Viewer>();
    app.setStoredToken('login-token');
    app.setProfileRequest(profile.promise);
    let login!: Promise<unknown>;
    await act(async () => {
      login = app.auth.setSession({ accessToken: 'login-token', sessionGeneration: 0 });
    });
    assert.equal(app.auth.isLoading, true);
    assert.equal(app.navigationMounts, 1);
    assert.equal(app.navigationUnmounts, 0);
    await act(async () => {
      profile.resolve({ user_id: 'alice', username: 'alice', onboarding_completed: true });
      await login;
    });
    assert.equal(app.auth.user?.user_id, 'alice');
    assert.deepEqual(app.redirects, ['/(tabs)/home']);

    const failedProfile = deferred<Viewer>();
    app.setProfileRequest(failedProfile.promise);
    await act(async () => {
      login = app.auth.setSession({ accessToken: 'login-token', sessionGeneration: 0 })
        .catch(error => error);
    });
    assert.equal(app.auth.isLoading, true);
    assert.equal(app.navigationUnmounts, 0);
    const failure = Object.assign(new Error('profile unavailable'), { status: 503 });
    await act(async () => { failedProfile.reject(failure); assert.equal(await login, failure); });
    assert.equal(app.auth.isLoading, false);
    assert.equal(app.navigationMounts, 1);
    assert.equal(app.navigationUnmounts, 0);
    assert.equal(app.splashHides, 1);
  } finally {
    await app.unmount();
  }
});

test('a superseded post-startup session cannot reset navigation or replace the newer viewer', async () => {
  const app = startup({ viewer: null });
  await app.mount();
  try {
    await act(async () => { app.session.resolve(null); app.fonts.resolve(); });
    const staleProfile = deferred<Viewer>();
    app.setStoredToken('old-token');
    app.setProfileRequest(staleProfile.promise);
    let staleLogin!: Promise<unknown>;
    await act(async () => {
      staleLogin = app.auth.setSession({ accessToken: 'old-token', sessionGeneration: 0 })
        .catch(error => error);
    });
    await act(async () => { app.lifecycle.retire(0); });
    const newerProfile = deferred<Viewer>();
    app.setStoredToken('new-token');
    app.setProfileRequest(newerProfile.promise);
    let newerLogin!: Promise<void>;
    await act(async () => {
      newerLogin = app.auth.setSession({ accessToken: 'new-token', sessionGeneration: 1 });
    });
    await act(async () => {
      newerProfile.resolve({ user_id: 'bob', username: 'bob', onboarding_completed: true });
      await newerLogin;
      staleProfile.resolve({ user_id: 'alice', username: 'alice', onboarding_completed: true });
      assert.equal((await staleLogin as Error).name, 'SessionChangedError');
    });
    assert.equal(app.auth.user?.user_id, 'bob');
    assert.equal(app.auth.isLoading, false);
    assert.equal(app.navigationMounts, 1);
    assert.equal(app.navigationUnmounts, 0);
    assert.equal(app.splashHides, 1);
  } finally {
    await app.unmount();
  }
});

test('superseding a pending startup cannot finish the newer session profile loading state', async () => {
  const app = startup();
  const staleProfile = deferred<Viewer>();
  app.setProfileRequest(staleProfile.promise);
  await app.mount();
  try {
    await act(async () => { app.session.resolve('old-token'); app.fonts.resolve(); });
    await act(async () => { app.lifecycle.retire(0); });
    const newProfile = deferred<Viewer>();
    app.setStoredToken('new-token');
    app.setProfileRequest(newProfile.promise);
    let login!: Promise<void>;
    await act(async () => {
      login = app.auth.setSession({ accessToken: 'new-token', sessionGeneration: 1 });
    });
    await act(async () => {
      staleProfile.resolve({ user_id: 'alice', username: 'obsolete', onboarding_completed: true });
    });
    assert.equal(app.auth.isLoading, true, 'old startup cleanup must not finish a newer profile request');
    assert.equal(app.auth.user, null);
    await act(async () => {
      newProfile.resolve({ user_id: 'bob', username: 'bob', onboarding_completed: true });
      await login;
    });
    assert.equal(app.auth.user?.user_id, 'bob');
    await act(async () => { await app.auth.signOut(); });
    assert.equal(app.auth.user, null);
  } finally {
    await app.unmount();
  }
});

test('signing out during startup cancels the pending profile instead of restoring its viewer later', async () => {
  const app = startup();
  const staleProfile = deferred<Viewer>();
  app.setProfileRequest(staleProfile.promise);
  await app.mount();
  try {
    await act(async () => { app.session.resolve('old-token'); app.fonts.resolve(); });
    await act(async () => { await app.auth.signOut(); });
    await act(async () => {
      staleProfile.resolve({ user_id: 'alice', username: 'obsolete', onboarding_completed: true });
    });
    assert.equal(app.auth.user, null);
    assert.equal(app.auth.startupError, null);
    assert.equal(app.auth.isLoading, false);
    assert.equal(app.navigationMounts, 1);
  } finally {
    await app.unmount();
  }
});

test('public account recovery can mount during restoration but protected deep links stay gated', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  for (const segments of [['(auth)', 'forgot-password'], ['(auth)', 'reset-password'], ['privacy'], ['terms'], ['(tabs)', 'home'], ['onboarding', 'create-profile'], ['repository', 'private-id']]) {
    const app = startup({ segments });
    const profile = deferred<Viewer>();
    app.setProfileRequest(profile.promise);
    await app.mount();
    try {
      await act(async () => { app.session.resolve('stored-token'); app.fonts.resolve(); });
      const publicRoute = segments[0] === '(auth)' || ['privacy', 'terms'].includes(segments[0]);
      assert.equal(app.navigationMounts, publicRoute ? 1 : 0, segments.join('/'));
      await act(async () => { profile.reject(new TypeError('offline')); });
      assert.ok(app.auth.startupError);
      assert.equal(app.navigationMounts, publicRoute ? 1 : 0, 'restore errors must not expose protected routes');
      assert.equal(app.splashHides, 1);
      assert.deepEqual(app.redirects, []);
    } finally { await app.unmount(); }
  }
});

test('leaving a public recovery route cannot reveal a protected route before startup settles', async () => {
  const app = startup({ segments: ['(auth)', 'forgot-password'] });
  await app.mount();
  try {
    await act(async () => { app.fonts.resolve(); });
    assert.equal(app.navigationMounts - app.navigationUnmounts, 1);
    await act(async () => { app.navigate(['(tabs)', 'home']); });
    assert.equal(app.navigationMounts - app.navigationUnmounts, 0, 'public route access must not release the protected startup gate');
    await act(async () => { app.session.resolve('valid-token'); });
    assert.equal(app.navigationMounts - app.navigationUnmounts, 1);
  } finally { await app.unmount(); }
});


test('restored auth prefetches Home before fonts and the mounted query joins the same pagination work', async () => {
  const app=startup({segments:['(tabs)']});
  const feed=deferred<any>();app.setFeedRequest(feed.promise);
  await app.mount();
  try {
    const token=`header.${Buffer.from(JSON.stringify({userId:'alice'})).toString('base64url')}.signature`;
    await act(async()=>{app.session.resolve(token);});
    assert.equal(app.navigationMounts,0,'Fonts still gate navigation');
    assert.equal(app.events.filter(event=>event==='feed:prefetch').length,1);
    const joined=app.feedClient.fetchInfiniteQuery(app.homeFeedOptions('alice'));
    await act(async()=>{feed.resolve({items:[],nextCursor:null,feedVersion:'1'});await joined;});
    assert.equal(app.events.filter(event=>event==='feed:prefetch').length,1,'Navigation must not issue another first-page request');
    app.feedClient.clear();
    assert.equal(app.feedClient.getQueryData(['feed','alice']),undefined);
  } finally {await app.unmount();app.feedClient?.clear();}
});
