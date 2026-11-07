import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { act, createElement } from "react";
import { create } from "react-test-renderer";
import { deferred, startup, fixtureToken, envelope, loadSource } from "./support/startup-harness";

test('a cold real OAuth callback exchanges its code despite an unrelated restore failure', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const app = startup({ segments: ['(auth)', 'callback'], realNetwork: true, mountCallback: true });
  let profiles = 0;
  let exchanges = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = String(url);
    if (path.endsWith('/auth/exchange')) {
      exchanges++;
      return envelope({ accessToken: fixtureToken('alice'), user: { id: 'alice' } });
    }
    assert.ok(path.endsWith('/v2/users/me'));
    if (++profiles === 1) return new Response(JSON.stringify({ error: 'Temporary outage' }), { status: 503 });
    return envelope({ user_id: 'alice', username: 'alice', onboarding_completed: true });
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await app.mount(() => t.mock.timers.tick(0));
  try {
    await act(async () => { app.session.resolve(fixtureToken('alice')); });
    assert.ok(app.auth.startupError);
    await act(async () => { app.fonts.resolve(); });
    assert.equal(exchanges, 1, 'the actual callback screen must mount and exchange its code');
    assert.equal(app.auth.user?.user_id, 'alice');
    assert.equal(app.auth.startupError, null);
    assert.deepEqual(app.redirects, ['/(tabs)/home']);
  } finally { t.mock.timers.reset(); await app.unmount(); }
});

test('stalled refresh releases OAuth recovery without racing rotation or losing its code', async (t) => {
  const app = startup({ segments: ['(auth)', 'callback'], realNetwork: true, mountCallback: true });
  const refreshResponse = deferred<Response>();
  let refreshes = 0;
  let exchanges = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = String(url);
    if (path.endsWith('/auth/refresh')) { refreshes++; return refreshResponse.promise; }
    if (path.endsWith('/auth/exchange')) {
      exchanges++;
      return envelope({ accessToken: fixtureToken('alice'), user: { id: 'alice' } });
    }
    assert.ok(path.endsWith('/v2/users/me'));
    return envelope({ user_id: 'alice', username: 'alice', onboarding_completed: true });
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await app.mount(() => t.mock.timers.tick(0));
  try {
    await act(async () => { app.session.resolve(null); });
    assert.equal(refreshes, 1);
    await act(async () => { app.fonts.resolve(); });
    await act(async () => { t.mock.timers.tick(15_000); });
    assert.ok(app.exchangeRetryButton, 'the callback must stop spinning and expose a bounded retry');
    assert.equal(app.auth.isLoading, false);
    assert.equal(exchanges, 0, 'a timed-out wait must not start auth while the old cookie response is unresolved');
    assert.ok(!app.events.includes('verifier:clear'), 'unconsumed OAuth code must retain its verifier');
    let overlappingRefreshes = 0;
    await assert.rejects(app.lifecycle.runRefresh(async () => { overlappingRefreshes++; }), { name: 'SessionRefreshPendingError' });
    assert.equal(overlappingRefreshes, 0, 'retired flight must block a second rotation even after the auth wait times out');
    await act(async () => { app.retryExchange(); });
    assert.equal(exchanges, 0);
    await act(async () => { refreshResponse.resolve(envelope({ accessToken: fixtureToken('old-account') })); });
    assert.equal(refreshes, 1);
    assert.equal(exchanges, 1, 'retry should exchange the same still-valid code after rotation settles');
    assert.equal(app.events.filter(event => event === 'verifier:clear').length, 1);
    assert.equal(app.auth.user?.user_id, 'alice');
    assert.equal(app.exchangeRetryButton, undefined);
  } finally { t.mock.timers.reset(); await app.unmount(); }
});

test('owner-bound unlink callback stays mounted after session restoration instead of redirecting before completion', async () => {
  for (const onboardingCompleted of [true, false]) {
    const app = startup({ segments: ['(auth)', 'callback'], pathname: '/callback', globalParams: { unlink_code: 'opaque-unlink-code' },
      viewer: { user_id: 'Tarun', username: 'Tarun', onboarding_completed: onboardingCompleted } });
    await app.mount();
    try {
      await act(async () => { app.fonts.resolve(); app.session.resolve('stored-token'); });
      assert.ok(app.navigationMounts > 0);
      assert.deepEqual(app.redirects, [], 'callback owns completion and its explicit return action');
    } finally { await app.unmount(); }
  }
});


test('same-account GitHub reconnect callback cannot be redirected into ordinary sign-in',async()=>{
  const app=startup({segments:['(auth)','callback'],pathname:'/callback',globalParams:{github_reconnect:'1',code:'owned-code'},
    viewer:{user_id:'Tarun',username:'Tarun',onboarding_completed:true}});
  await app.mount();
  try {
    await act(async()=>{app.fonts.resolve();app.session.resolve('stored-token');});
    assert.ok(app.navigationMounts>0);assert.deepEqual(app.redirects,[]);
  }finally{await app.unmount();}
});


test('a web reconnect callback handed to its opener cannot consume the proof again',async()=>{
  let completions=0;
  const Callback=loadSource('src/app/(auth)/callback.tsx',{
    '@/components/onboarding/GithubUnlinkCallback':{GithubReconnectCallback:()=>{completions++;return null;},GithubUnlinkCallback:()=>null},
    'expo-router':{useLocalSearchParams:()=>({github_reconnect:'1',code:'owned-code'})},
    'react-native':{View:'View',Text:'Text',ActivityIndicator:'ActivityIndicator',TouchableOpacity:'TouchableOpacity'},
    '@/store/AuthContext':{},'@/api/auth':{},'@/services/oauthClientPkce':{},
    'expo-web-browser':{maybeCompleteAuthSession:()=>({type:'success',message:'Handed to opener'})},
  }).default;
  let root!:ReturnType<typeof create>;
  await act(async()=>{root=create(createElement(Callback));});
  try{assert.equal(completions,0,'the opener owns completion after successful browser handoff');}
  finally{await act(async()=>root.unmount());}
});

test('pending email signup never establishes or persists an app session', async (t) => {
  let established = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({success:true,data:{requiresEmailConfirmation:true,message:'Check your email.'}}),{status:202}));
  const auth = loadSource('src/api/auth.ts', {
    './config': {API_URL:'http://127.0.0.1:1/api'},
    './session-transitions': {establishSession:async()=>{established=true;throw new Error('Pending signup must not establish a session');}},
  });
  const result = await auth.register('tarun@example.test','a-secure-new-password','Tarun','tarun','2005-01-01');
  assert.equal(result.requiresEmailConfirmation,true);
  assert.equal(established,false);
  assert.equal(result.accessToken,undefined);
});

test('email confirmation stays mounted for an existing account until its explicit return action',async()=>{
  const app=startup({segments:['(auth)','confirm-email'],pathname:'/confirm-email',
    viewer:{user_id:'Tarun',username:'Tarun',onboarding_completed:true}});
  await app.mount();
  try {
    await act(async()=>{app.fonts.resolve();app.session.resolve('stored-token');});
    assert.ok(app.navigationMounts>0);assert.deepEqual(app.redirects,[]);
  }finally{await app.unmount();}
});
