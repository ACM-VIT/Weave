import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { settleFollowCache } from '../src/services/followMutationCache';
import { authSessionLifecycle } from '../src/api/session-lifecycle';
import { followStateQueryKey, getProfileFollowIdentity } from '../src/utils/follow-state';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  let finish!: () => void; let fail!: (e: Error) => void;
  let viewer = 'alice'; let requests = 0;
  let serverFollowing=false; let serverUpdatedAt: number | undefined;
  const filename = resolve('src/components/follow-button.tsx');
  const require = createRequire(filename);
  const mocks: Record<string, any> = {
    'react-native': { StyleSheet: { create: (x: unknown) => x }, ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', Text: 'Text' },
    '@/api/connections': { setUserFollowing: () => { requests++; return new Promise<void>((yes, no) => {finish = yes; fail = no;}); } },
    '@/api/social-profiles': { setSocialProfileFollowing: () => { throw new Error('Unexpected profile follow'); } },
    '@/constants/theme': { REFERENCE_THEME: {} },
    '@/utils/follow-state': { followStateQueryKey, getProfileFollowIdentity },
    '@/utils/storage': { getStorageItem: async () => 'synthetic-token' },
    '@/store/AuthContext': { useAuth: () => ({ user: { user_id: viewer } }) },
    '@/api/session-lifecycle': { authSessionLifecycle },
    '@/services/followMutationCache': { settleFollowCache },
  };
  const module = { exports: {} as any };
  const js = ts.transpileModule(readFileSync(filename, 'utf8'), {compilerOptions:{ module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }}).outputText;
  new Function('require', 'module', 'exports', js)((s: string) => s in mocks ? mocks[s] : require(s), module, module.exports);
  const Button = module.exports.FollowButton;
  let root!: ReturnType<typeof create>;
  const tree = (count = 1, offset = 0) => React.createElement(QueryClientProvider, { client },
    Array.from({length:count}, (_, key) => React.createElement(Button, {key:key+offset, targetUserId:'target', isFollowing:serverFollowing, stateUpdatedAt:serverUpdatedAt})));
  return { client, get requests(){return requests;}, get buttons(){return root.root.findAllByType('Pressable');},
    async mount(count=1){ await act(async()=>{root=create(tree(count));}); },
    async update(count:number){await act(async()=>root.update(tree(count)));},
    async freshRemount(following:boolean,updatedAt:number){serverFollowing=following;serverUpdatedAt=updatedAt;await act(async()=>{root.update(tree(1,100));await new Promise(r=>setTimeout(r,5));});},
    async removeInitiator(){await act(async()=>root.update(tree(1,1)));},
    async press(){await act(async()=>{this.buttons[0].props.onPress(); await new Promise(r=>setTimeout(r,5));});},
    async succeed(){await act(async()=>{finish(); await new Promise(r=>setTimeout(r,5));});},
    async reject(){await act(async()=>{fail(new Error('offline')); await new Promise(r=>setTimeout(r,5));});},
    async changeAccountAndFail(){await act(async()=>{authSessionLifecycle.retire(authSessionLifecycle.currentGeneration());client.clear();viewer='bob';root.update(tree());fail(new Error('late failure'));await new Promise(r=>setTimeout(r,5));});},
    async close(){await act(()=>root.unmount());client.clear();},
  };
}

test('mounted follow controls share pending state; stale initial props do not undo success', async()=>{
  const f=harness();await f.mount();await f.press();
  assert.equal(f.requests,1);await f.update(2);
  assert.equal(f.buttons[1].props.accessibilityState.selected,true);
  assert.equal(f.buttons[1].props.disabled,true);
  await f.succeed();
  assert.equal(f.buttons[0].props.accessibilityState.selected,true);
  assert.equal(f.buttons[1].props.accessibilityState.selected,true);
  await f.close();
});

test('a late failed follow cannot repopulate the retired viewer cache',async()=>{
  const f=harness();await f.mount();await f.press();await f.changeAccountAndFail();
  assert.equal(f.client.getQueryData(followStateQueryKey('target','alice')),undefined);
  assert.equal(f.client.getQueryData(followStateQueryKey('target','bob')),false);
  await f.close();
});

test('follow invalidation reloads affected connections only and never refetches cached Home pages',async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity,staleTime:Infinity}}});
  const reads=new Map<string,number>();const stops:(()=>void)[]=[];
  for(const key of [['feed','alice'],['feed','bob'],['connections','alice','following'],['connections','unrelated','followers']] as const){
    const id=JSON.stringify(key);const observer=new QueryObserver(client,{queryKey:key,queryFn:async()=>{reads.set(id,(reads.get(id)??0)+1);return {pages:[{items:[{repo_id:'r',owner_user_id:'target',viewer_follows_owner:false}]}]};}});
    stops.push(observer.subscribe(()=>{}));await observer.refetch();
  }
  client.setQueryData(['public-user-profile','user','target'],{kind:'user',data:{viewer_follows_user:false,followers_count:3}});
  const before=new Map(reads);
  await settleFollowCache(client,'alice',{userId:'target'},true,authSessionLifecycle.currentGeneration());
  assert.equal(reads.get('["feed","alice"]'),before.get('["feed","alice"]'));
  assert.equal(reads.get('["feed","bob"]'),before.get('["feed","bob"]'));
  assert.equal(reads.get('["connections","unrelated","followers"]'),before.get('["connections","unrelated","followers"]'));
  assert.equal(reads.get('["connections","alice","following"]'),before.get('["connections","alice","following"]')!+1);
  assert.equal((client.getQueryData<any>(['feed','alice'])).pages[0].items[0].viewer_follows_owner,true);
  assert.equal(client.getQueryData<any>(['public-user-profile','user','target']).data.followers_count,4);
  await settleFollowCache(client,'alice',{userId:'target'},false,authSessionLifecycle.currentGeneration());
  assert.equal(client.getQueryData<any>(['public-user-profile','user','target']).data.followers_count,3);
  assert.equal(reads.get('["feed","alice"]'),before.get('["feed","alice"]'));
  assert.equal(reads.get('["connections","unrelated","followers"]'),before.get('["connections","unrelated","followers"]'));
  for(const stop of stops)stop();client.clear();
});

test('failed follow rolls back the shared viewer state for every mounted control', async()=>{
  const f=harness();await f.mount(2);await f.press();
  assert.ok(f.buttons.every(button=>button.props.accessibilityState.selected));
  await f.reject();
  assert.ok(f.buttons.every(button=>button.props.accessibilityState.selected===false));
  assert.equal(f.requests,1);await f.close();
});

test('failed follow rolls back remaining screens after the initiating button unmounts',async()=>{
 const f=harness();await f.mount(2);await f.press();await f.removeInitiator();await f.reject();
 assert.equal(f.buttons[0].props.accessibilityState.selected,false);await f.close();
});


test('newly mounted control accepts fresher server relationship but ignores older props',async()=>{
 const f=harness(); await f.mount();
 const key=followStateQueryKey('target','alice');
 f.client.setQueryData(key,true,{updatedAt:Date.now()-100});
 await f.freshRemount(false,Date.now()+100);
 assert.equal(f.buttons[0].props.accessibilityState.selected,false);
 await f.freshRemount(true,Date.now()-1000);
 assert.equal(f.buttons[0].props.accessibilityState.selected,false);
 await f.close();
});

test('settled follow patches viewer flags in cached unrelated connection rows without a request',async()=>{
 const client=new QueryClient();
 const key=['connections','alice','followers'];
 client.setQueryData(key,{pages:[{items:[{user_id:'target',profile_id:'profile',viewer_follows_user:true,viewer_follows_profile:true},{user_id:'other',viewer_follows_user:true}]}]});
 await settleFollowCache(client,'alice',{userId:'target'},false,authSessionLifecycle.currentGeneration());
 const rows=client.getQueryData<any>(key).pages[0].items;
 assert.equal(rows[0].viewer_follows_user,false);assert.equal(rows[0].viewer_follows_profile,false);
 assert.equal(rows[1].viewer_follows_user,true);client.clear();
});
