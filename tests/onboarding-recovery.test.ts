import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import ts from 'typescript';
import { QueryClient } from '@tanstack/react-query';
import * as feedRepository from '../src/utils/feed-repository';
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

test('one-page onboarding finishes with one discovery topic and optional technologies', async () => {
 const onboarding=loadSource('src/store/OnboardingContext.tsx',{});
 const saved:any[]=[];let draft:any;
 const screen=loadSource('src/components/onboarding/PreferencesScreen.tsx',{
  'lucide-react-native':{Check:()=>null},
  'react-native':{...Object.fromEntries(['View','Text','ScrollView','Pressable','TextInput'].map(name=>[name,name])),Platform:{OS:'web'}},
  'react-native-safe-area-context':{SafeAreaView:'SafeAreaView'},
  'expo-router':{router:{push:()=>assert.fail('onboarding should finish without another step')}},
  '../../store/OnboardingContext':onboarding,
  '../../store/AuthContext':{useAuth:()=>({user:{user_id:'viewer'},onboardingSave:{status:'idle'},
   completeOnboarding:async(data:any)=>saved.push(data),checkOnboardingStatus:async()=>{}})},
  '../../components/onboarding/GitHubImportPanel':{GitHubImportPanel:()=>React.createElement('ImportPanel')},
  './GitHubImportPanel':{GitHubImportPanel:()=>React.createElement('ImportPanel')},
  '@/components/keyboard/keyboard-layout':{KeyboardForm:'Form'},
  '@/components/onboarding/PrimaryButton':(props:any)=>React.createElement('PrimaryButton',props),
  ...Object.fromEntries(['LogoPlaceholder','SkillCard','ProgressBar'].map(name=>[
   `@/components/onboarding/${name}`,()=>null])),
  '@/constants/onboarding':{SKILL_CATEGORIES:[]},
 });
 function Probe(){draft=onboarding.useOnboarding().data;return React.createElement(screen.default);}
 let root!:ReturnType<typeof create>;
 try{
  await act(async()=>{root=create(React.createElement(onboarding.OnboardingProvider,null,React.createElement(Probe)));});
  assert.equal(root.root.findAllByType('ImportPanel' as any).length,0,'GitHub import is optional and stays unloaded');
  assert.equal(root.root.findByProps({title:'Finish'}).props.disabled,true);
  assert.equal(root.root.findAllByProps({accessibilityRole:'checkbox'}).length,7,'only broad topics are offered');
  await act(async()=>root.root.findByProps({accessibilityLabel:'AI & ML'}).props.onKeyDown({key:' ',repeat:false,preventDefault(){}}));
  assert.equal(root.root.findByProps({accessibilityLabel:'AI & ML'}).props['aria-checked'],true);
  assert.deepEqual(draft.skills,['data']);assert.deepEqual(draft.interests,['machine learning']);
  await act(async()=>root.root.findByType('TextInput' as any).props.onChangeText(' Python, PyTorch, '));
  await act(async()=>root.root.findByProps({title:'Finish'}).props.onPress());
  assert.equal(saved.length,1);assert.deepEqual(saved[0].skills,['data']);
  assert.deepEqual(saved[0].interests,['machine learning']);assert.deepEqual(saved[0].tech_stack,['Python','PyTorch']);
 }finally{await act(async()=>root?.unmount());}
});

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
  const step=loadSource('src/components/onboarding/PreferencesScreen.tsx',{
   'lucide-react-native':{Check:()=>null},
   'react-native':{...native,Platform:{OS:'web'},Pressable:'Pressable',TextInput:'TextInput'},'./GitHubImportPanel':{GitHubImportPanel:()=>null},'../../store/AuthContext':{useAuth:()=>app.auth},
   '../../store/OnboardingContext':{useOnboarding:()=>({data:finishData,updateData:()=>{}})},
   '@/components/keyboard/keyboard-layout':{KeyboardForm:(props:any)=>React.createElement('Form',props)},
   '@/components/onboarding/PrimaryButton':(props:any)=>React.createElement('PrimaryButton',props),
   '@/components/onboarding/ProgressBar':blank,'@/components/onboarding/TechChip':blank,
   '@/components/onboarding/LogoPlaceholder':blank,'@/components/onboarding/StepHeader':blank,
   '@/constants/onboarding':{SKILL_CATEGORIES:[],INTEREST_CATEGORIES:ONBOARDING_INTERESTS},
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

test('the GitHub popup has only Revoke and Disconnect, then offers Reconnect after unlinking', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let linked = true, active = true, reconnects = 0, pending = false, failRead = false, loseDisconnect = false, loseReconnect = false, failRefresh = false, refreshes = 0, unlinkOperation = 0;
  const client = new QueryClient();
  client.setQueryData(['feed', 'viewer'], { pages: ['old-familiar-card'] });
  client.setQueryData(['feed', 'other'], { pages: ['other-account'] });
  const api = { status: async () => {if(failRead)throw new Error('Offline');return { linked, active, provenance: {} };}, revoke: async () => { active = false; } };
  const native = { ...Object.fromEntries(['View','Text','Pressable','ActivityIndicator','Modal','ScrollView'].map(name=>[name,name])),
    StyleSheet: { create: (value: unknown) => value, absoluteFill: {} }, useWindowDimensions: () => ({ height: 800 }) };
  const theme = { APP_THEME: {}, REFERENCE_THEME: {}, Fonts: {}, Spacing: {} };
  const mocks = { 'react-native': native, 'react-native-safe-area-context': { useSafeAreaInsets: () => ({top:0,bottom:0}) },
    'react-native-reanimated': { useReducedMotion: () => true }, 'lucide-react-native': { X:'X' },
    '@/assets/icons/github.svg': { __esModule: true, default: 'GitHubIcon' }, '../../constants/theme': theme,
    '../../hooks/use-modal-scroll-lock': { useModalScrollLock() {} },
    '../../api/githubImport': { githubImportApi: api }, '../../api/githubUnlink': { githubUnlinkApi: { status: async () => ({status:linked?(pending?'pending':'none'):'done',operation_id:unlinkOperation?`unlink-${unlinkOperation}`:undefined}) } },
    '../../services/githubUnlink': { startGithubUnlink: async () => {pending=true;unlinkOperation++;if(loseDisconnect){linked=false;throw new Error('Response lost');}return {status:'pending',message:'Provider confirmation is pending.'};} },
    '../../services/githubReconnect': { startGithubReconnect: async (owner:string) => {assert.equal(owner,'viewer');linked=true;pending=false;reconnects++;if(loseReconnect){failRead=true;throw new Error('Response lost');}return true;} },
    '@tanstack/react-query': { useQueryClient: () => client },
    '../../utils/feed-repository': feedRepository,
  };
  const panel=loadSource('src/components/profile/GitHubPreferencesPopup.tsx',mocks).GitHubPreferencesPopup;
  let root!:ReturnType<typeof create>;
  await act(async()=>{root=create(React.createElement(panel,{visible:true,userId:'viewer',onClose(){},onSaved:async()=>{refreshes++;}}));});
  const buttons=()=>root.root.findAllByType('Pressable').filter(n=>!['Dismiss GitHub preferences','Close GitHub preferences'].includes(n.props.accessibilityLabel));
  const press=async(label:string)=>act(async()=>{buttons().find(n=>n.props.accessibilityLabel===label)!.props.onPress();await new Promise(r=>setImmediate(r));});
  try {
    assert.deepEqual(buttons().map(n=>n.props.accessibilityLabel),['Revoke','Disconnect']);
    await press('Revoke');assert.equal(buttons()[0].props.disabled,true);
    assert.equal(client.getQueryData(['feed','viewer']), undefined);
    assert.deepEqual(client.getQueryData(['feed','other']), { pages: ['other-account'] });
    await press('Disconnect');
    assert.equal(buttons()[1].props.disabled,true, 'pending disconnect reconciles automatically');
    assert.ok(JSON.stringify(root.toJSON()).includes('Provider confirmation is pending.'));
    for(let i=0;i<5;i++)await act(async()=>{t.mock.timers.tick(2_001);await new Promise(r=>setImmediate(r));});
    assert.ok(JSON.stringify(root.toJSON()).includes('Verification is still pending.'));
    assert.deepEqual(buttons().map(n=>n.props.accessibilityLabel),['Revoke','Verify disconnect']);
    client.setQueryData(['feed','viewer'], { pages: ['loaded-while-disconnecting'] });
    linked=false;active=false;
    await press('Verify disconnect');
    assert.deepEqual(buttons().map(n=>n.props.accessibilityLabel),['Revoke','Reconnect']);
    assert.equal(client.getQueryData(['feed','viewer']),undefined);
    await press('Reconnect');assert.equal(reconnects,1);assert.deepEqual(buttons().map(n=>n.props.accessibilityLabel),['Revoke','Disconnect']);
    assert.equal(JSON.stringify(root.toJSON()).includes('GitHub authorization settings'),false);
    // A failed initial read must never guess that GitHub is linked.
    await act(async()=>root.update(React.createElement(panel,{visible:false,userId:'viewer'})));
    failRead=true;
    const props={visible:true,userId:'viewer',onClose(){},onSaved:async()=>{if(failRefresh)throw new Error('Offline');refreshes++;}};
    await act(async()=>root.update(React.createElement(panel,props)));
    assert.deepEqual(buttons().map(n=>n.props.accessibilityLabel),['Revoke','Retry connection']);
    failRead=false;linked=false;active=false;
    client.setQueryData(['feed','viewer'],{pages:['stale-after-lost-response']});
    await press('Retry connection');
    assert.deepEqual(buttons().map(n=>n.props.accessibilityLabel),['Revoke','Reconnect']);
    assert.equal(client.getQueryData(['feed','viewer']),undefined);
    await act(async()=>root.root.findByProps({accessibilityLabel:'Close GitHub preferences'}).props.onPress());
    assert.equal(refreshes,1,'a completed initial status read refreshes shared account state on close');
    await act(async()=>root.update(React.createElement(panel,{...props,visible:false})));
    await act(async()=>root.update(React.createElement(panel,props)));
    await press('Reconnect');
    loseDisconnect=true;
    client.setQueryData(['feed','viewer'],{pages:['stale-before-uncertain-unlink']});
    await press('Disconnect');
    await act(async()=>{t.mock.timers.tick(2_001);await new Promise(r=>setImmediate(r));});
    assert.deepEqual(buttons().map(n=>n.props.accessibilityLabel),['Revoke','Reconnect'],'a lost disconnect response is reconciled automatically');
    assert.equal(client.getQueryData(['feed','viewer']),undefined);
    await act(async()=>root.root.findByProps({accessibilityLabel:'Close GitHub preferences'}).props.onPress());
    await t.test('reopening an already reconciled disconnect preserves loaded Home',async()=>{
      await act(async()=>root.update(React.createElement(panel,{...props,visible:false})));
      t.mock.timers.tick(6*60_000);
      client.setQueryData(['feed','viewer'],{pages:['fresh-after-disconnect'],pageParams:[null,'cursor-2']});
      const loaded=client.getQueryData(['feed','viewer']);
      const refreshed=refreshes;
      await act(async()=>root.update(React.createElement(panel,props)));
      assert.equal(client.getQueryData(['feed','viewer']),loaded,'reading the same completed operation must preserve loaded pages and cursor');
      await act(async()=>root.root.findByProps({accessibilityLabel:'Close GitHub preferences'}).props.onPress());
      assert.equal(refreshes,refreshed,'unchanged settings do not refresh the account again');
    });
    await t.test('closing during reconciliation cannot mark an unapplied change as handled',async()=>{
      await act(async()=>root.update(React.createElement(panel,{...props,visible:false})));
      unlinkOperation++;
      const gate=deferred<void>(),started=deferred<void>();
      const cancel=client.cancelQueries.bind(client);
      const held=t.mock.method(client,'cancelQueries',async(...args:Parameters<typeof client.cancelQueries>)=>{started.resolve();await gate.promise;return cancel(...args);});
      await act(async()=>{root.update(React.createElement(panel,props));});
      await started.promise;
      await act(async()=>root.update(React.createElement(panel,{...props,visible:false})));
      await act(async()=>{gate.resolve();await new Promise(r=>setImmediate(r));});
      held.mock.restore();
      client.setQueryData(['feed','viewer'],{pages:['stale-before-interrupted-reconciliation']});
      await act(async()=>root.update(React.createElement(panel,props)));
      assert.equal(client.getQueryData(['feed','viewer']),undefined,'reopening finishes the interrupted retirement');
      await act(async()=>root.root.findByProps({accessibilityLabel:'Close GitHub preferences'}).props.onPress());
    });
    await t.test('manual verification refreshes a reconnect whose response and automatic checks were lost',async()=>{
      await act(async()=>root.update(React.createElement(panel,{...props,visible:false})));
      await act(async()=>root.update(React.createElement(panel,props)));
      const refreshed=refreshes;
      loseReconnect=true;
      await press('Reconnect');
      for(let i=0;i<5;i++)await act(async()=>{t.mock.timers.tick(2_001);await new Promise(r=>setImmediate(r));});
      assert.equal(buttons()[1].props.accessibilityLabel,'Verify connection');
      client.setQueryData(['feed','viewer'],{pages:['stale-before-verified-reconnect']});
      failRead=false;
      await press('Verify connection');
      assert.equal(buttons()[1].props.accessibilityLabel,'Disconnect');
      assert.equal(client.getQueryData(['feed','viewer']),undefined,'linked false-to-true must retire Home even when unlink status is none');
      failRefresh=true;
      await act(async()=>root.root.findByProps({accessibilityLabel:'Close GitHub preferences'}).props.onPress());
      assert.ok(JSON.stringify(root.toJSON()).includes('Could not refresh your account'));
      assert.equal(refreshes,refreshed);
      await act(async()=>root.update(React.createElement(panel,{...props,visible:false})));
      client.setQueryData(['feed','viewer'],{pages:['loaded-after-verified-reconnect']});
      await act(async()=>root.update(React.createElement(panel,props)));
      assert.deepEqual(client.getQueryData(['feed','viewer']),{pages:['loaded-after-verified-reconnect']});
      failRefresh=false;
      await act(async()=>root.root.findByProps({accessibilityLabel:'Close GitHub preferences'}).props.onPress());
      assert.equal(refreshes,refreshed+1,'verified reconnect still refreshes the shared account after a failed close and reopen');
      assert.deepEqual(client.getQueryData(['feed','other']),{pages:['other-account']});
    });
  }finally{await act(async()=>root.unmount());}
});

test('profile GitHub activity preview, acceptance and revocation keep the login connected', async () => {
  const native = Object.fromEntries(['View', 'Text', 'Pressable', 'ActivityIndicator'].map(name => [name, name]));
  const theme = { APP_THEME: {}, REFERENCE_THEME: {}, Fonts: {}, Spacing: { two: 8, three: 12 } };
  const calls: string[] = [];
  let refreshes = 0;
  const client = new QueryClient();
  client.setQueryData(['feed','viewer'], { pages: ['old-familiar-card'] });
  const panel = loadSource('src/components/onboarding/GitHubImportPanel.tsx', {
    '@tanstack/react-query': { useQueryClient: () => client },
    '../../utils/feed-repository': feedRepository,
    'react-native': native, '../../constants/theme': theme,
    '../../api/githubImport': { githubImportApi: {
      status: async () => ({ linked: true, active: false, provenance: {} }),
      preview: async () => { calls.push('preview'); return { snapshot_id: 'preview', collected_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(), repository_count: 2, status: 'complete', suggestions: { skills: ['typescript'], interests: [], tech_stack: [] } }; },
      accept: async () => { calls.push('accept'); }, revoke: async () => { calls.push('revoke'); },
    } },
  }).GitHubImportPanel;
  let renderer!: ReturnType<typeof create>;
  const press = (label: string) => act(async () => { renderer.root.findByProps({ accessibilityLabel: label }).props.onPress(); });
  await act(async () => { renderer = create(React.createElement(panel, { userId: 'viewer', onSaved: async () => { refreshes++; } })); });
  try {
    await press('Preview public activity');
    assert.ok(JSON.stringify(renderer.toJSON()).includes('typescript'));
    await press('Add these preferences');
    assert.equal(client.getQueryData(['feed','viewer']), undefined, 'accepted import retires familiar cached cards');
    client.setQueryData(['feed','viewer'], { pages: ['cached-before-revoke'] });
    assert.equal(renderer.root.findByProps({ accessibilityLabel: 'Revoke activity import' }).props.disabled, false);
    await press('Revoke activity import');
    assert.equal(client.getQueryData(['feed','viewer']), undefined);
    assert.equal(renderer.root.findAllByProps({ accessibilityLabel: 'Revoke activity import' }).length, 0);
    await press('Show import option');
    assert.equal(renderer.root.findByProps({ accessibilityLabel: 'Preview public activity' }).props.disabled, false, 'revocation preserves the verified login');
    assert.deepEqual(calls, ['preview', 'accept', 'revoke']); assert.equal(refreshes, 2);
  } finally { await act(async () => renderer.unmount()); }
});

test('GitHub disconnect requires confirmation and automatically reconciles a pending result', async () => {
  const native = Object.fromEntries(['View', 'Text', 'ScrollView', 'Pressable', 'ActivityIndicator'].map(name => [name, name]));
  const theme = { APP_THEME: {}, REFERENCE_THEME: {}, Fonts: {}, Spacing: { two: 8, three: 12, four: 16 } };
  let authorizationCalls = 0, pending = false, refreshes = 0;
  const panel = loadSource('src/components/onboarding/GitHubUnlinkPanel.tsx', {
    'react-native': native, 'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0 }) }, '../../constants/theme': theme,
    '../../api/githubUnlink': { githubUnlinkApi: { status: async () => ({ status: pending ? 'done' : 'none' }) } },
    '../../services/githubUnlink': { startGithubUnlink: async () => { authorizationCalls++; pending = true; return { status: 'pending', retryable: true }; } },
  }).GitHubUnlinkPanel;
  let renderer!: ReturnType<typeof create>;
  const press = (label: string) => act(async () => { renderer.root.findByProps({ accessibilityLabel: label }).props.onPress(); });
  await act(async () => { renderer = create(React.createElement(panel, { userId: 'viewer', linked: true, onSaved: async () => { refreshes++; } })); });
  try {
    await press('Disconnect GitHub login'); assert.equal(authorizationCalls, 0);
    await press('Keep GitHub login'); assert.equal(authorizationCalls, 0);
    await press('Disconnect GitHub login'); await press('Reauthenticate and disconnect GitHub');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2_150)); });
    assert.ok(JSON.stringify(renderer.toJSON()).includes('GitHub login disconnected.'));
    assert.equal(renderer.root.findAllByProps({ accessibilityLabel: 'Check disconnect status' }).length, 0);
    assert.equal(authorizationCalls, 1); assert.equal(refreshes, 2);
    await act(async () => renderer.update(React.createElement(panel, { userId: 'other', linked: false, onSaved: async () => undefined })));
    assert.equal(renderer.root.findAllByProps({ accessibilityLabel: 'Disconnect GitHub login' }).length, 0);
  } finally { await act(async () => renderer.unmount()); }
});

test('automatic disconnect verification stops after bounded retries and cancels on close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const native = Object.fromEntries(['View', 'Text', 'ScrollView', 'Pressable', 'ActivityIndicator'].map(name => [name, name]));
  let checks = 0, offline = true;
  const panel = loadSource('src/components/onboarding/GitHubUnlinkPanel.tsx', {
    'react-native': native, 'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0 }) },
    '../../constants/theme': { APP_THEME: {}, REFERENCE_THEME: {}, Fonts: {}, Spacing: {} },
    '../../api/githubUnlink': { githubUnlinkApi: { status: async () => { checks++; if(offline)throw new Error('Offline');return { status: 'pending', retryable: false }; } } },
    '../../services/githubUnlink': { startGithubUnlink: async () => null },
  }).GitHubUnlinkPanel;
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(React.createElement(panel, { userId: 'viewer', recoveryOnly: true, onSaved: async () => undefined })); });
  try {
    for (let i = 0; i < 6; i++) await act(async () => t.mock.timers.tick(2_001));
    assert.equal(checks, 6, 'one initial read and five automatic checks');
    assert.ok(JSON.stringify(renderer.toJSON()).includes('Offline'));
    offline=false;
    await act(async()=>renderer.root.findByProps({accessibilityLabel:'Retry verification'}).props.onPress());
    assert.equal(checks,7);
    for(let i=0;i<5;i++)await act(async()=>t.mock.timers.tick(2_001));
    assert.equal(checks,12,'manual recovery starts one new bounded attempt');
    assert.ok(JSON.stringify(renderer.toJSON()).includes('Verification is still pending.'));
    await act(async () => t.mock.timers.tick(60_000)); assert.equal(checks, 12, 'pending work must not poll indefinitely');
    await act(async () => renderer.update(React.createElement(panel, { userId: 'other', onSaved: async () => undefined })));
    assert.equal(checks, 13);
  } finally { await act(async () => renderer.unmount()); }
  await act(async () => t.mock.timers.tick(60_000)); assert.equal(checks, 13, 'closing the panel cancels its scheduled check');
});

for (const manualMode of [false, true]) {
test(`mounted onboarding recovery preserves drafts and refreshes controls (manualMode=${manualMode})`, async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let linked = true, reads = 0, refreshes = 0;
  const submitted: any[] = [];
  const native = {...Object.fromEntries(['View', 'Text', 'ScrollView', 'Pressable', 'ActivityIndicator', 'TextInput'].map(name => [name, name])), Platform: { OS: 'web' }};
  const safeArea = { SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 59, bottom: 0, left: 0, right: 0 }) };
  const theme = { APP_THEME: {}, REFERENCE_THEME: {}, Fonts: {}, Spacing: { two: 8, three: 12, four: 16 } };
  const auth = { useAuth: () => ({ user: { user_id: 'viewer' }, onboardingSave: { status: 'idle' }, completeOnboarding: async (data: any) => { submitted.push(data); }, checkOnboardingStatus: async () => { refreshes++; } }) };
  const onboarding = loadSource('src/store/OnboardingContext.tsx', {});
  const importPanel = loadSource('src/components/onboarding/GitHubImportPanel.tsx', {
    '@tanstack/react-query': { useQueryClient: () => new QueryClient() },
    '../../utils/feed-repository': feedRepository,
    'react-native': native, '../../constants/theme': theme,
    '../../api/githubImport': { githubImportApi: { status: async () => { reads++; return { linked, active: false, provenance: {} }; } } },
  });
  const unlinkPanel = loadSource('src/components/onboarding/GitHubUnlinkPanel.tsx', {
    'react-native': native, 'react-native-safe-area-context': safeArea, '../../constants/theme': theme,
    '../../api/githubUnlink': { githubUnlinkApi: { status: async () => ({ status: linked ? 'pending' : 'done' }) } },
    '../../services/githubUnlink': { startGithubUnlink: async () => null },
  });
  const blank = () => null;
  const step = loadSource('src/components/onboarding/PreferencesScreen.tsx', {
    'lucide-react-native': { Check: () => null },
    'react-native': native, 'react-native-safe-area-context': safeArea,
    '@/components/keyboard/keyboard-layout': { KeyboardForm: 'Form' },
    '@/components/onboarding/PrimaryButton': (props: any) => React.createElement('PrimaryButton', props), '@/components/onboarding/ProgressBar': blank,
    '@/components/onboarding/SkillCard': (props: any) => React.createElement('SkillCard', props), '@/components/onboarding/LogoPlaceholder': blank,
    '@/constants/onboarding': { SKILL_CATEGORIES: [{ id: 'data', title: 'Data' }, { id: 'systems', title: 'Systems' }] },
    '../../store/OnboardingContext': onboarding, '../../store/AuthContext': auth,
    './GitHubImportPanel': importPanel,
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
    assert.ok(!JSON.stringify(renderer.toJSON()).includes('Preview public activity'));
    if (!manualMode) {
      await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Use GitHub public activity instead' }).props.onPress());
      assert.ok(JSON.stringify(renderer.toJSON()).includes('Preview public activity'));
    }
    const recovery = renderer.root.findAllByType('ScrollView' as any).find(node => node.props.style?.maxHeight === '45%');
    assert.ok(recovery, 'pending recovery remains bounded above the onboarding step');
    assert.equal(recovery.props.contentContainerStyle.paddingTop, 59, 'recovery respects the top safe-area inset');
    await act(async () => { current.updateData({ username: 'draft-name', bio: 'draft-bio' }); });
    if (manualMode) {
      await act(async () => {
        renderer.root.findByProps({ accessibilityLabel: 'AI & ML' }).props.onPress();
        renderer.root.findByProps({ accessibilityLabel: 'Systems' }).props.onPress();
      });
      assert.deepEqual(current.data.skills, ['data', 'systems']);
    }
    const before = reads;
    linked = false;
    assert.equal(renderer.root.findAllByProps({ accessibilityLabel: 'Check disconnect status' }).length, 0);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2_150)); });
    if (!manualMode) assert.ok(reads > before, 'the mounted import panel must reload after recovery refresh');
    else {
      assert.deepEqual(current.data.skills, ['data', 'systems'], 'recovery must retain selected topics');
      assert.equal(renderer.root.findByType('PrimaryButton' as any).props.disabled, false);
      assert.deepEqual(current.data.interests, ['machine learning', 'system']);
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
      assert.equal(submitted.length, 1, 'Finish submits directly without an intermediate route');
      assert.equal(submitted[0].username, 'draft-name');
      assert.equal(submitted[0].bio, 'draft-bio');
      assert.deepEqual(submitted[0].interests, ['machine learning', 'system']);
    }
  } finally {
    await act(async () => renderer?.unmount());
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  }
});

}
