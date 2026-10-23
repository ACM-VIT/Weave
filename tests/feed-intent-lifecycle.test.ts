import assert from 'node:assert/strict';
import test from 'node:test';
import { FeedIntentLifecycle,type FeedSessionControl,type FeedSessionResult } from '../src/services/feedIntentLifecycle';
const owner='00000000-0000-4000-8000-000000000035',session='00000000-0000-4000-8000-000000000036';
test('uncertain Begin retries the exact durable UUID after restart, then Reset and End retain order',async()=>{
 let stored:string|null=null,offline=true,epoch='1',active=false;
 const sent:FeedSessionControl[]=[];
 const deps={read:async()=>stored,write:async(value:string)=>{stored=value;},assertCurrent:()=>{},
 inspect:async():Promise<FeedSessionResult|null>=>active?{mode:'ordered',session:{session_id:session,epoch,status:'active'}}:null,
 send:async(control:FeedSessionControl):Promise<FeedSessionResult>=>{
  assert.ok(stored?.includes(control.request_id));sent.push(control);
  if(offline)throw new Error('offline');active=true;
  if(control.kind==='reset')epoch=(BigInt(control.expected_epoch)+1n).toString();
  return {mode:'ordered',session:{session_id:session,epoch,status:control.kind==='end'?'retired':'active'}};
 }};
 const first=new FeedIntentLifecycle(owner,deps);await assert.rejects(first.ensure(session),/offline/);
 const original=sent[0];offline=false;const restored=new FeedIntentLifecycle(owner,deps);assert.equal(await restored.ensure(session),true);
 assert.deepEqual(sent[1],original);assert.equal(await restored.reset(session),true);assert.equal(epoch,'2');
 offline=true;await assert.rejects(restored.endAll(),/offline/);const end=sent.at(-1);assert.equal(end?.kind,'end');
 offline=false;const resumed=new FeedIntentLifecycle(owner,deps);await resumed.endAll();assert.deepEqual(sent.at(-1),end);
 assert.equal(JSON.parse(stored!).entries.length,0);
});
test('write failure never permits an unpersisted control and an account change cancels continuation',async()=>{
 let writing=false,current=true,sends=0;
 const deps={read:async()=>null,write:async()=>{if(!writing)throw new Error('disk unavailable');},
 inspect:async()=>null,assertCurrent:()=>{if(!current)throw new Error('account changed');},
 send:async(control:FeedSessionControl):Promise<FeedSessionResult>=>{sends++;return {mode:'ordered',session:{session_id:control.session_id,epoch:'1',status:'active'}};}};
 const client=new FeedIntentLifecycle(owner,deps);await assert.rejects(client.ensure(session),/disk/);assert.equal(sends,0);
 writing=true;current=false;await assert.rejects(client.ensure(session),/account changed/);assert.equal(sends,0);
});
test('disabled server leaves the legacy feed session behavior unchanged',async()=>{
 let sends=0;
 const client=new FeedIntentLifecycle(owner,{read:async()=>null,write:async()=>{},assertCurrent:()=>{},
 inspect:async()=>({mode:'legacy'}),send:async()=>{sends++;return {mode:'legacy'};}});
 assert.equal(await client.ensure(session),false);assert.equal(await client.reset(session),false);await client.endAll();assert.equal(sends,0);
});

test('startup preparation restores this device canonical session instead of consuming a new live-session slot',async()=>{
 let stored:string|null=null,sends=0,active=false;
 const deps={read:async()=>stored,write:async(value:string)=>{stored=value;},assertCurrent:()=>{},
 inspect:async(id:string):Promise<FeedSessionResult|null>=>active&&id===session?{mode:'ordered',session:{session_id:session,epoch:'1',status:'active'}}:null,
 send:async(control:FeedSessionControl):Promise<FeedSessionResult>=>{sends++;active=true;return {mode:'ordered',session:{session_id:control.session_id,epoch:'1',status:'active'}};}};
 assert.equal(await new FeedIntentLifecycle(owner,deps).prepare(session),session);
 const restarted=new FeedIntentLifecycle(owner,deps);
 assert.equal(await restarted.prepare('00000000-0000-4000-8000-000000000099'),session);assert.equal(sends,1);
});

test('a remote End is reconciled to a new canonical Begin without reusing the retired UUID',async()=>{
 let stored:string|null=null,retired=false;const sent:FeedSessionControl[]=[];
 const states=new Map<string,'active'|'retired'>();
 const client=new FeedIntentLifecycle(owner,{read:async()=>stored,write:async value=>{stored=value;},assertCurrent:()=>{},
  inspect:async id=>states.has(id)?{mode:'ordered',session:{session_id:id,epoch:'1',status:retired&&id===session?'retired':states.get(id)!}}:null,
  send:async control=>{sent.push(control);states.set(control.session_id,'active');return {mode:'ordered',session:{session_id:control.session_id,epoch:'1',status:'active'}};}});
 assert.equal(await client.prepare(session),session);retired=true;
 const replacement=await client.prepare(session);assert.notEqual(replacement,session);assert.equal(sent[1].kind,'begin');assert.equal(sent[1].session_id,replacement);
});

test('a same-version model cursor restart keeps loaded attribution and appends only genuinely new cards',async()=>{
 const {FeedPaginationController}=await import('../src/services/feedPagination');
 const original={repo_id:'one',serve_id:'serve-old',feed_session_id:session,client_original_impression:{eventId:'original'}};
 let calls=0;
 const pagination=new FeedPaginationController(async cursor=>{
  calls++;
  if(calls===1)return {items:[original],nextCursor:'old-model-cursor',feedVersion:'1',sessionId:session};
  if(cursor==='old-model-cursor')throw Object.assign(new Error('Model state advanced'),{status:400,code:'FEED_CURSOR_STALE'});
  return {items:[original,{repo_id:'two',serve_id:'serve-new',feed_session_id:session}],nextCursor:null,feedVersion:'1',sessionId:session};
 });
 const first=await pagination.load(null);const second=await pagination.load(first.nextCursor);
 assert.deepEqual(second.items.map(item=>item.repo_id),['two']);assert.equal(first.items[0],original);
 assert.deepEqual(original.client_original_impression,{eventId:'original'});assert.equal(calls,3);
});
