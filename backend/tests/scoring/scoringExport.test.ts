import assert from 'node:assert/strict';
import test from 'node:test';
import type {FrozenScoringEvent,FrozenScoringExposure,ScoringExportPolicy} from '../../contracts/scoringExport.js';
import {getScoringExportConfig,scoringExportPolicyDigest,validateScoringExportPolicy} from '../../config/scoringExport.js';
import {createPrivateScoringExport,validateScoringExportSelection} from '../../adapters/postgresScoringExport.js';
import {exportTimestampMicros,labelFrozenScoringExposure} from '../../services/scoringExportLabels.js';
import {createPrivateScoringRetention,getScoringRetentionConfig} from '../../workers/scoringRetentionWorker.js';

const uid='11111111-1111-4111-8111-111111111111',serve='22222222-2222-4222-8222-222222222222',repo='33333333-3333-4333-8333-333333333333';
const policy:ScoringExportPolicy={policyId:'fixture-only',policyVersion:'v1',snapshotTtlSeconds:600,labelHorizonSeconds:10,lateArrivalSeconds:5,clockSkewSeconds:0,labelerVersion:'scoring-labels-v1'};
const timestamp=(seconds:number,micro='000000')=>`2026-10-24T00:00:${String(seconds).padStart(2,'0')}.${micro}Z`;
function event(type:string,seconds=1,index=1):FrozenScoringEvent{return{raw_session_id:uid,session_attribution:'matches_serve',event_id:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,user_id:uid,serve_id:serve,repo_id:repo,position:0,event_type:type,dwell_ms:null,feedback_version:null,client_occurred_at:timestamp(seconds),server_received_at:timestamp(seconds)};}
function row(events:FrozenScoringEvent[]=[]):FrozenScoringExposure{return{user_id:uid,serve_id:serve,repo_id:repo,position:0,session_id:uid,exposure_id:null,served_at:timestamp(0),generation_id:null,legacy_generation_hint:null,record_digest:null,source_status:'legacy_unknown',source_expires_at:null,events};}
const labels=(events:FrozenScoringEvent[],observed=30)=>labelFrozenScoringExposure(row(events),timestamp(observed),policy);

test('disabled paths inspect no policy/credentials and open no private pools',()=>{
  const environment=new Proxy({SCORING_EXPORT_ENABLED:'false',SCORING_RETENTION_ENABLED:'false'},{get(target,key){if(key!=='SCORING_EXPORT_ENABLED'&&key!=='SCORING_RETENTION_ENABLED')throw new Error('read disabled config');return target[key as keyof typeof target];}});
  assert.deepEqual(getScoringExportConfig(environment),{enabled:false});
  assert.deepEqual(getScoringRetentionConfig(environment),{enabled:false});
  assert.equal(createPrivateScoringExport({enabled:false}),null);assert.equal(createPrivateScoringRetention({enabled:false}),null);
});
test('enabled configuration requires explicit policy rather than inventing choices',()=>{
  assert.throws(()=>getScoringExportConfig({SCORING_EXPORT_ENABLED:'true'}),/CONFIGURATION_INVALID/);
  assert.throws(()=>getScoringRetentionConfig({SCORING_RETENTION_ENABLED:'true'}),/RETENTION_UNAVAILABLE/);
  assert.throws(()=>getScoringExportConfig({SCORING_EXPORT_ENABLED:'yes'}),/CONFIGURATION_INVALID/);
  assert.throws(()=>validateScoringExportPolicy({...policy,lateArrivalSeconds:-1}));
  assert.throws(()=>validateScoringExportPolicy({...policy,arbitrary:true} as ScoringExportPolicy));
  assert.equal(scoringExportPolicyDigest(policy),scoringExportPolicyDigest({...policy}));
  assert.notEqual(scoringExportPolicyDigest(policy),scoringExportPolicyDigest({...policy,labelHorizonSeconds:11}));
});
test('selection rejects cross-contract fields, invalid calendar dates and unbounded windows',()=>{
  validateScoringExportSelection({subjectUserId:uid,servedFrom:timestamp(0),servedTo:timestamp(1)});
  assert.throws(()=>validateScoringExportSelection({subjectUserId:uid,servedFrom:timestamp(0),servedTo:'2026-12-24T00:00:00Z'}));
  assert.throws(()=>exportTimestampMicros('2026-02-30T00:00:00Z'));
  assert.throws(()=>exportTimestampMicros('2026-10-24T00:00:00+05:30'));
});
test('microsecond ordering survives dates truncated by JS Date',()=>{
  assert.equal(exportTimestampMicros(timestamp(1,'000002'))-exportTimestampMicros(timestamp(1,'000001')),1n);
  const later=event('impression',1,1),earlier=event('impression',1,2);
  later.client_occurred_at=timestamp(1,'000002');later.server_received_at=timestamp(2);
  earlier.client_occurred_at=timestamp(1,'000001');earlier.server_received_at=timestamp(2);
  const actual=labels([later,earlier]);assert.equal(actual.selected_impression_event_id,earlier.event_id);assert.equal(actual.multiple_impressions,true);
});
test('durable serving with no client impression remains unobserved rather than a negative',()=>{
  const actual=labels([]);assert.equal(actual.outcome_status,'unobserved');assert.equal(actual.selected_impression_event_id,null);
  assert.equal(actual.right_censored,true);assert.equal(actual.original_client_impression_linkage,'not_recorded');
});
test('real impression matures only after horizon and grace; future wall clock never changes a frozen result',()=>{
  const events=[event('impression')];assert.equal(labels(events,15).outcome_status,'right_censored');
  assert.equal(labels(events,16).outcome_status,'no_action_observed_by_cutoff');
  assert.equal(labels(events,16).observation_completeness,'cutoff_observed');assert.equal(labels(events,16).late_arrival_risk,true);
  assert.deepEqual(labels(events,16),labels(events,16));
});
for(const type of ['like','save','github_open','readme_open','share'])test(`raw ${type} labels positive only after a genuine impression`,()=>{
  assert.equal(labels([event('impression'),event(type,2,2)]).outcome_status,'positive_observed');
  assert.equal(labels([event(type,2,2)]).outcome_status,'unobserved');
});
test('inverse actions preserve IDs/types and do not infer a final product transition',()=>{
  const events=[event('impression'),event('like',2,2),event('unlike',3,3)];
  const actual=labels(events);assert.equal(actual.action_counts.like,1);assert.equal(actual.action_counts.unlike,1);
  assert.equal(actual.product_transition_state,'not_inferred');assert.deepEqual(actual.raw_events.map(value=>value.event_id),events.map(value=>value.event_id));
  assert.equal(labels([event('impression'),event('unsave',2,2)]).outcome_status,'inverse_only_observed');
  assert.equal(labels([event('impression'),event('dislike',2,2)]).outcome_status,'explicit_negative_observed');
});
test('short passive dwell is neutral; genuine qualified dwell is positive',()=>{
  const dwell=event('dwell',2,2);dwell.dwell_ms=2999;
  assert.equal(labels([event('impression'),dwell]).outcome_status,'no_action_observed_by_cutoff');
  assert.deepEqual(labels([event('impression'),dwell]).unqualified_dwell_event_ids,[dwell.event_id]);
  dwell.dwell_ms=3000;assert.equal(labels([event('impression'),dwell]).outcome_status,'positive_observed');
});
test('late and pre-impression events stay raw and cannot silently contaminate the horizon',()=>{
  const late=event('save',20,3),early=event('like',0,2),impression=event('impression');
  const actual=labels([late,early,impression]);assert.equal(actual.outcome_status,'no_action_observed_by_cutoff');
  assert.deepEqual(actual.outside_horizon_event_ids,[early.event_id,late.event_id]);assert.equal(actual.raw_events.length,3);
});
test('clock inconsistency and unknown types prevent a false no-action label',()=>{
  const impossible=event('save',2,2);impossible.server_received_at=timestamp(1);
  assert.equal(labels([event('impression'),impossible]).outcome_status,'clock_uncertain');
  const unknown=labels([event('impression'),event('future_event',2,2)]);
  assert.equal(unknown.outcome_status,'unsupported_events');assert.deepEqual(unknown.unavailable_targets,['starred','dismissed','follow']);
});
test('duplicate identities, forged attribution and arbitrary event context fail closed',()=>{
  assert.throws(()=>labels([event('impression'),event('save')]));
  assert.throws(()=>labels([{...event('impression'),user_id:repo}]));
  assert.throws(()=>labels([{...event('impression'),context:{secret:'private'}} as FrozenScoringEvent]));
});


test('different or absent raw event sessions are preserved and cannot create a positive training label',()=>{
  for(const raw of [null,repo]){
    const changed={...event('like',2,2),raw_session_id:raw,session_attribution:raw===null?'not_recorded' as const:'differs_from_serve' as const};
    const result=labels([event('impression'),changed]);
    assert.equal(result.outcome_status,'attribution_uncertain');assert.equal(result.action_counts.like,0);
    assert.deepEqual(result.invalid_session_event_ids,[changed.event_id]);assert.equal(result.raw_events[1].raw_session_id,raw);
    assert.equal(result.right_censored,true);
  }
});
