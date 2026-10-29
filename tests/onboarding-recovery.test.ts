import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import ts from 'typescript';
import { startup, deferred, envelope, fixtureToken } from './support/startup-harness';
import { ONBOARDING_INTERESTS } from '../backend/contracts/onboardingTaxonomy';

function loadSource(path: string, mocks: Record<string, unknown>): Record<string, any> {
  const filename = resolve(path), nativeRequire = createRequire(filename);
  const module = { exports: {} };
  const javascript = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', javascript)(
    (specifier: string) => specifier in mocks ? mocks[specifier] : nativeRequire(specifier), module, module.exports,
  );
  return module.exports;
}

const finishData = { username:'alice',full_name:'Alice',date_of_birth:'2005-01-01',skills:['web'],
  interests:['react','vue','angular','svelte','nextjs'] };

test('mounted Finish uses one confirmed response and late profile reads cannot undo Home routing',async t=>{
 for(const lateStatus of [200,404]){
  const viewer={user_id:'alice',username:'alice',onboarding_completed:false,likes_given_count:0};
  const app=startup({viewer,realNetwork:true,segments:['onboarding'],pathname:'/onboarding/step3'});
  const confirmation=deferred<Response>(),started=deferred<void>(),oldProfile=deferred<Response>();
  let staleRead=false;const requests:string[]=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
   const path=new URL(String(url)).pathname;requests.push(path);
   if(path.endsWith('/onboarding/complete')){
    const body=JSON.parse(String(options?.body));assert.equal(body.profile.username,'alice');
    assert.deepEqual(body.interests,finishData.interests);started.resolve();return confirmation.promise;
   }
   assert.ok(path.endsWith('/users/me'));return staleRead?oldProfile.promise:envelope(viewer);
  });
  await app.mount();await act(async()=>{app.session.resolve(fixtureToken('alice'));app.fonts.resolve();});
  const blank=()=>null,native={View:'View',Text:'Text'};
  const step=loadSource('src/app/onboarding/step3.tsx',{
   'react-native':native,'../../store/AuthContext':{useAuth:()=>app.auth},
   '../../store/OnboardingContext':{useOnboarding:()=>({data:finishData})},
   '@/components/keyboard/keyboard-layout':{KeyboardForm:(props:any)=>React.createElement('Form',props)},
   '@/components/onboarding/PrimaryButton':(props:any)=>React.createElement('PrimaryButton',props),
   '@/components/onboarding/ProgressBar':blank,'@/components/onboarding/TechChip':blank,
   '@/components/onboarding/LogoPlaceholder':blank,'@/components/onboarding/StepHeader':blank,
   '@/constants/onboarding':{INTEREST_CATEGORIES:ONBOARDING_INTERESTS},
  });
  let screen!:ReturnType<typeof create>,submission!:Promise<void>,reading!:Promise<void>;
  try{
   await act(async()=>{screen=create(React.createElement(step.default));app.auth.adjustLikesGivenCount('pending-like',1);});
   staleRead=true;await act(async()=>{reading=app.auth.checkOnboardingStatus();});
   const before=requests.length;
   await act(async()=>{submission=screen.root.findByType('PrimaryButton' as any).props.onPress();await started.promise;});
   assert.equal(screen.root.findByType('PrimaryButton' as any).props.title,'Saving...');assert.equal(app.auth.user?.onboarding_completed,false);
   await act(async()=>{confirmation.resolve(envelope({viewer:{...viewer,onboarding_completed:true}}));await submission;});
   assert.deepEqual(requests.slice(before),['/api/v2/onboarding/complete']);
   assert.equal(app.auth.user?.onboarding_completed,true);assert.equal(app.auth.user?.likes_given_count,1,'completion cannot discard a pending optimistic reaction');
   assert.ok(app.redirects.includes('/(tabs)/home'));
   await act(async()=>{oldProfile.resolve(lateStatus===200?envelope(viewer):new Response('{}',{status:404}));await reading;});
   assert.equal(app.auth.user?.onboarding_completed,true,'a pre-confirmation profile result cannot undo durable completion');
   assert.equal(app.storedToken,fixtureToken('alice'));
  }finally{await act(async()=>screen?.unmount());await app.unmount();t.mock.restoreAll();}
 }
});

test('completion preserves username errors and retries safely through an older server',async t=>{
 const viewer={user_id:'alice',username:'alice',onboarding_completed:false};
 const app=startup({viewer,realNetwork:true,segments:['onboarding'],pathname:'/onboarding/step3'});
 let status=409,completed=false;const requests:string[]=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  const path=new URL(String(url)).pathname;requests.push(`${options?.method??'GET'} ${path}`);
  if(path.endsWith('/onboarding/complete'))return status===404
   ?new Response('<!DOCTYPE html><pre>Cannot PUT /api/v2/onboarding/complete</pre>',{status,headers:{'Content-Type':'text/html'}})
   :new Response(JSON.stringify({error:'Completion unavailable'}),{status});
  if(path.endsWith('/onboarding')){completed=true;return envelope({completed:true});}
  assert.ok(path.endsWith('/users/me'));return envelope({...viewer,onboarding_completed:completed});
 });
 await app.mount();await act(async()=>{app.session.resolve(fixtureToken('alice'));app.fonts.resolve();});
 try{
  let before=requests.length;
  await act(async()=>{await assert.rejects(app.auth.finishOnboarding(finishData),/username is already taken/);});
  assert.equal(requests.length-before,1);assert.equal(app.auth.user?.onboarding_completed,false);
  status=503;before=requests.length;
  await act(async()=>{await assert.rejects(app.auth.finishOnboarding(finishData),/may have saved/);});
  assert.equal(requests.length-before,1,'transient errors cannot trigger a second write path');
  assert.equal(app.auth.onboardingSave.status,'unknown');
  await act(async()=>{await assert.rejects(app.auth.finishOnboarding(finishData),/may have saved/);});
  assert.equal(requests.length-before,1,'an ambiguous 503 cannot permit a duplicate send');
  completed=true;
  await act(async()=>{await app.auth.reconcileOnboarding();});
  assert.equal(app.auth.onboardingSave.status,'idle','a current-owner authoritative read clears the settled uncertainty');
  assert.equal(app.auth.user?.onboarding_completed,true);
  status=404;before=requests.length;
  await act(async()=>{await app.auth.finishOnboarding(finishData);});
  assert.deepEqual(requests.slice(before),['PUT /api/v2/onboarding/complete','PATCH /api/v2/users/me','PUT /api/v2/onboarding','GET /api/v2/users/me']);
  assert.equal(app.auth.user?.onboarding_completed,true);
 }finally{await app.unmount();}
});

test('an old-account completion cannot update or block a newly established account',async t=>{
 let owner='alice',completions=0;const late=deferred<Response>(),started=deferred<void>();
 const app=startup({realNetwork:true,segments:['onboarding'],pathname:'/onboarding/step3'});
 t.mock.method(globalThis,'fetch',async url=>{
  if(String(url).endsWith('/onboarding/complete')){
   if(completions++===0){started.resolve();return late.promise;}
   return envelope({viewer:{user_id:owner,username:owner,onboarding_completed:true}});
  }
  return envelope({user_id:owner,username:owner,onboarding_completed:false});
 });
 await app.mount();await act(async()=>{app.session.resolve(fixtureToken('alice'));app.fonts.resolve();});
 try{
  let finishing!:Promise<void>;await act(async()=>{finishing=app.auth.finishOnboarding(finishData);void finishing.catch(()=>undefined);await started.promise;});
  await act(async()=>{
   app.lifecycle.retire(app.lifecycle.currentGeneration());owner='bob';app.setStoredToken(fixtureToken('bob'));
   await app.auth.setSession({accessToken:fixtureToken('bob'),sessionGeneration:app.lifecycle.currentGeneration()});
  });
  assert.equal(app.auth.user?.user_id,'bob');assert.equal(app.auth.user?.onboarding_completed,false);assert.ok(!app.redirects.includes('/(tabs)/home'));
  await act(async()=>{await app.auth.finishOnboarding({...finishData,username:'bob'});});
  assert.equal(app.auth.user?.onboarding_completed,true,'new-generation Finish cannot wait on the old account flight');
  await act(async()=>{
   late.resolve(envelope({viewer:{user_id:'alice',username:'alice',onboarding_completed:true}}));
   await assert.rejects(finishing,/session changed/);
  });
  assert.equal(app.auth.user?.user_id,'bob');assert.equal(app.auth.user?.onboarding_completed,true);
 }finally{late.resolve(envelope({viewer:{user_id:'alice',username:'alice',onboarding_completed:true}}));await app.unmount();}
});

test('Finish serializes stale profile cleanup and retains another tab logout marker',async t=>{
 for(const externalLogout of [false,true]){
 const app=startup({realNetwork:true,segments:['onboarding'],pathname:'/onboarding/step3'});
 const confirmation=deferred<Response>(),started=deferred<void>(),marker=deferred<void>();let missing=false;
 const viewer={user_id:'alice',username:'alice',onboarding_completed:false};
 t.mock.method(globalThis,'fetch',async url=>{
  if(String(url).endsWith('/onboarding/complete')){started.resolve();return confirmation.promise;}
  return missing?new Response('{}',{status:404}):envelope(viewer);
 });
 await app.mount();await act(async()=>{app.session.resolve(fixtureToken('alice'));app.fonts.resolve();});
 let reading:Promise<void>|undefined;
 try{
  let finishing!:Promise<void>;await act(async()=>{finishing=app.auth.finishOnboarding(finishData);await started.promise;});
  app.holdMarkerWrites(marker.promise);missing=true;
  await act(async()=>{reading=app.auth.checkOnboardingStatus();void reading.catch(()=>undefined);});
  await act(async()=>{await new Promise<void>(resolve=>setImmediate(resolve));});
  assert.ok(!app.events.includes('marker:start'),'stale retirement must wait behind the in-flight Finish');
  if(externalLogout)app.setExternalRestoreBlocked('1');
  await act(async()=>{confirmation.resolve(envelope({viewer:{...viewer,onboarding_completed:true}}));await finishing;});
  assert.equal(app.auth.user?.onboarding_completed,true);
  await act(async()=>{app.holdMarkerWrites(undefined);marker.resolve();await reading;});
  assert.equal(app.auth.user?.user_id,'alice');assert.equal(app.auth.user?.onboarding_completed,true);
  assert.equal(app.storedToken,fixtureToken('alice'));assert.equal(await app.isRestoreBlocked(),externalLogout);
 }finally{app.holdMarkerWrites(undefined);marker.resolve();await reading?.catch(()=>undefined);await app.unmount();t.mock.restoreAll();}
 }
});

test('profile retirement already writing its marker prevents a later Finish from sending',async t=>{
 const app=startup({realNetwork:true,segments:['onboarding'],pathname:'/onboarding/step3'});
 const marker=deferred<void>();let missing=false,completions=0;
 t.mock.method(globalThis,'fetch',async url=>{
  if(String(url).endsWith('/onboarding/complete')){completions++;return envelope({viewer:{user_id:'alice',username:'alice',onboarding_completed:true}});}
  return missing?new Response('{}',{status:404}):envelope({user_id:'alice',username:'alice',onboarding_completed:false});
 });
 await app.mount();await act(async()=>{app.session.resolve(fixtureToken('alice'));app.fonts.resolve();});
 let reading:Promise<void>|undefined,finishing:Promise<void>|undefined;
 try{
  app.holdMarkerWrites(marker.promise);missing=true;
  await act(async()=>{reading=app.auth.checkOnboardingStatus();void reading.catch(()=>undefined);});
  const deadline=Date.now()+5000;
  while(!app.events.includes('marker:start')){assert.ok(Date.now()<deadline);await act(async()=>{await new Promise(resolve=>setTimeout(resolve,5));});}
  await act(async()=>{finishing=app.auth.finishOnboarding(finishData);void finishing.catch(()=>undefined);await new Promise<void>(resolve=>setImmediate(resolve));});
  assert.equal(completions,0);
  await act(async()=>{app.holdMarkerWrites(undefined);marker.resolve();await assert.rejects(reading!,/404/);await assert.rejects(finishing!,/session changed/);});
  assert.equal(completions,0);assert.equal(app.auth.user,null);assert.equal(app.storedToken,null);assert.equal(await app.isRestoreBlocked(),true);
 }finally{app.holdMarkerWrites(undefined);marker.resolve();await reading?.catch(()=>undefined);await finishing?.catch(()=>undefined);await app.unmount();}
});

for (const manualMode of [false, true]) {
test(`mounted onboarding recovery preserves drafts and refreshes controls (manualMode=${manualMode})`, async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let linked = true, reads = 0, refreshes = 0;
  const routes: string[] = [];
  const native = Object.fromEntries(['View', 'Text', 'ScrollView', 'Pressable', 'ActivityIndicator'].map(name => [name, name]));
  const safeArea = { SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 59, bottom: 0, left: 0, right: 0 }) };
  const theme = { APP_THEME: {}, REFERENCE_THEME: {}, Fonts: {}, Spacing: { two: 8, three: 12, four: 16 } };
  const auth = { useAuth: () => ({ user: { user_id: 'viewer' }, checkOnboardingStatus: async () => { refreshes++; } }) };
  const onboarding = loadSource('src/store/OnboardingContext.tsx', {});
  const importPanel = loadSource('src/components/onboarding/GitHubImportPanel.tsx', {
    'react-native': native, '../../constants/theme': theme,
    '../../api/githubImport': { githubImportApi: { status: async () => { reads++; return { linked, active: false, provenance: {} }; } } },
  });
  const unlinkPanel = loadSource('src/components/onboarding/GitHubUnlinkPanel.tsx', {
    'react-native': native, 'react-native-safe-area-context': safeArea, '../../constants/theme': theme,
    '../../api/githubUnlink': { githubUnlinkApi: { status: async () => ({ status: linked ? 'pending' : 'done' }) } },
    '../../services/githubUnlink': { startGithubUnlink: async () => null },
  });
  const blank = () => null;
  const step = loadSource('src/app/onboarding/step1.tsx', {
    'react-native': native, 'react-native-safe-area-context': safeArea,
    'expo-router': { router: { push: (route: string) => routes.push(route) } },
    '@/components/onboarding/PrimaryButton': (props: any) => React.createElement('PrimaryButton', props), '@/components/onboarding/ProgressBar': blank,
    '@/components/onboarding/SkillCard': (props: any) => React.createElement('SkillCard', props), '@/components/onboarding/LogoPlaceholder': blank,
    '@/constants/onboarding': { SKILL_CATEGORIES: [{ id: 'data', title: 'Data' }, { id: 'systems', title: 'Systems' }] },
    '../../store/OnboardingContext': onboarding, '../../store/AuthContext': auth,
    '../../components/onboarding/GitHubImportPanel': importPanel,
  });
  let current: any;
  function Probe() { current = onboarding.useOnboarding(); return null; }
  const layout = loadSource('src/app/onboarding/_layout.tsx', {
    'react-native': native, '../../components/onboarding/GitHubUnlinkPanel': unlinkPanel,
    'expo-router': { Stack: () => React.createElement(React.Fragment, null, React.createElement(Probe), React.createElement(step.default)) },
    '../../store/OnboardingContext': onboarding, '../../store/AuthContext': auth,
  });
  let renderer!: ReturnType<typeof create>;
  try {
    await act(async () => { renderer = create(React.createElement(layout.default)); });
    assert.ok(JSON.stringify(renderer.toJSON()).includes('Preview public activity'));
    const recovery = renderer.root.findAllByType('ScrollView' as any).find(node => node.props.style?.maxHeight === '45%');
    assert.ok(recovery, 'pending recovery remains bounded above the onboarding step');
    assert.equal(recovery.props.contentContainerStyle.paddingTop, 59, 'recovery respects the top safe-area inset');
    await act(async () => { current.updateData({ username: 'draft-name', bio: 'draft-bio' }); });
    if (manualMode) {
      await act(async () => { renderer.root.findByProps({ accessibilityLabel: 'Choose preferences myself' }).props.onPress(); });
      await act(async () => {
        for (const card of renderer.root.findAllByType('SkillCard' as any)) card.props.onPress();
      });
      assert.deepEqual(renderer.root.findAllByType('SkillCard' as any).map(card => card.props.selected), [true, true]);
      assert.equal(current.data.skills, undefined, 'category picks are still an unsaved step-local draft');
    }
    const before = reads;
    linked = false;
    const check = renderer.root.findByProps({ accessibilityLabel: 'Check disconnect status' });
    await act(async () => { check.props.onPress(); });
    if (!manualMode) assert.ok(reads > before, 'the mounted import panel must reload after recovery refresh');
    else {
      assert.deepEqual(renderer.root.findAllByType('SkillCard' as any).map(card => card.props.selected), [true, true],
        'recovery must not remount the whole step and lose unsaved category picks');
      assert.equal(renderer.root.findByType('PrimaryButton' as any).props.disabled, false);
      assert.equal(current.data.skills, undefined);
    }
    assert.ok(refreshes >= 2);
    assert.ok(!JSON.stringify(renderer.toJSON()).includes('Preview public activity'));
    assert.equal(current.data.username, 'draft-name');
    assert.equal(current.data.bio, 'draft-bio');
    assert.equal(renderer.root.findAllByType('ScrollView' as any).filter(node => node.props.style?.maxHeight === '45%').length, 0,
      'completed recovery leaves no empty recovery strip');
    if (manualMode) {
      await act(async () => { renderer.root.findByType('PrimaryButton' as any).props.onPress(); });
      assert.deepEqual(current.data.skills, ['data', 'systems']);
      assert.deepEqual(routes, ['/onboarding/step2'], 'Continue saves the retained draft and advances');
    }
  } finally {
    await act(async () => renderer?.unmount());
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  }
});

}
