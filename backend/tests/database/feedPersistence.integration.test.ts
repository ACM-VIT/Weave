import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { sqlClient } from '../../db/index.js';
import { PostgresFeedPersistence } from '../../adapters/postgresFeedPersistence.js';
import type { CreateServeInput, RepositoryProjection } from '../../contracts/feed.v2.js';
import { assertDisposableDatabase } from './disposableDatabase.js';
const enabled = process.env.RUN_DATABASE_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();
const integration = enabled ? test : test.skip;
test.after(async () => { if (enabled) await sqlClient.end({timeout:1}); });

async function fixture(count = 3) {
  const user = crypto.randomUUID(), session = crypto.randomUUID();
  const repos = Array.from({length:count},()=>crypto.randomUUID());
  await sqlClient`INSERT INTO auth.users(id) VALUES(${user}::uuid)`;
  await sqlClient`INSERT INTO app.users(user_id,username,status) VALUES(${user}::uuid,${'scroll_'+user.replaceAll('-','')},'active')`;
  await sqlClient`INSERT INTO app.repos(repo_id,github_id,full_name,owner,name,url,status)
    SELECT id,${crypto.randomInt(1_000_000_000)*100}::bigint+n,'fixture/'||id,'fixture',id,'https://github.com/fixture/'||id,'active'
    FROM unnest(${repos}::uuid[]) WITH ORDINALITY AS input(id,n)`;
  const projection = (id:string): RepositoryProjection => ({repo_id:id,full_name:`fixture/${id}`,owner_user_id:null,
    owner_profile_id:null,owner_profile_claimed_user_id:null,owner_bio:null,description:null,primary_language:null,
    languages:[],topics:[],star_count:0,fork_count:0,likes_count:0,comments_count:0,views_count:0,open_issues_count:0,
    summary_id:null,summary:null,summary_highlights:[],summary_prompt_version:null,summary_model_version:null,summary_format_version:null,summary_source:null,readme_source_path:null,readme_default_branch:null,readme_base_url:null,readme_md:null,updated_at:null,viewer_reaction:null,viewer_saved:false,
    viewer_follows_owner:false,status:'active'});
  const input: CreateServeInput = {feed_request_id:crypto.randomUUID(),user_id:user,session_id:session,feed_version:1n,
    generation_id:null,source:'personalized',model_version:'test',next_cursor:'next',
    items:repos.map((id,position)=>({repo_id:id,position,score:position/100,source:'semantic',model_version:'test',
      summary_id:null,repository:projection(id)}))};
  return {user,session,repos,input};
}

integration('new serves use one item insert for 1, 24 and 50 cards without follow-up hydration',async()=>{
  const persistence = new PostgresFeedPersistence();
  for (const count of [1,24,50]) {
    const f = await fixture(count); const queries:string[]=[]; const previous=sqlClient.options.debug;
    sqlClient.options.debug=(_connection,query)=>{queries.push(query);};
    const start=performance.now(); let created;
    try {created=await persistence.createServe(f.input);} finally {sqlClient.options.debug=previous;}
    console.log('SERVE_MEASURE '+JSON.stringify({count,statements:queries.length,ms:Math.round(performance.now()-start)}));
    assert.equal(queries.filter(query=>/INSERT INTO telemetry.feed_serve_items/i.test(query)).length,1);
    assert.equal(queries.filter(query=>/SELECT[\s\S]*FROM telemetry.feed_serves/i.test(query)).length,1);
    // Five bounded statements serialize current preferences and exposure with activity:
    // user lock, feed initialization, feed lock, preference and exposure reads.
    assert.equal(queries.filter(query=>/FROM app.user_feed_state[\s\S]*FOR UPDATE/i.test(query)).length,1);
    assert.equal(queries.filter(query=>/negative\.reaction='dislike'/i.test(query)).length,1);
    assert.ok(queries.length<=10,`new serve took ${queries.length} statements`);
    assert.equal(created.items.length,count);
    assert.deepEqual(created.items.map(item=>item.repo_id),f.repos);
    assert.equal(created.created_at,new Date(created.created_at).toISOString());
    const replay=await persistence.getServeByRequest(f.user,f.input.feed_request_id);
    assert.equal(replay?.serve_id,created.serve_id);
    assert.deepEqual(replay?.items.map(item=>[item.repo_id,item.position,item.score,item.summary_id,item.repository.viewer_saved]),
      created.items.map(item=>[item.repo_id,item.position,item.score,item.summary_id,item.repository.viewer_saved]));
  }
});

integration('concurrent duplicate writes return one durable serve and keep exact position order',async()=>{
  const f=await fixture(); const persistence=new PostgresFeedPersistence();
  const input={...f.input,items:[...f.input.items].reverse()};
  const results=await Promise.all([persistence.createServe(input),persistence.createServe(input)]);
  assert.equal(results[0].serve_id,results[1].serve_id);
  for (const result of results) assert.deepEqual(result.items.map(item=>item.position),[0,1,2]);
  assert.equal(Number((await sqlClient`SELECT count(*) FROM telemetry.feed_serves WHERE feed_request_id=${input.feed_request_id}::uuid`)[0].count),1);
  assert.equal(Number((await sqlClient`SELECT count(*) FROM telemetry.feed_serve_items WHERE serve_id=${results[0].serve_id}::uuid`)[0].count),3);
});

integration('invalid duplicate positions roll back the header; empty serves commit without an item insert',async()=>{
  const f=await fixture(); const persistence=new PostgresFeedPersistence();
  await assert.rejects(persistence.createServe({...f.input,items:f.input.items.map(item=>({...item,position:0}))}));
  assert.equal(await persistence.getServeByRequest(f.user,f.input.feed_request_id),null);
  const empty=await persistence.createServe({...f.input,items:[]});
  assert.deepEqual(empty.items,[]);
  assert.deepEqual((await persistence.getServeByRequest(f.user,f.input.feed_request_id))?.items,[]);
});

integration('existing feed-version reads do not wait on a competing state write or emit an UPDATE',async()=>{
  const f=await fixture(); const persistence=new PostgresFeedPersistence();
  await sqlClient`INSERT INTO app.user_feed_state(user_id,feed_version) VALUES(${f.user}::uuid,7)`;
  let unlock!:()=>void; let locked!:()=>void;
  const held=new Promise<void>(resolve=>{unlock=resolve;}); const acquired=new Promise<void>(resolve=>{locked=resolve;});
  const writer=sqlClient.begin(async tx=>{await tx`SELECT user_id FROM app.user_feed_state WHERE user_id=${f.user}::uuid FOR UPDATE`;locked();await held;});
  await acquired;
  const reading=persistence.getFeedVersion(f.user);
  let timer:ReturnType<typeof setTimeout>|undefined;
  let beforeUnlock;
  try {beforeUnlock=await Promise.race([reading,new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),250);})]);}
  finally {if(timer)clearTimeout(timer);unlock();await writer;}
  assert.equal(beforeUnlock,7n);
  assert.equal(await reading,7n);
});

integration('first-read initialization remains race safe and cannot reset an incremented version',async()=>{
  const f=await fixture();const persistence=new PostgresFeedPersistence();
  assert.deepEqual(await Promise.all(Array.from({length:5},()=>persistence.getFeedVersion(f.user))),[1n,1n,1n,1n,1n]);
  await sqlClient`UPDATE app.user_feed_state SET feed_version=9 WHERE user_id=${f.user}::uuid`;
  assert.equal(await persistence.getFeedVersion(f.user),9n);
});

integration('exclusions isolate accounts, include recent cross-session serves and bound history',async()=>{
  const f=await fixture();const other=await fixture();const persistence=new PostgresFeedPersistence();
  await persistence.createServe(f.input);
  await sqlClient`INSERT INTO telemetry.user_repo_engagement(user_id,repo_id,impressions,last_event_at)
    VALUES(${f.user}::uuid,${f.repos[0]}::uuid,1,now()),(${other.user}::uuid,${f.repos[1]}::uuid,1,now())`;
  const api=persistence as unknown as {listExcludedRepositoryIds(user:string,session:string|undefined,limit:number):Promise<string[]>};
  assert.deepEqual(new Set(await api.listExcludedRepositoryIds(f.user,undefined,500)),new Set(f.repos));
  assert.deepEqual(new Set(await api.listExcludedRepositoryIds(f.user,f.session,500)),new Set(f.repos));
  assert.deepEqual(new Set(await api.listExcludedRepositoryIds(f.user,other.session,500)),new Set(f.repos));
  assert.equal((await api.listExcludedRepositoryIds(f.user,f.session,2)).length,2);
});

integration('creation preserves a queued summary identity when the current hydrated summary has changed',async()=>{
  const f=await fixture(1);const persistence=new PostgresFeedPersistence();
  const queuedSummary=crypto.randomUUID(), currentSummary=crypto.randomUUID();
  await sqlClient`INSERT INTO app.repo_content(repo_id,content_hash,content_version)
    VALUES(${f.repos[0]}::uuid,'feed-summary-fixture',1)`;
  await sqlClient`INSERT INTO app.repo_card_summaries(
      summary_id,repo_id,content_version,prompt_version,model_version,format_version,source,summary,active)
    VALUES(${queuedSummary}::uuid,${f.repos[0]}::uuid,1,'repo-card-summary-v1','queued-model',
             'repo-card-summary-json-v1','generated','Queued summary',false),
          (${currentSummary}::uuid,${f.repos[0]}::uuid,1,'repo-card-summary-v1','current-model',
             'repo-card-summary-json-v1','generated','New active summary',true)`;
  const [identity] = await persistence.listActiveRepositoryIdentities(f.repos);
  assert.equal(identity.summary_id, currentSummary);
  const [hydrated] = await persistence.listActiveRepositories(f.repos, f.user);
  assert.equal(hydrated.summary_id, currentSummary);
  assert.equal(hydrated.summary_prompt_version, 'repo-card-summary-v1');
  assert.equal(hydrated.summary_format_version, 'repo-card-summary-json-v1');
  assert.equal(hydrated.summary_source, 'generated');
  f.input.items[0].summary_id=queuedSummary;
  f.input.items[0].repository={...f.input.items[0].repository,summary_id:currentSummary,summary:'New active summary'};
  const result=await persistence.createServe(f.input);
  assert.equal(result.items[0].summary_id,queuedSummary);
  assert.equal(result.items[0].repository.summary,'Queued summary');
  assert.equal(result.items[0].repository.summary_id,queuedSummary);
});
