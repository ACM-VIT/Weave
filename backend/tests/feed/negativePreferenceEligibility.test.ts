import assert from 'node:assert/strict';
import test from 'node:test';
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
    try {
      await sql`DELETE FROM app.users WHERE user_id=ANY(${users}::uuid[])`;
      await sql`DELETE FROM app.repos WHERE repo_id=ANY(${repos}::uuid[])`;
      await sql`DELETE FROM auth.users WHERE id=ANY(${users}::uuid[])`;
    } finally {await sql.end({timeout:1});}
  }
});


test('candidate session UUID case aliases normalize without bypassing the served-row fence',async()=>{
  const {loadCandidateEligibility}=await import('../../services/feedExposureEligibility.js');
  const session='abcdef01-abcd-4abc-8abc-abcdef012345';
  const result=await loadCandidateEligibility({query:async(_sql,parameters)=>{
    assert.equal(parameters[3],session);
    return [{repo_id:a,summary_id:null,preference_eligible:true,exposure_eligible:false,session_served:true}];
  }},user,[a],7,session.toUpperCase());
  assert.deepEqual(result.servedIds,[a]);assert.deepEqual(result.exposureIds,[]);
});
