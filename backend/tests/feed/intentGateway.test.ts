import assert from 'node:assert/strict';
import test from 'node:test';
import { FeedCursorCodec } from '../../services/feedCursor.js';
import { IntentFeedGateway } from '../../services/intentFeedGateway.js';
import type { FeedIntentScope } from '../../contracts/feedIntent.js';
import type { FeedResponseV2 } from '../../contracts/feed.v2.js';
const owner='00000000-0000-4000-8000-000000000001',session='00000000-0000-4000-8000-000000000002';
const snapshot={generationFreshnessMs:60000,userId:owner,sessionId:session,feedVersion:'1',profileVersion:'1',acceptedOperationVersion:'2',feedbackVersion:'0',
 epoch:'1',epochStartedMs:'1',witnessSha256:'a'.repeat(64),policySha256:'b'.repeat(64)};
const scope:FeedIntentScope={...snapshot,queueScope:'c'.repeat(64),context:{schema_version:1,session_id:session,epoch:'1',as_of_ms:'1',
 policy_sha256:snapshot.policySha256,minimum_applied_operation_version:'2',required_profile_version:'1'},
 applied:{schema_version:1,user_id:owner,session_id:session,epoch:'1',as_of_ms:'1',policy_sha256:snapshot.policySha256,profile_version:'1',
  applied_operation_version:'2',applied_feedback_version:'0',state_sha256:'d'.repeat(64),head:'e'.repeat(64),effective_vector_sha256:'f'.repeat(64),
  session_witness_sha256:snapshot.witnessSha256,valid_until_ms:String(Date.now()+60000),explicit_negative_repo_ids:[]}};
const response:FeedResponseV2={serve_id:owner,session_id:session,feed_version:'1',source:'personalized',model_version:'fixture',items:[],next_cursor:null};
const request={feed_request_id:owner,session_id:session,limit:2,cursor:null};
test('concurrent cold authority awaits install one service and stop drains that service',async()=>{
 const barriers:(()=>void)[]=[];let created=0,stopped=0,reads=0;
 const legacy={getFeed:async()=>response,stop:async()=>{}};
 const gateway=new IntentFeedGateway(legacy,{getServeByRequest:async()=>null},{snapshot:async()=>snapshot,restoreCursor:async()=>scope.applied,
  resolve:async()=>{reads++;await new Promise<void>(resolve=>barriers.push(resolve));return scope;}},()=>{
   created++;return {getFeed:async()=>response,stop:async()=>{stopped++;}};});
 const first=gateway.getFeed(owner,request),second=gateway.getFeed(owner,{...request,feed_request_id:session});
 while(reads<2)await new Promise(resolve=>setImmediate(resolve));
 barriers.forEach(resolve=>resolve());await Promise.all([first,second]);assert.equal(created,1);
 await gateway.stop();assert.equal(stopped,1);
});
test('stop during authority I/O prevents a later service installation',async()=>{
 let release:()=>void=()=>{};let resolving=false,created=0;
 const gateway=new IntentFeedGateway({getFeed:async()=>response,stop:async()=>{}},{getServeByRequest:async()=>null},{snapshot:async()=>snapshot,restoreCursor:async()=>scope.applied,
  resolve:async()=>{resolving=true;await new Promise<void>(resolve=>{release=resolve;});return scope;}},()=>{
   created++;return {getFeed:async()=>response,stop:async()=>{}};});
 const pending=gateway.getFeed(owner,request);while(!resolving)await new Promise(resolve=>setImmediate(resolve));
 const stopping=gateway.stop();release();await assert.rejects(pending,/MODEL_OPERATION/);await stopping;assert.equal(created,0);
});

function cryptoId(index:number){return `00000000-0000-4000-8000-${String(index+100).padStart(12,'0')}`;}
function scoped(index:number):FeedIntentScope {
 const user=cryptoId(index),sessionId=cryptoId(index+1000);
 return {...scope,userId:user,sessionId,queueScope:(index+1).toString(16).padStart(64,'0'),
  context:{...scope.context,session_id:sessionId},applied:{...scope.applied,user_id:user,session_id:sessionId}};
}
test('129 sequential fresh scopes evict idle acceleration and restore the evicted durable cursor scope',async()=>{
 const scopes=Array.from({length:129},(_,index)=>scoped(index));let stopped=0,created=0,restores=0;
 const byUser=new Map(scopes.map(value=>[value.userId,value]));const secret='owned-gateway-cursor';const codec=new FeedCursorCodec(secret);
 const gateway=new IntentFeedGateway({getFeed:async()=>response,stop:async()=>{}},{getServeByRequest:async()=>null},{
  snapshot:async userId=>byUser.get(userId)!,restoreCursor:async(current,queueScope)=>{restores++;const value=byUser.get(current.userId)!;assert.equal(value.queueScope,queueScope);return value.applied;},
  resolve:async userId=>byUser.get(userId)!,
 },()=>{created++;return {getFeed:async()=>response,stop:async()=>{stopped++;}};},secret);
 try{
  for(const value of scopes)await gateway.getFeed(value.userId,{...request,feed_request_id:cryptoId(created+2000),session_id:value.sessionId});
  assert.equal(stopped,1,'a finished unexpired scope is expendable acceleration');
  const first=scopes[0],cursor=codec.encode({user_id:first.userId,session_id:first.sessionId,feed_version:first.feedVersion,offset:2,model_scope:first.queueScope});
  await gateway.getFeed(first.userId,{...request,feed_request_id:cryptoId(3000),session_id:first.sessionId,cursor});
  assert.equal(restores,1);assert.equal(created,130);assert.equal(stopped,2);
 }finally{await gateway.stop();}
 assert.equal(stopped,130);
});
test('128 genuinely active services retain capacity until their owned work exits',async()=>{
 const scopes=Array.from({length:129},(_,index)=>scoped(index));const byUser=new Map(scopes.map(value=>[value.userId,value]));
 let created=0;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const gateway=new IntentFeedGateway({getFeed:async()=>response,stop:async()=>{}},{getServeByRequest:async()=>null},{snapshot:async userId=>byUser.get(userId)!,
  restoreCursor:async()=>scope.applied,resolve:async userId=>byUser.get(userId)!,
 },()=>{created++;return {getFeed:async()=>{await gate;return response;},stop:async()=>{}};});
 const pending=Promise.allSettled(scopes.map(value=>gateway.getFeed(value.userId,{...request,session_id:value.sessionId})));
 try{
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(created,128,'parallel cold admissions cannot overbook the process bound');
  release();const results=await pending;const rejected=results.filter(result=>result.status==='rejected');
  assert.equal(rejected.length,1);assert.match(String((rejected[0] as PromiseRejectedResult).reason),/MODEL_FEED_CAPACITY/);
 }finally{release();await pending;await gateway.stop();}
});
