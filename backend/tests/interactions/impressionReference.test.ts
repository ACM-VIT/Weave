import assert from 'node:assert/strict';
import test from 'node:test';
import {isInteractionEventV2} from '../../utils/interactionValidation.js';
const id='00000000-0000-4000-8000-000000000001';
const event={event_id:id,schema_version:2,session_id:id,serve_id:id,repo_id:id,position:0,event_type:'share',dwell_ms:null,client_occurred_at:'2026-10-24T00:00:00.000Z',context:{}};
test('original impression references are optional and validated without looking up another account',()=>{
 assert.equal(isInteractionEventV2(event),true);
 assert.equal(isInteractionEventV2({...event,impression_event_id:null}),true);
 assert.equal(isInteractionEventV2({...event,impression_event_id:id}),true);
 for(const value of ['',42,'other-account-event'])assert.equal(isInteractionEventV2({...event,impression_event_id:value}),false);
 assert.equal(isInteractionEventV2({...event,serve_id:null,position:null,impression_event_id:id}),false);
 assert.equal(isInteractionEventV2({...event,event_type:'impression',impression_event_id:id}),false);
});
