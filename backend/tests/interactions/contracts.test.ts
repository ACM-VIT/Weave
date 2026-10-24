import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import { isInteractionEventV2 } from "../../utils/interactionValidation.js";
import { transitionReaction } from "../../services/activityV2Service.js";
import { INTERACTION_EVENT_TYPES } from "../../contracts/interactions.v2.js";
import { FEED_SCHEMA_VERSION } from "../../contracts/feed.v2.js";
import { ML_SCHEMA_VERSION } from "../../contracts/ml.v2.js";

describe("impressionReference", () => {
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
});

describe("transitions", () => {
  test('reaction target-state transitions are retry safe', () => {
    assert.equal(transitionReaction(null, 'like'), 'like');
    assert.equal(transitionReaction('like', 'like'), 'like');
    assert.equal(transitionReaction('dislike', 'like'), 'like');
    assert.equal(transitionReaction('like', 'unlike'), null);
    assert.equal(transitionReaction(null, 'unlike'), null);
    assert.equal(transitionReaction('like', 'dislike'), 'dislike');
    assert.equal(transitionReaction('dislike', 'undislike'), null);
  });
});

describe("contracts", () => {
  test('v2 contracts freeze schema versions and canonical actions', () => {
    assert.equal(FEED_SCHEMA_VERSION, 2);
    assert.equal(ML_SCHEMA_VERSION, 2);
    assert.deepEqual(INTERACTION_EVENT_TYPES, [
      'impression', 'dwell', 'readme_open', 'github_open', 'like', 'unlike',
      'dislike', 'undislike', 'save', 'unsave', 'share', 'follow', 'unfollow',
    ]);
  });
});
