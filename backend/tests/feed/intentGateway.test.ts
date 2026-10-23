import assert from 'node:assert/strict';
import test from 'node:test';
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
 const gateway=new IntentFeedGateway(legacy,{getServeByRequest:async()=>null},{snapshot:async()=>snapshot,
  resolve:async()=>{reads++;await new Promise<void>(resolve=>barriers.push(resolve));return scope;}},()=>{
   created++;return {getFeed:async()=>response,stop:async()=>{stopped++;}};});
 const first=gateway.getFeed(owner,request),second=gateway.getFeed(owner,{...request,feed_request_id:session});
 while(reads<2)await new Promise(resolve=>setImmediate(resolve));
 barriers.forEach(resolve=>resolve());await Promise.all([first,second]);assert.equal(created,1);
 await gateway.stop();assert.equal(stopped,1);
});
test('stop during authority I/O prevents a later service installation',async()=>{
 let release:()=>void=()=>{};let resolving=false,created=0;
 const gateway=new IntentFeedGateway({getFeed:async()=>response,stop:async()=>{}},{getServeByRequest:async()=>null},{snapshot:async()=>snapshot,
  resolve:async()=>{resolving=true;await new Promise<void>(resolve=>{release=resolve;});return scope;}},()=>{
   created++;return {getFeed:async()=>response,stop:async()=>{}};});
 const pending=gateway.getFeed(owner,request);while(!resolving)await new Promise(resolve=>setImmediate(resolve));
 const stopping=gateway.stop();release();await assert.rejects(pending,/MODEL_OPERATION/);await stopping;assert.equal(created,0);
});
