import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import React, { act, useEffect, useImperativeHandle } from 'react';
import { create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ts from 'typescript';
import { DurableActivityOutbox } from '../src/services/activityOutbox';
import { IncrementalActivityStorage, type ActivityRecordFileSystem } from '../src/services/activityOutboxRecordStorage';
import { SessionLifecycle, SessionChangedError } from '../src/api/session-lifecycle';
import type { QueuedActivity, ActivityInput } from '../src/api/activity';

const ownerA='00000000-0000-4000-8000-000000000001',ownerB='00000000-0000-4000-8000-000000000002';
const repo='00000000-0000-4000-8000-000000000003',session='00000000-0000-4000-8000-000000000004';
const serve='00000000-0000-4000-8000-000000000005',eventId='00000000-0000-4000-8000-000000000006';
const input={repo_id:repo,action:'like' as const,serve_id:serve,position:4,session_id:session};
const expected={...input,event_id:eventId,client_occurred_at:'2026-10-24T00:00:00.123Z'};
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));

// Actual Home hooks, React Query, durable outbox and incremental record protocol.
// Only native rendering, UUID/time, file I/O and transport boundaries are replaced.
async function fixture(t:test.TestContext){
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const lifecycle=new SessionLifecycle(),files=new Map<string,string>();
 let owner=ownerA,quota=false,offline=false,failRemoval=false,clock=10000,prepared=0,mounts=0,tokenWait:Promise<void>|undefined;
 let connectivity:(state:{isConnected:boolean;isInternetReachable:boolean})=>void=()=>{};
 const sent:{token:string;events:QueuedActivity[]}[]=[];
 const fs:ActivityRecordFileSystem={exists:path=>files.has(path),read:async path=>files.get(path)!,
  writeFresh:(path,value)=>{if(quota)throw new Error('Storage quota exceeded');files.set(path,value);},
  move:async(source,destination)=>{files.set(destination,files.get(source)!);files.delete(source);},
  list:async()=>[...files.keys()],remove:async path=>{if(failRemoval)throw new Error('Fixture acknowledgement storage failure');files.delete(path);}};
 const storage=new IncrementalActivityStorage(fs,async()=>[]);await storage.load();
 const outboxes=new Map<string,DurableActivityOutbox>();
 const outbox=new DurableActivityOutbox({load:()=>storage.load(),append:event=>storage.append(event),acknowledge:ids=>storage.acknowledge(ids),
  now:()=>clock,prepare:event=>{prepared++;return {...event,event_id:prepared===1?eventId:'00000000-0000-4000-8000-000000000007',session_id:session,client_occurred_at:expected.client_occurred_at};},
  session:{capture:()=>lifecycle.currentGeneration(),assertCurrent:(token,generation)=>{lifecycle.assertCurrent(generation);if(token!==ownerA)throw new SessionChangedError();}},
  send:async(events,token)=>{assert.deepEqual(await storage.load(),events,'transport sees only exact committed records');sent.push({token,events:structuredClone(events)});
   if(offline)throw new Error('Offline');return {accepted:events.length,duplicates:0,feed_version:'2',results:events.map(event=>({event_id:event.event_id,status:'accepted' as const}))};}});
 outboxes.set(ownerA,outbox);
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
 let loadPage:(...args:any[])=>Promise<any>;
 let resetSession:string|undefined;
 const page={items:[{repo_id:repo,full_name:'fixture/project',serve_id:serve,position:4,feed_session_id:session}],nextCursor:null,feedVersion:'1',sessionId:session,mode:'personalized'};
 loadPage=async()=>page;
 for(const id of [ownerA,ownerB])client.setQueryData(['feed',id],{pages:[page],pageParams:[null]});
 const auth={checkOnboardingStatus:async()=>{},adjustLikesGivenCount(){},settleLikesGivenCountAdjustments(){}};
 const FlatList=React.forwardRef(function FixtureFlatList(props:any,ref){useImperativeHandle(ref,()=>({scrollToOffset(){}}));return React.createElement('FlatList',null,props.data.map((item:any,index:number)=>React.createElement(React.Fragment,{key:props.keyExtractor(item)},props.renderItem({item,index}))));});
 function Card(props:any){useEffect(()=>{mounts++;},[]);return React.createElement('Card',props);}
 const filename=resolve('src/app/(tabs)/home.tsx'),nativeRequire=createRequire(filename);
 const mocks:Record<string,unknown>={
  'react-native':{FlatList,View:'View',Text:'Text',Pressable:'Pressable',ActivityIndicator:'ActivityIndicator',AppState:{addEventListener:()=>({remove(){}})},Platform:{OS:'web'},StyleSheet:{create:(styles:unknown)=>styles},useWindowDimensions:()=>({width:400,height:800})},
  '@/components/responsive-layout':{getResponsiveContentWidth:()=>400},'@/components/home/RepositoryFeedItem':{RepositoryFeedItem:Card},'@/components/home/FeedHeader':{FeedHeader:(props:any)=>React.createElement('FeedHeader',props)},
  '@/constants/theme':{REFERENCE_THEME:{}},'expo-router':{router:{push(){}},useFocusEffect:(callback:any)=>useEffect(callback,[])},
  '../../utils/storage':{getItemAsync:async()=>{await tokenWait;return owner;}},
  '@/api/feed-sessions':{feedSessions:()=>({prepare:async(id:string)=>id,reset:async(id:string)=>{resetSession=id;return true;}})},
  '@/api/home-feed':{fetchHomeFeed:(...args:any[])=>loadPage(...args)},'@/api/session-lifecycle':{authSessionLifecycle:lifecycle},
  '@/store/AuthContext':{useAuth:()=>({...auth,user:{user_id:owner}})},
  '@/services/activityOutboxClient':{getActivityOutbox:(id:string)=>outboxes.get(id)??null},
  '@react-native-community/netinfo':{useNetInfo:()=>({isConnected:true,isInternetReachable:true}),addEventListener:(listener:typeof connectivity)=>{connectivity=listener;return ()=>{};}},
 };
 const {loadSource}=await import('./support/startup-harness');
 mocks['@/hooks/use-browse-prefetch']={useBrowsePrefetch(){}};
 mocks['@/services/homeFeedQuery']=loadSource('src/services/homeFeedQuery.ts',{
  '../utils/storage':{getStorageItem:async()=>owner},'../api/access-token-owner':{accessTokenOwner:()=>owner},
  '../api/session-lifecycle':{authSessionLifecycle:lifecycle,SessionChangedError},
  '../api/feed-sessions':mocks['@/api/feed-sessions'],'../api/home-feed':mocks['@/api/home-feed'],
 });
 const javascript=ts.transpileModule(readFileSync(filename,'utf8'),{fileName:filename,compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const mod:{exports:any}={exports:{}};new Function('require','module','exports',javascript)((name:string)=>name in mocks?mocks[name]:nativeRequire(name),mod,mod.exports);
 let root!:ReturnType<typeof create>;
 const render=()=>React.createElement(QueryClientProvider,{client},React.createElement(mod.exports.default));
 await act(async()=>{root=create(render());await tick();});
 t.after(async()=>{await act(async()=>{root.unmount();await tick();});client.clear();delete(globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
 const retry=()=>root.root.findAllByType('Pressable' as any).find(node=>node.props.accessibilityLabel==='Retry pending activity');
 return {outbox,storage,sent,lifecycle,client,fs,retry,
  setPageLoader:(loader:(...args:any[])=>Promise<any>)=>{loadPage=loader;},
  get resetSession(){return resetSession;},
  async retireFeed(){
    const {retireHomeFeedForGitHubChange}=await import('../src/utils/feed-repository');
    await act(async()=>{await retireHomeFeedForGitHubChange(client,owner,()=>true);root.update(render());await tick();});
    await act(async()=>{await tick();});
  },
  refresh:()=>root.root.findByType('FeedHeader' as any).props.onRefresh(),
  get refreshMessage(){return root.root.findByType('FeedHeader' as any).props.statusMessage;},
  get mounts(){return mounts;},get prepared(){return prepared;},
  set quota(value:boolean){quota=value;},set offline(value:boolean){offline=value;},set failRemoval(value:boolean){failRemoval=value;},advance(){clock+=2000;},
  get reaction(){return root.root.findByType('Card' as any).props.repository.viewerReaction;},
  async react(action:ActivityInput['action']='like'){await act(async()=>{root.root.findByType('Card' as any).props.onQueueActivity({...input,action},true);await tick();});},
  async pressRetry(){await act(async()=>{connectivity({isConnected:false,isInternetReachable:false});connectivity({isConnected:true,isInternetReachable:true});await tick();});},
  async remount(){await act(async()=>{root.unmount();await tick();});await act(async()=>{root=create(render());await tick();});},
  async reconnect(){await act(async()=>{connectivity({isConnected:true,isInternetReachable:true});await tick();});},
  pauseToken(){let release!:()=>void;tokenWait=new Promise<void>(yes=>{release=yes;});return ()=>{tokenWait=undefined;release();};},
  async switchOwner(){lifecycle.retire(lifecycle.currentGeneration());owner=ownerB;await act(async()=>{root.update(render());await tick();});},
 };
}

test('Home quietly retains quota failures and retries exact durable intent on reconnect',async t=>{
 const app=await fixture(t);app.quota=true;await app.react();
 assert.equal(app.sent.length,0);assert.equal(app.prepared,1);assert.equal(app.retry(),undefined,'Pending work must not cover Home with an error banner');
 await app.pressRetry();assert.equal(app.sent.length,0);assert.equal(app.retry(),undefined,'Pending work must not cover Home with an error banner');
 app.quota=false;app.offline=true;app.advance();await app.pressRetry();
 assert.deepEqual(app.sent[0],{token:ownerA,events:[expected]});assert.equal(app.retry(),undefined,'Pending work must not cover Home with an error banner');
 assert.deepEqual(await new IncrementalActivityStorage(app.fs,async()=>[]).load(),[expected],'fresh storage process retains the original intent');
 await app.pressRetry();assert.equal(app.sent.length,1,'backoff-deferred retry must not create success or duplicate event');assert.equal(app.retry(),undefined,'Pending work must not cover Home with an error banner');
 app.advance();app.offline=false;await app.pressRetry();
 assert.equal(app.retry(),undefined,'only server acknowledgement clears pending feedback');
 assert.deepEqual(app.sent.map(batch=>batch.events),[[expected],[expected]]);assert.equal(app.prepared,1);assert.equal(app.mounts,1);
 assert.deepEqual(await app.storage.load(),[]);
});

test('Home background retry cannot use another owner token or show an error banner',async t=>{
 const app=await fixture(t);app.quota=true;await app.react();assert.equal(app.retry(),undefined,'Pending work must not cover Home with an error banner');
 app.quota=false;const release=app.pauseToken();await app.pressRetry();
 await app.switchOwner();release();await act(async()=>{await tick();});
 assert.equal(app.retry(),undefined);assert.deepEqual(app.sent,[]);assert.equal(app.prepared,1);
 assert.equal(await app.outbox.pendingCount(),1,'A retains its exact unsent intent');
});

test('retry preserves both opposing intents without rolling back the newer local reaction',async t=>{
 const app=await fixture(t);app.quota=true;await app.react();await app.react('unlike');
 assert.equal(app.reaction,null);assert.equal(app.sent.length,0);
 app.quota=false;await app.pressRetry();
 assert.deepEqual(app.sent[0].events,[expected,{...expected,action:'unlike',event_id:'00000000-0000-4000-8000-000000000007'}]);
 assert.equal(app.reaction,null);assert.equal(app.retry(),undefined);assert.equal(app.prepared,2);assert.equal(app.mounts,1);
});

test('server acknowledgement is not replaced by a late local cleanup error',async t=>{
 const app=await fixture(t);app.failRemoval=true;await app.react();
 assert.equal(app.sent.length,1);assert.equal(app.retry(),undefined,'the acknowledged intent must not become a new failure');
 assert.deepEqual(await app.storage.load(),[expected],'failed cleanup remains replayable with its original identity');
});

test('Home remount retains pending work without an error banner while storage is unavailable',async t=>{
 const app=await fixture(t);app.quota=true;await app.react();assert.equal(app.retry(),undefined,'Pending work must not cover Home with an error banner');
 await app.remount();assert.equal(app.retry(),undefined,'Pending work must not cover Home with an error banner');
 assert.deepEqual(app.sent,[]);assert.equal(app.prepared,1);
 app.quota=false;app.advance();await app.pressRetry();
 assert.deepEqual(app.sent[0].events,[expected]);assert.equal(app.retry(),undefined);assert.equal(app.prepared,1);
});

test('backoff-deferred reactions stay durable and retry without covering Home',async t=>{
 const app=await fixture(t);app.offline=true;await app.react('impression');
 assert.equal(app.sent.length,1);assert.equal(app.retry(),undefined,'background impressions must not produce a reaction error');await app.react();
 assert.equal(app.sent.length,1,'the reaction flush was deferred by the prior background outage');
 app.advance();await app.reconnect();assert.equal(app.sent.length,2);
 assert.equal(app.retry(),undefined,'Pending work must not cover Home with an error banner');
 app.offline=false;app.advance();await app.pressRetry();
 assert.deepEqual(app.sent.at(-1)!.events,[{...expected,action:'impression'},{...expected,event_id:'00000000-0000-4000-8000-000000000007'}]);
 assert.equal(app.retry(),undefined);assert.equal(app.prepared,2);
});


test('Home refresh retains loaded cards on failure and replaces them only after a successful first page',async t=>{
 const app=await fixture(t);
 const original=app.client.getQueryData(['feed',ownerA]);
 let fail!:(error:Error)=>void;
 app.setPageLoader(()=>new Promise((_resolve,reject)=>{fail=reject;}));
 let refreshing!:Promise<void>;
 await act(async()=>{refreshing=app.refresh();await tick();});
 assert.strictEqual(app.client.getQueryData(['feed',ownerA]),original,'Refreshing must not blank loaded history');
 await act(async()=>{fail(new Error('Recommendations are still being prepared'));await refreshing;});
 assert.strictEqual(app.client.getQueryData(['feed',ownerA]),original,'Failed refresh keeps the readable cards');
 assert.match(app.refreshMessage,/Could not refresh/);
 app.setPageLoader(async()=>({items:[{repo_id:repo,full_name:'fixture/new-page',serve_id:serve,position:0}],nextCursor:null,feedVersion:'2',sessionId:session,mode:'personalized'}));
 await act(async()=>{await app.refresh();});
 assert.equal((app.client.getQueryData<any>(['feed',ownerA])).pages.length,1);
 assert.equal((app.client.getQueryData<any>(['feed',ownerA])).pages[0].feedVersion,'2');
 assert.equal(app.refreshMessage,null);
 let finish!:(value:unknown)=>void;
 app.setPageLoader(()=>new Promise(resolve=>{finish=resolve;}));
 await act(async()=>{refreshing=app.refresh();await tick();});
 const other=app.client.getQueryData(['feed',ownerB]);
 await app.switchOwner();
 await act(async()=>{finish({items:[],nextCursor:null,feedVersion:'99',sessionId:session});await refreshing;});
 assert.strictEqual(app.client.getQueryData(['feed',ownerB]),other,'A late refresh cannot replace another account');
 assert.equal(app.refreshMessage,null);
});


test('mounted Home refresh and pagination share the current controller after a GitHub change',async t=>{
 const app=await fixture(t);
 const sessions:string[]=[];
 app.setPageLoader(async(_token,_cursor,options)=>{
  sessions.push(options.sessionId);
  return {items:[{repo_id:repo,full_name:'fixture/project',serve_id:serve,position:0}],nextCursor:null,feedVersion:'2',sessionId:options.sessionId,mode:'personalized'};
 });
 await app.retireFeed();
 assert.ok(sessions.length>0,'mounted Home loads replacement pages');
 const currentSession=sessions.at(-1);
 await act(async()=>{await app.refresh();});
 assert.equal(app.resetSession,currentSession,'refresh must reset the session used by the replacement query');
 assert.equal(sessions.at(-1),currentSession,'refresh and query pagination must retain the same session');
});
