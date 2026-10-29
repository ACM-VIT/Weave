import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { loadNegativePreferenceEligibleIds, NEGATIVE_PREFERENCE_ELIGIBILITY_SQL } from '../../services/negativePreferenceEligibility.js';
const user='00000000-0000-4000-8000-000000000001';
const a='00000000-0000-4000-8000-000000000002';
const b='00000000-0000-4000-8000-000000000003';

test('negative eligibility asks one bounded current-state query and preserves only canonical requested identities',async () => {
  let calls=0;
  const result=await loadNegativePreferenceEligibleIds({query:async (sql,parameters) => {
    calls++; assert.equal(sql,NEGATIVE_PREFERENCE_ELIGIBILITY_SQL); assert.deepEqual(parameters,[[a,b],user]);
    return [{repo_id:b}];
  }},user,[b,a,b]);
  assert.deepEqual(result,[b]); assert.equal(calls,1);
});

test('negative eligibility rejects malformed/unbounded input and unexpected result instead of trusting history',async () => {
  let calls=0;
  const reader={query:async () => { calls++; return []; }};
  assert.deepEqual(await loadNegativePreferenceEligibleIds(reader,user,[]),[]); assert.equal(calls,0);
  await assert.rejects(loadNegativePreferenceEligibleIds(reader,'handle',[a]),/viewer UUID/);
  await assert.rejects(loadNegativePreferenceEligibleIds(reader,user,Array(151).fill(a)),/at most 150/);
  await assert.rejects(loadNegativePreferenceEligibleIds(reader,user,['owner/name']),/canonical/);
  for (const result of [[{repo_id:b}],[{repo_id:a},{repo_id:a}]]) {
    await assert.rejects(loadNegativePreferenceEligibleIds({query:async () => result},user,[a]),/unexpected/);
  }
  assert.match(NEGATIVE_PREFERENCE_ELIGIBILITY_SQL,/negative\.reaction='dislike'/);
  assert.doesNotMatch(NEGATIVE_PREFERENCE_ELIGIBILITY_SQL,/LIMIT|user_repo_engagement|last_event_at|impression/);
});

const integrationEnabled=process.env.RUN_NEGATIVE_PREFERENCE_INTEGRATION==='1';
if(integrationEnabled) after(async () => {
  const {sqlClient}=await import('../../db/index.js');
  await sqlClient.end({timeout:1});
});
test('real current preferences reject old dislikes beyond 500 history without affecting another user or inverse state', {skip:!integrationEnabled},async () => {
  const target=new URL(process.env.DATABASE_URL??'');
  assert.notEqual(process.env.NODE_ENV,'production');
  assert.ok(['postgres:','postgresql:'].includes(target.protocol));
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname));
  assert.equal(target.pathname,'/weave_negative_preferences_test');
  assert.equal(target.search,''); assert.equal(target.hash,'');
  const {randomUUID}=await import('node:crypto');
  const {sqlClient:sql}=await import('../../db/index.js');
  const {PostgresFeedPersistence}=await import('../../adapters/postgresFeedPersistence.js');
  const users=[randomUUID(),randomUUID()];
  const repos=Array.from({length:502},() => randomUUID());
  const [viewer,other]=users; const oldest=repos[0]!; const allowed=repos[501]!;
  try {
    for (const id of users) {
      await sql`INSERT INTO auth.users(id) VALUES(${id}::uuid)`;
      await sql`INSERT INTO app.users(user_id,username,status) VALUES(${id}::uuid,${'negative_'+id.replaceAll('-','')},'active')`;
    }
    const repositoryRows=repos.map((repo,index) => ({repo_id:repo,github_id:String(5000000000+index),
      full_name:'negative/'+repo,owner:'negative',name:repo,url:'https://github.com/negative/'+repo,status:'active'}));
    await sql`INSERT INTO app.repos(repo_id,github_id,full_name,owner,name,url,status)
      SELECT repo_id,github_id,full_name,owner,name,url,status FROM jsonb_to_recordset(${JSON.stringify(repositoryRows)}::jsonb)
      AS row(repo_id uuid,github_id bigint,full_name text,owner text,name text,url text,status text)`;
    await sql`INSERT INTO app.reactions(user_id,repo_id,reaction)
      SELECT ${viewer!}::uuid,repo,'dislike' FROM unnest(${repos.slice(0,501)}::uuid[]) AS row(repo)`;
    await sql`INSERT INTO telemetry.user_repo_engagement(user_id,repo_id,last_event_at)
      SELECT ${viewer!}::uuid,repo,'2026-01-01T00:00:00Z'::timestamptz+position*interval '1 second'
      FROM unnest(${repos.slice(0,501)}::uuid[]) WITH ORDINALITY AS row(repo,position)`;
    const bounded=await new PostgresFeedPersistence().listExcludedRepositoryIds(viewer!,undefined,500);
    assert.equal(bounded.length,500); assert.ok(!bounded.includes(oldest),'Fixture proves this dislike is outside the bounded history.');
    const reader={query:async (text:string,parameters:readonly unknown[]) => [...await sql.unsafe(text,parameters as never)]};
    assert.deepEqual(await loadNegativePreferenceEligibleIds(reader,viewer!,[oldest,allowed]),[allowed]);
    assert.deepEqual(new Set(await loadNegativePreferenceEligibleIds(reader,other!,[oldest,allowed])),new Set([oldest,allowed]));
    await sql`DELETE FROM app.reactions WHERE user_id=${viewer!}::uuid AND repo_id=${oldest}::uuid`;
    assert.ok((await loadNegativePreferenceEligibleIds(reader,viewer!,[oldest,allowed])).includes(oldest),'Inverse state becomes eligible without changing historical events.');
    const persistence=new PostgresFeedPersistence();
    assert.deepEqual(new Set(await persistence.listPreferenceEligibleRepositoryIds(viewer!,[oldest,allowed])),new Set([oldest,allowed]));
    const {processInteractionBatchV2InTransaction,processInteractionBatchV2}=await import('../../services/activityV2Service.js');
    const {FeedPreferenceChangedError}=await import('../../ports/feedPersistencePort.js');
    const [repository]=await persistence.listActiveRepositories([allowed],viewer!);
    const session=randomUUID();
    const input={feed_request_id:randomUUID(),user_id:viewer!,session_id:session,feed_version:1n,
      generation_id:null,source:'personalized' as const,model_version:'test',next_cursor:null,
      items:[{repo_id:allowed,position:0,score:999,source:'semantic',model_version:'test',summary_id:null,repository:repository!}]};
    const historical=await persistence.createServe(input);
    const event={schema_version:2 as const,event_id:randomUUID(),session_id:session,serve_id:historical.serve_id,
      repo_id:allowed,position:0,event_type:'dislike' as const,dwell_ms:null,client_occurred_at:new Date().toISOString(),context:{}};
    let release!:()=>void, locked!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;});const acquired=new Promise<void>(resolve=>{locked=resolve;});
    const writer=sql.begin(async tx=>{
      await tx`SET LOCAL lock_timeout='3s'`;
      await processInteractionBatchV2InTransaction(tx,viewer!,[event]);locked();await held;
    });
    await acquired;
    let settled=false;
    const fresh={...input,feed_request_id:randomUUID()};
    const creating=persistence.createServe(fresh).finally(()=>{settled=true;});
    const rejected=assert.rejects(creating,FeedPreferenceChangedError);
    try {await new Promise(resolve=>setTimeout(resolve,100));assert.equal(settled,false,'New serve must wait for the actual activity transaction.');}
    finally {release();await writer;}
    await rejected;
    assert.equal(await persistence.getServeByRequest(viewer!,fresh.feed_request_id),null,'Rejected new serve rolls back its header.');
    assert.equal((await persistence.createServe(input)).serve_id,historical.serve_id,'Same-request historical replay survives the dislike.');
    assert.deepEqual(await persistence.listPreferenceEligibleRepositoryIds(viewer!,[allowed]),[]);
    const duplicate=await processInteractionBatchV2(viewer!,[event]);assert.equal(duplicate.duplicates,1);
    const inverse={...event,event_id:randomUUID(),event_type:'undislike' as const};
    assert.equal((await processInteractionBatchV2(viewer!,[inverse])).accepted,1);
    assert.deepEqual(await persistence.listPreferenceEligibleRepositoryIds(viewer!,[allowed]),[allowed]);
    assert.equal((await persistence.createServe(fresh)).items[0]?.repo_id,allowed);
    await sql`UPDATE app.repos SET status='blocked'  WHERE repo_id=${allowed}::uuid`;
    assert.deepEqual(await loadNegativePreferenceEligibleIds(reader,viewer!,[allowed]),[]);
    await sql`UPDATE app.users SET status='suspended' WHERE user_id=${viewer!}::uuid`;
    assert.deepEqual(await loadNegativePreferenceEligibleIds(reader,viewer!,[oldest]),[]);
  } finally {
    await sql`DELETE FROM app.users WHERE user_id=ANY(${users}::uuid[])`;
    await sql`DELETE FROM app.repos WHERE repo_id=ANY(${repos}::uuid[])`;
    await sql`DELETE FROM auth.users WHERE id=ANY(${users}::uuid[])`;
  }
});


test('candidate session UUID case aliases normalize without bypassing the served-row fence',async()=>{
  const {loadCandidateEligibility}=await import('../../services/feedExposureEligibility.js');
  const session='abcdef01-abcd-4abc-8abc-abcdef012345';
  const result=await loadCandidateEligibility({query:async(_sql,parameters)=>{
    assert.equal(parameters[4],session);
    return [{repo_id:a,summary_id:null,preference_eligible:true,exposure_eligible:false,session_served:true}];
  }},user,[a],7,session.toUpperCase());
  assert.deepEqual(result.servedIds,[a]);assert.deepEqual(result.exposureIds,[]);
});

test('global exposure reset retains old serves and pending actions while excluding new deliveries', {skip:!integrationEnabled},async () => {
  const target=new URL(process.env.DATABASE_URL??'');
  assert.ok(['127.0.0.1','localhost'].includes(target.hostname));
  assert.equal(target.pathname,'/weave_negative_preferences_test');
  assert.notEqual(process.env.NODE_ENV,'production');
  const {randomUUID}=await import('node:crypto');
  const {sqlClient:sql}=await import('../../db/index.js');
  const {PostgresFeedPersistence}=await import('../../adapters/postgresFeedPersistence.js');
  const {loadCandidateEligibility}=await import('../../services/feedExposureEligibility.js');
  const viewer=randomUUID(),other=randomUUID(),repo=randomUUID(),session=randomUUID(),serve=randomUUID(),request=randomUUID();
  const previous=process.env.FEED_EXPOSURE_RESET_AT;
  const reader={query:async(text:string,parameters:readonly unknown[])=>[...await sql.unsafe(text,parameters as never)]};
  try {
    delete process.env.FEED_EXPOSURE_RESET_AT;
    for(const id of [viewer,other]) {
      await sql`INSERT INTO auth.users(id) VALUES(${id}::uuid)`;
      await sql`INSERT INTO app.users(user_id,username,status) VALUES(${id}::uuid,${'reset_'+id.replaceAll('-','')},'active')`;
      await sql`INSERT INTO app.user_feed_state(user_id) VALUES(${id}::uuid) ON CONFLICT DO NOTHING`;
    }
    await sql`INSERT INTO app.repos(repo_id,github_id,full_name,owner,name,url,status)
      VALUES(${repo}::uuid,'7999999999',${'reset/'+repo},'reset',${repo},${'https://github.com/reset/'+repo},'active')`;
    await sql`INSERT INTO app.repo_content(repo_id,readme,content_hash) VALUES(${repo}::uuid,'README fixture',${'a'.repeat(64)})`;
    await sql`INSERT INTO telemetry.feed_serves(serve_id,feed_request_id,user_id,session_id,feed_version,source,model_version,created_at)
      VALUES(${serve}::uuid,${request}::uuid,${viewer}::uuid,${session}::uuid,1,'personalized','test',now()-interval '1 hour')`;
    await sql`INSERT INTO telemetry.feed_serve_items(serve_id,position,repo_id,score,source,model_version)
      VALUES(${serve}::uuid,0,${repo}::uuid,1,'semantic','test')`;
    await sql`INSERT INTO telemetry.interaction_events(schema_version,event_id,user_id,session_id,serve_id,repo_id,position,event_type,client_occurred_at,server_received_at)
      VALUES(2,${randomUUID()}::uuid,${viewer}::uuid,${session}::uuid,${serve}::uuid,${repo}::uuid,0,'impression',now()-interval '1 hour',now()-interval '1 hour')`;
    const before=new PostgresFeedPersistence();
    assert.deepEqual((await loadCandidateEligibility(reader,viewer,[repo],7,session)).exposureIds,[]);
    assert.deepEqual(await before.listExcludedRepositoryIds(viewer,session,500),[repo]);
    process.env.FEED_EXPOSURE_RESET_AT=new Date(Date.now()-1000).toISOString();
    const after=new PostgresFeedPersistence();
    const reset=await after.listCandidateEligibility(viewer,[repo],session);
    assert.deepEqual(reset.exposureIds,[repo]);
    assert.deepEqual(reset.servedIds,[]);
    assert.deepEqual(await after.listExcludedRepositoryIds(viewer,session,500),[]);
    assert.deepEqual(await after.listServedRepositoryIds(viewer,session,[repo]),[]);
    assert.deepEqual((await loadCandidateEligibility(reader,other,[repo],7,session)).exposureIds,[repo]);
    const replay=await after.getServeByRequest(viewer,request);
    assert.equal(replay?.serve_id,serve);
    assert.equal(replay?.items[0]?.repo_id,repo,'reset preserves exact historical delivery for replay and attribution');
    const {processInteractionBatchV2}=await import('../../services/activityV2Service.js');
    assert.equal((await processInteractionBatchV2(viewer,[{schema_version:2,event_id:randomUUID(),session_id:session,serve_id:serve,
      repo_id:repo,position:0,event_type:'impression',dwell_ms:null,client_occurred_at:new Date(Date.now()-3600000).toISOString(),context:{}}])).accepted,1);
    assert.deepEqual(await after.listExcludedRepositoryIds(viewer,session,500),[], 'late pre-reset impressions must not restore viewing exclusions');
    assert.deepEqual((await after.listCandidateEligibility(viewer,[repo],session)).exposureIds,[repo]);
    const [repository]=await after.listActiveRepositories([repo],viewer);
    await after.createServe({feed_request_id:randomUUID(),user_id:viewer,session_id:session,feed_version:1n,generation_id:null,
      source:'personalized',model_version:'test',next_cursor:null,
      items:[{repo_id:repo,position:0,score:1,source:'semantic',model_version:'test',summary_id:null,repository:repository!}]});
    assert.deepEqual((await loadCandidateEligibility(reader,viewer,[repo],7,session)).exposureIds,[]);
    assert.deepEqual(await after.listServedRepositoryIds(viewer,session,[repo]),[repo]);
    assert.equal((await processInteractionBatchV2(viewer,[{schema_version:2,event_id:randomUUID(),session_id:session,serve_id:serve,
      repo_id:repo,position:0,event_type:'like',dwell_ms:null,client_occurred_at:new Date().toISOString(),context:{}}])).accepted,1,
      'pending action on a pre-reset delivery must still be accepted');
  } finally {
    if(previous===undefined)delete process.env.FEED_EXPOSURE_RESET_AT;else process.env.FEED_EXPOSURE_RESET_AT=previous;
    await sql`DELETE FROM app.users WHERE user_id=ANY(${[viewer,other]}::uuid[])`;
    await sql`DELETE FROM app.repos WHERE repo_id=${repo}::uuid`;
    await sql`DELETE FROM auth.users WHERE id=ANY(${[viewer,other]}::uuid[])`;
  }
});


test('exposure reset configuration accepts past UTC instants and rejects unsafe cutoffs',async () => {
  const {feedExposureResetAt}=await import('../../config/feedExposure.js');
  assert.equal(feedExposureResetAt(''), '1970-01-01T00:00:00.000Z');
  assert.equal(feedExposureResetAt('2020-01-01T00:00:00Z'), '2020-01-01T00:00:00.000Z');
  for(const raw of ['invalid','2020-02-31T00:00:00Z',new Date(Date.now()+60000).toISOString()]) {
    assert.throws(() => feedExposureResetAt(raw), /UTC ISO timestamp in the past/);
  }
});
