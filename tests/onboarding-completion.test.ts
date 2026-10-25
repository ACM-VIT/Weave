import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred as pending, loadSource } from './support/startup-harness';

// Keep the real API payload construction and AuthProvider; only platform
// storage/network boundaries are replaced, so assertions observe requests and
// user state rather than an implementation-shaped mock of completion.
async function completionFixture() {
  const React = await import('react');
  const { create } = await import('react-test-renderer');
  const query = await import('@tanstack/react-query');
  const { QueryClient, QueryClientProvider } = query;
  const { SessionLifecycle } = await import('../src/api/session-lifecycle');
  const lifecycle = new SessionLifecycle();
  const requests: { path: string; method: string; body?: any; token: string }[] = [];
  let storedToken: Promise<string | null> = Promise.resolve('original-token');
  let response: Promise<any> = Promise.resolve({ completed: true, ...savedProfile });
  let profileResponse: Promise<any> | undefined;
  let profile = { ...savedProfile, username: 'before', onboarding_completed: false, likes_given_count: 7 };
  const api = { apiV2: async (path: string, options: RequestInit = {}, token: string, policy: { beforeSend?: () => void } = {}) => {
    policy.beforeSend?.();
    requests.push({ path, method: options.method ?? 'GET', body: options.body ? JSON.parse(String(options.body)) : undefined, token });
    if (path === '/users/me' && !options.method) return profileResponse ?? profile;
    const saved = await response;
    return path === '/onboarding/complete' ? { completed: saved.completed, viewer: saved } : saved;
  }, setSessionExpiredHandler() {}, refreshSession: async () => 'original-token' };
  const onboarding = loadSource('src/api/onboarding.ts', { './client': api, './session-lifecycle': { authSessionLifecycle: lifecycle } });
  const auth = loadSource('src/store/AuthContext.tsx', {
    '../api/client': api, '../api/onboarding': onboarding, '@tanstack/react-query': query,
    '../api/auth': { logout: async () => undefined },
    '../api/feed-sessions': { feedSessions: () => ({ endAll: async () => undefined }) },
    '../utils/storage': { getStorageItem: () => storedToken },
    '../api/session-lifecycle': { ...await import('../src/api/session-lifecycle'), authSessionLifecycle: lifecycle },
    '../api/session-transitions': { isSessionRestoreBlocked: async () => false, retireSessionIfCurrent: async () => false },
  });
  let current: any;
  function Probe() { current = auth.useAuth(); return null; }
  const queryClient = new QueryClient();
  let root: ReturnType<typeof create>;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await React.act(async () => { root = create(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(auth.AuthProvider, null, React.createElement(Probe)))); });
  await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  requests.length = 0;
  return { requests, lifecycle, onboarding, act: React.act,
    get auth() { return current; },
    setResponse(next: Promise<any>) { response = next; },
    setToken(next: Promise<string | null>) { storedToken = next; },
    setProfile(next: Partial<typeof profile>) { profile = { ...profile, ...next }; },
    setProfileResponse(next: Promise<any> | undefined) { profileResponse = next; },
    async switchAccount() {
      profile = { ...profile, user_id: 'second-viewer', username: 'second', onboarding_completed: false };
      storedToken = Promise.resolve('second-token');
      await React.act(async () => { lifecycle.retire(lifecycle.currentGeneration()); });
      await React.act(async () => { await current.setSession({ accessToken: 'second-token', sessionGeneration: lifecycle.currentGeneration() }); });
      requests.length = 0;
    },
    async close() { await React.act(async () => root.unmount()); queryClient.clear(); },
  };
}
const draft = { username: 'chosen', full_name: 'Chosen Name', date_of_birth: '2000-01-01', interests: ['react'], bio: 'draft bio' };
const savedProfile = { user_id: 'original-viewer', username: 'persisted', full_name: 'Persisted Name', date_of_birth: '2000-01-01',
  bio: 'persisted bio', avatar_url: null, onboarding_completed: true, profile_version: '2' };

test('onboarding validates before any write and atomically submits profile with preferences', async () => {
  const app = await completionFixture();
  try {
    await assert.rejects(app.onboarding.setupOnboarding('original-token', { ...draft, bio: 'x'.repeat(2001) }), /2000/);
    assert.equal(app.requests.length, 0, 'invalid selections must not leave a separately persisted profile');
    await app.onboarding.setupOnboarding('original-token', draft);
    assert.deepEqual(app.requests.map(request => [request.method, request.path]), [['PUT', '/onboarding/complete']]);
    assert.equal(app.requests[0].body.profile.username, draft.username);
    assert.equal(app.requests[0].body.profile.full_name, draft.full_name);
    assert.equal(app.requests[0].body.profile.date_of_birth, draft.date_of_birth);
  } finally { await app.close(); }
});

test('auth applies authoritative persisted completion without PATCH or refresh GET', async () => {
  const app = await completionFixture();
  try {
    assert.equal(typeof app.auth.completeOnboarding, 'function', 'AuthProvider must own the original save generation');
    await app.act(async () => { await app.auth.completeOnboarding(draft); });
    assert.deepEqual(app.requests.map(request => [request.method, request.path]), [['PUT', '/onboarding/complete']]);
    assert.equal(app.auth.user.onboarding_completed, true);
    assert.equal(app.auth.user.username, 'persisted', 'routing/profile use the persisted response, never draft values');
    assert.equal(app.auth.user.bio, 'persisted bio');
    assert.equal(app.auth.user.likes_given_count, 7, 'partial authoritative profile must preserve unrelated counts');
  } finally { await app.close(); }
});

test('legacy completion refreshes under its original generation and late saves cannot mutate a new viewer', async () => {
  const app = await completionFixture();
  try {
    assert.equal(typeof app.auth.completeOnboarding, 'function', 'AuthProvider must own the original save generation');
    app.setResponse(Promise.resolve({ completed: true, profile_version: '2' }));
    await app.act(async () => { await app.auth.completeOnboarding(draft); });
    assert.deepEqual(app.requests.map(request => [request.method, request.path]), [['PUT', '/onboarding/complete'], ['GET', '/users/me']]);
    assert.equal(app.auth.user.onboarding_completed, false, 'legacy completion cannot infer durable state from local values');
    app.requests.length = 0;
    const saved = pending<any>(); app.setResponse(saved.promise);
    let saving!: Promise<any>;
    await app.act(async () => { saving = app.auth.completeOnboarding(draft).then(() => null, (error: Error) => error); });
    await app.switchAccount();
    await app.act(async () => { saved.resolve({ completed: true, ...savedProfile }); });
    assert.match((await saving).message, /session changed/);
    assert.equal(app.auth.user.user_id, 'second-viewer');
    assert.equal(app.auth.user.onboarding_completed, false);
    assert.equal(app.requests.length, 0, 'stale save must not start a fallback GET using the new account');
  } finally { await app.close(); }
});

test('account change during token read prevents onboarding write entirely', async () => {
  const app = await completionFixture();
  try {
    assert.equal(typeof app.auth.completeOnboarding, 'function', 'AuthProvider must own the original save generation');
    const read = pending<string | null>(); app.setToken(read.promise);
    let saving!: Promise<any>;
    await app.act(async () => { saving = app.auth.completeOnboarding(draft).then(() => null, (error: Error) => error); });
    await app.switchAccount();
    await app.act(async () => { read.resolve('original-token'); });
    assert.match((await saving).message, /session changed/);
    assert.equal(app.requests.length, 0);
  } finally { await app.close(); }
});

test('atomic submission omits unspecified profile fields instead of erasing imported profile values', async () => {
  const app = await completionFixture();
  try {
    const { bio: _bio, ...withoutBio } = draft;
    await app.onboarding.setupOnboarding('original-token', withoutBio);
    const sent = app.requests.find(request => request.path === '/onboarding/complete')!.body;
    assert.equal(Object.hasOwn(sent, 'bio'), false);
    assert.equal(Object.hasOwn(sent, 'avatar_url'), false);
    assert.equal(Object.hasOwn(sent.profile, 'avatar_url'), false);
    await app.onboarding.setupOnboarding('original-token', {
      ...withoutBio,
      avatar_url: 'https://fixture.invalid/unvalidated-avatar.webp',
    });
    assert.equal(Object.hasOwn(app.requests.at(-1)!.body, 'avatar_url'), false,
      'even a legacy caller cannot bypass the dedicated avatar upload by supplying an onboarding URL');
    assert.equal(Object.hasOwn(app.requests.at(-1)!.body.profile, 'avatar_url'), false);
  } finally { await app.close(); }
});

test('a completion callback retained by the previous account cannot acquire the new account lease', async () => {
  const app = await completionFixture();
  try {
    const oldComplete = app.auth.completeOnboarding;
    await app.switchAccount();
    let error: any;
    await app.act(async () => { error = await oldComplete(draft).then(() => null, (failure: Error) => failure); });
    assert.match(error?.message ?? '', /session changed/);
    assert.equal(app.requests.length, 0, 'an old form callback must fail before submitting under the new token');
  } finally { await app.close(); }
});

test('save bounds a stalled token read and its late resolution cannot start a mutation', async t => {
  const app = await completionFixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const token = pending<string | null>(); app.setToken(token.promise);
    let outcome: any;
    await app.act(async () => { void app.auth.completeOnboarding(draft).then(() => { outcome = null; }, (error: Error) => { outcome = error; }); });
    await app.act(async () => { t.mock.timers.tick(15_000); });
    assert.match(outcome?.message ?? '', /session.*timed out/i, 'the form cannot remain busy forever before PUT');
    assert.equal(app.auth.onboardingSave.status, 'idle', 'no request was issued, so an explicit retry is safe');
    app.setToken(Promise.resolve('original-token'));
    let retry: Promise<void> | undefined;
    await app.act(async () => { retry = app.auth.completeOnboarding(draft); });
    assert.equal(app.requests.filter(request => request.method === 'PUT').length, 1,
      'an unresolved timed-out lookup cannot hold the retirement lane against a fresh retry');
    await app.act(async () => retry);
    await app.act(async () => token.resolve('original-token'));
    assert.equal(app.requests.filter(request => request.method === 'PUT').length, 1,
      'a token arriving after the UI deadline cannot issue a late duplicate PUT');
  } finally { t.mock.timers.reset(); await app.close(); }
});

test('timed-out PUT keeps one uncertain flight, rejects blind resubmit and accepts a late same-owner completion', async t => {
  const app = await completionFixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const response = pending<any>(); app.setResponse(response.promise);
    let outcome: any;
    await app.act(async () => { void app.auth.completeOnboarding(draft).then(() => { outcome = null; }, (error: Error) => { outcome = error; }); });
    await app.act(async () => { t.mock.timers.tick(15_000); });
    assert.equal(outcome?.name, 'OnboardingOutcomeUnknownError');
    assert.equal(app.auth.onboardingSave.status, 'unknown');
    assert.match(app.auth.onboardingSave.message, /may have saved/i);
    await assert.rejects(app.auth.completeOnboarding(draft), { name: 'OnboardingOutcomeUnknownError' });
    assert.equal(app.requests.filter(request => request.method === 'PUT').length, 1);
    await app.act(async () => response.resolve({ completed: true, ...savedProfile }));
    assert.equal(app.auth.user.onboarding_completed, true);
    assert.equal(app.auth.onboardingSave.status, 'idle');
    assert.equal(app.requests.length, 1, 'the late authoritative response needs no additional request');
  } finally { t.mock.timers.reset(); await app.close(); }
});

test('committed response lost reconciles with one deduplicated read and never repeats the PUT', async t => {
  const app = await completionFixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const response = pending<any>(); app.setResponse(response.promise);
    let saving!: Promise<any>;
    await app.act(async () => { saving = app.auth.completeOnboarding(draft).then(() => null, (error: Error) => error); });
    await app.act(async () => response.reject(new TypeError('response lost after commit')));
    assert.equal((await saving).name, 'OnboardingOutcomeUnknownError');
    assert.equal(app.auth.onboardingSave.status, 'unknown');
    app.setProfile({ ...savedProfile, onboarding_completed: true });
    let first!: Promise<void>, second!: Promise<void>;
    await app.act(async () => { first = app.auth.reconcileOnboarding(); second = app.auth.reconcileOnboarding(); await Promise.all([first, second]); });
    assert.deepEqual(app.requests.map(request => [request.method, request.path]), [['PUT', '/onboarding/complete'], ['GET', '/users/me']]);
    assert.equal(app.auth.user.onboarding_completed, true);
    assert.equal(app.auth.onboardingSave.status, 'idle');
  } finally { t.mock.timers.reset(); await app.close(); }
});

test('an incomplete or stalled reconciliation stays uncertain and account switches fence late write and read results', async t => {
  const app = await completionFixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const response = pending<any>(); app.setResponse(response.promise);
    await app.act(async () => { void app.auth.completeOnboarding(draft).catch(() => undefined); });
    await app.act(async () => { t.mock.timers.tick(15_000); });
    assert.equal(app.auth.onboardingSave?.status, 'unknown');
    await app.act(async () => app.auth.reconcileOnboarding());
    assert.equal(app.auth.onboardingSave.status, 'unknown', 'a currently incomplete profile does not prove a pending PUT cannot commit');
    await assert.rejects(app.auth.completeOnboarding(draft), { name: 'OnboardingOutcomeUnknownError' });
    assert.equal(app.requests.filter(request => request.method === 'PUT').length, 1);
    const profile = pending<any>(); app.setProfileResponse(profile.promise);
    let check: any;
    await app.act(async () => { void app.auth.reconcileOnboarding().then(() => { check = null; }, (error: Error) => { check = error; }); });
    await app.act(async () => { t.mock.timers.tick(15_000); });
    assert.match(check?.message ?? '', /check.*timed out/i);
    assert.equal(app.auth.onboardingSave.status, 'unknown');
    app.setProfileResponse(undefined);
    await app.switchAccount();
    await app.act(async () => { response.resolve({ completed: true, ...savedProfile }); profile.resolve(savedProfile); });
    assert.equal(app.auth.user.user_id, 'second-viewer');
    assert.equal(app.auth.user.onboarding_completed, false);
    assert.equal(app.auth.onboardingSave.status, 'idle');
    assert.equal(app.requests.length, 0, 'late old-owner results cannot start new-account work');
  } finally { t.mock.timers.reset(); await app.close(); }
});

test('legacy profile refresh is bounded without losing a late durable completion', async t => {
  const app = await completionFixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    app.setResponse(Promise.resolve({ completed: true, profile_version: '2' }));
    const profile = pending<any>(); app.setProfileResponse(profile.promise);
    let outcome: any;
    await app.act(async () => { void app.auth.completeOnboarding(draft).catch((error: Error) => { outcome = error; }); });
    await app.act(async () => { t.mock.timers.tick(15_000); });
    assert.equal(outcome?.name, 'OnboardingOutcomeUnknownError');
    assert.equal(app.auth.onboardingSave.status, 'unknown');
    await app.act(async () => profile.resolve(savedProfile));
    assert.equal(app.auth.user.onboarding_completed, true);
    assert.equal(app.auth.onboardingSave.status, 'idle');
    assert.equal(app.requests.filter(request => request.method === 'PUT').length, 1);
  } finally { t.mock.timers.reset(); await app.close(); }
});

test('definite validation or conflict rejection permits an explicit corrected save', async () => {
  for (const status of [400, 409]) {
    const app = await completionFixture();
    try {
      const response = pending<any>(); app.setResponse(response.promise);
      let saving!: Promise<any>;
      await app.act(async () => { saving = app.auth.completeOnboarding(draft).then(() => null, (error: Error) => error); });
      await app.act(async () => response.reject(Object.assign(new Error('definite rejection'), { status })));
      const error = await saving;
      assert.notEqual(error.name, 'OnboardingOutcomeUnknownError');
      assert.equal(app.auth.onboardingSave?.status, 'idle');
      app.setResponse(Promise.resolve({ completed: true, ...savedProfile }));
      await app.act(async () => app.auth.completeOnboarding(draft));
      assert.equal(app.requests.filter(request => request.method === 'PUT').length, 2);
    } finally { await app.close(); }
  }
});

test('a late older status read cannot undo an authoritative save response', async t => {
  const app = await completionFixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const response = pending<any>(); app.setResponse(response.promise);
    await app.act(async () => { void app.auth.completeOnboarding(draft).catch(() => undefined); });
    await app.act(async () => { t.mock.timers.tick(15_000); });
    const profile = pending<any>(); app.setProfileResponse(profile.promise);
    let check!: Promise<any>;
    await app.act(async () => { check = app.auth.reconcileOnboarding().catch((error: Error) => error); });
    await app.act(async () => response.resolve({ completed: true, ...savedProfile }));
    assert.equal(app.auth.user.onboarding_completed, true);
    await app.act(async () => { profile.resolve({ ...savedProfile, onboarding_completed: false }); await check; });
    assert.equal(app.auth.user.onboarding_completed, true, 'an older read cannot overwrite the acknowledged completion');
    assert.equal(app.auth.onboardingSave.status, 'idle');
  } finally { t.mock.timers.reset(); await app.close(); }
});

test('durable reconciliation retains an unsettled PUT guard and a late transport failure cannot undo it', async t => {
  const app = await completionFixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const response = pending<any>(); app.setResponse(response.promise);
    await app.act(async () => { void app.auth.completeOnboarding(draft).catch(() => undefined); });
    await app.act(async () => { t.mock.timers.tick(15_000); });
    app.setProfile({ ...savedProfile, onboarding_completed: true });
    await app.act(async () => app.auth.reconcileOnboarding());
    assert.equal(app.auth.user.onboarding_completed, true);
    await assert.rejects(app.auth.completeOnboarding(draft), { name: 'OnboardingOutcomeUnknownError' });
    assert.equal(app.requests.filter(request => request.method === 'PUT').length, 1, 'the original transport is still owned, even after server confirmation');
    await app.act(async () => response.reject(new TypeError('late response lost')));
    assert.equal(app.auth.user.onboarding_completed, true);
    assert.equal(app.auth.onboardingSave.status, 'idle');
  } finally { t.mock.timers.reset(); await app.close(); }
});

test('legacy read rejection after accepted PUT is uncertain, not permission to repeat the mutation', async () => {
  const app = await completionFixture();
  try {
    app.setResponse(Promise.resolve({ completed: true, profile_version: '2' }));
    const profile = pending<any>(); app.setProfileResponse(profile.promise);
    let saving!: Promise<any>;
    await app.act(async () => { saving = app.auth.completeOnboarding(draft).then(() => null, (error: Error) => error); });
    await app.act(async () => profile.reject(Object.assign(new Error('profile response unavailable'), { status: 400 })));
    assert.equal((await saving).name, 'OnboardingOutcomeUnknownError');
    assert.equal(app.auth.onboardingSave.status, 'unknown');
    await assert.rejects(app.auth.completeOnboarding(draft), { name: 'OnboardingOutcomeUnknownError' });
    assert.equal(app.requests.filter(request => request.method === 'PUT').length, 1);
  } finally { await app.close(); }
});

test('a confirmed avatar update survives a GET that began before its commit', async () => {
  const f = await completionFixture();
  try {
    let resolveRead!: (value:any)=>void;
    f.setProfileResponse(new Promise(resolve=>{resolveRead=resolve;}));
    let checking!:Promise<void>;
    await f.act(async()=>{checking=f.auth.checkOnboardingStatus();});
    await f.act(async()=>f.auth.applySavedAvatar(savedProfile.user_id,f.lifecycle.currentGeneration(),{avatar_url:'https://fixture.invalid/new.webp',profile_version:'3'}));
    await f.act(async()=>{resolveRead({...savedProfile,avatar_url:'https://fixture.invalid/old.webp',profile_version:'2'});await checking;});
    assert.equal(f.auth.user.avatar_url,'https://fixture.invalid/new.webp');
  } finally {await f.close();}
});

test('a reconciled late onboarding response cannot undo a newer confirmed photo',async t=>{
 const f=await completionFixture();t.mock.timers.enable({apis:['setTimeout']});
 try{const response=pending<any>();f.setResponse(response.promise);
 await f.act(async()=>{void f.auth.completeOnboarding(draft).catch(()=>{});});
 await f.act(async()=>t.mock.timers.tick(15000));f.setProfile({...savedProfile,onboarding_completed:true});
 await f.act(async()=>f.auth.reconcileOnboarding());
 await f.act(async()=>f.auth.applySavedAvatar(savedProfile.user_id,f.lifecycle.currentGeneration(),{avatar_url:'https://fixture.invalid/new.webp',profile_version:'3'}));
 await f.act(async()=>response.resolve({...savedProfile,completed:true,avatar_url:'https://fixture.invalid/old.webp',profile_version:'2'}));
 assert.equal(f.auth.user.avatar_url,'https://fixture.invalid/new.webp');assert.equal(f.auth.user.profile_version,'3');
 }finally{t.mock.timers.reset();await f.close();}
});

test('owner-bound photo reconciliation cannot resolve without a token or an actual profile read',async()=>{
 const f=await completionFixture();try{f.setToken(Promise.resolve(null));
 await assert.rejects(f.auth.checkOnboardingStatus({owner:savedProfile.user_id,generation:f.lifecycle.currentGeneration()}));
 assert.equal(f.requests.length,0);
 }finally{await f.close();}
});

test('owner-bound photo reconciliation resolves only after an authoritative owner profile GET',async()=>{
 const f=await completionFixture();try{
  f.setToken(Promise.resolve('synthetic.'+Buffer.from(JSON.stringify({userId:savedProfile.user_id})).toString('base64url')+'.signature'));
  await f.act(async()=>f.auth.checkOnboardingStatus({owner:savedProfile.user_id,generation:f.lifecycle.currentGeneration()}));
  assert.deepEqual(f.requests.map(request=>[request.method,request.path]),[['GET','/users/me']]);
  assert.equal(f.auth.user.user_id,savedProfile.user_id);
 }finally{await f.close();}
});

test('owner-bound photo check rejects a foreign response before touching authenticated user state',async()=>{
 const f=await completionFixture();try{
  f.setToken(Promise.resolve('synthetic.'+Buffer.from(JSON.stringify({userId:savedProfile.user_id})).toString('base64url')+'.signature'));
  f.setProfileResponse(Promise.resolve({...savedProfile,user_id:'foreign-viewer'}));
  await f.act(async()=>{await assert.rejects(f.auth.checkOnboardingStatus({owner:savedProfile.user_id,generation:f.lifecycle.currentGeneration()}));});
  assert.equal(f.auth.user.user_id,savedProfile.user_id);
 }finally{await f.close();}
});

test('a confirmed reconciliation fences older profile successes and failures', async t => {
  for (const missing of [false, true]) {
    const f = await completionFixture();
    try {
      const stale = pending<any>();
      f.setProfileResponse(stale.promise);
      let reading!: Promise<void>;
      await f.act(async () => { reading = f.auth.checkOnboardingStatus(); });
      const completion = pending<any>();
      f.setResponse(completion.promise);
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let outcome: any;
      await f.act(async () => { void f.auth.completeOnboarding(draft).catch((error: Error) => { outcome = error; }); });
      await f.act(async () => t.mock.timers.tick(15_000));
      assert.equal(outcome?.name, 'OnboardingOutcomeUnknownError');
      f.setProfileResponse(undefined);
      f.setProfile({ ...savedProfile, onboarding_completed: true });
      await f.act(async () => f.auth.reconcileOnboarding());
      assert.equal(f.auth.user.onboarding_completed, true);
      await f.act(async () => {
        if (missing) stale.reject(Object.assign(new Error('older profile missing'), { status: 404 }));
        else stale.resolve({ ...savedProfile, onboarding_completed: false });
        await reading;
      });
      assert.equal(f.auth.user.onboarding_completed, true, 'older reads cannot undo independently confirmed completion');
      assert.equal(f.auth.user.user_id, savedProfile.user_id);
      await f.act(async () => completion.resolve({ completed: true, ...savedProfile }));
    } finally { t.mock.timers.reset(); await f.close(); }
  }
});
