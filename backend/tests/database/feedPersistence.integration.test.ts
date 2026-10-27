import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { sqlClient } from '../../db/index.js';
import { PostgresFeedPersistence } from '../../adapters/postgresFeedPersistence.js';
import { FeedExposureChangedError, FeedPreferenceChangedError, FeedServeOverlapError } from '../../ports/feedPersistencePort.js';
import type { CreateServeInput, RepositoryProjection } from '../../contracts/feed.v2.js';
import { deriveReadmeMediaManifest } from '../../services/readmeMediaManifest.js';
import { assertDisposableDatabase } from './disposableDatabase.js';
function ordinaryFeedVersion(value: string | number): number {
  assert.equal(typeof value, 'number', 'This fixture implements only ordinary recommendation responses');
  assert.ok(Number.isSafeInteger(value));
  return value as number;
}

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
    const f = await fixture(count);
    await sqlClient`INSERT INTO app.repo_content(repo_id,content_hash,content_version,readme)
      SELECT repo_id,'feed-identity-'||repo_id::text,7,'# Canonical README'
      FROM unnest(${f.repos}::uuid[]) AS input(repo_id)`;
    await persistence.getFeedVersion(f.user); // Normal requests initialize state before reserving cards.
    const queries:string[]=[]; const previous=sqlClient.options.debug;
    sqlClient.options.debug=(_connection,query)=>{queries.push(query);};
    const start=performance.now(); let created;
    try {created=await persistence.createServe(f.input);} finally {sqlClient.options.debug=previous;}
    console.log('SERVE_MEASURE '+JSON.stringify({count,statements:queries.length,ms:Math.round(performance.now()-start)}));
    assert.equal(queries.filter(query=>/INSERT INTO telemetry.feed_serve_items/i.test(query)).length,1);
    assert.equal(queries.filter(query=>/^\s*SELECT[\s\S]*FROM telemetry.feed_serves/i.test(query)).length,0);
    assert.equal(queries.filter(query=>query.includes('recent AS MATERIALIZED')).length,1);
    // Bounded preference/exposure reads and the session fence serialize delivery.

    assert.equal(queries.filter(query=>/SELECT user_id,model_policy_sha256[\s\S]*FROM app.user_feed_state[\s\S]*FOR UPDATE/i.test(query)).length,1);
    assert.equal(queries.filter(query=>/SELECT model_policy_sha256[\s\S]*FOR UPDATE/i.test(query)).length,0, 'Reuse the already locked feed row');
    assert.equal(queries.filter(query=>/negative\.reaction='dislike'/i.test(query)).length,1);
    // One locked state row, one eligibility snapshot and one atomic item/provenance insert.
    assert.ok(queries.length<=8,`new serve took ${queries.length} statements`);
    assert.equal(created.items.length,count);
    assert.deepEqual(created.items.map(item=>item.repo_id),f.repos);
    assert.equal(created.created_at,new Date(created.created_at).toISOString());
    const replay=await persistence.getServeByRequest(f.user,f.input.feed_request_id);
    assert.equal(replay?.serve_id,created.serve_id);
    assert.deepEqual(replay?.items.map(item=>[item.repo_id,item.position,item.score,item.summary_id,item.repository.viewer_saved]),
      created.items.map(item=>[item.repo_id,item.position,item.score,item.summary_id,item.repository.viewer_saved]));
    assert.equal(replay?.items[0].repository.content_version,7);
    assert.equal(replay?.items[0].repository.content_hash,`feed-identity-${f.repos[0]}`);
    assert.equal(replay?.items[0].repository.readme_available,true);
  }
});

integration('deferred feed projection omits canonical bytes and replays its version-bound manifest',async()=>{
  const f=await fixture(1); const persistence=new PostgresFeedPersistence();
  const canonical='  # Canonical fixture\r\n\r\n![Screen](https://cdn.example.com/screen.png)\n[Demo](https://cdn.example.com/demo.mp4)\r\n';
  const contentHash='deferred-fixture-hash-v7';
  const manifest=deriveReadmeMediaManifest({markdown:canonical,contentVersion:7,contentHash,
    context:{fullName:`fixture/${f.repos[0]}`,githubUrl:`https://github.com/fixture/${f.repos[0]}`,
      sourcePath:null,defaultBranch:null,baseUrl:null}});
  assert.equal(manifest.representation,'deferred');
  await sqlClient`INSERT INTO app.repo_content(repo_id,content_hash,content_version,readme,readme_media_manifest)
    VALUES(${f.repos[0]}::uuid,${contentHash},7,${canonical},${JSON.stringify(manifest)}::jsonb)`;
  await persistence.getFeedVersion(f.user);

  const deferred=(await persistence.listActiveRepositories(f.repos,f.user,'deferred'))[0];
  const inline=(await persistence.listActiveRepositories(f.repos,f.user,'inline'))[0];
  assert.equal(Object.hasOwn(deferred,'readme_md'),false,'deferred SQL does not project canonical README bytes');
  assert.equal(inline.readme_md,canonical,'legacy SQL retains exact canonical README bytes');
  assert.deepEqual(deferred.readme_media_manifest,manifest);
  assert.equal(deferred.content_version,7);
  assert.equal(deferred.content_hash,contentHash);
  assert.equal(deferred.readme_available,true);

  const fresh=await persistence.createServe({...f.input,readme_mode:'deferred',items:[{
    ...f.input.items[0],repository:deferred,
  }]});
  assert.equal(fresh.readme_mode,'deferred');
  assert.equal(Object.hasOwn(fresh.items[0].repository,'readme_md'),false);
  const replay=await persistence.getServeByRequest(f.user,f.input.feed_request_id);
  assert.equal(replay?.readme_mode,'deferred');
  assert.equal(Object.hasOwn(replay!.items[0].repository,'readme_md'),false,'replay SQL stays on the deferred projection');
  assert.equal(replay?.items[0].repository.readme_available,true);
  assert.equal(replay?.items[0].repository.content_version,7);
  assert.equal(replay?.items[0].repository.content_hash,contentHash);
  assert.deepEqual(replay?.items[0].repository.readme_media_manifest,manifest);
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

integration('concurrent session deliveries serialize final overlap checks including UUID case aliases', async () => {
  const f = await fixture(1);
  const persistence = new PostgresFeedPersistence();
  const competing = { ...f.input, feed_request_id: crypto.randomUUID(),
    session_id: f.session.toUpperCase() };
  const results = await Promise.allSettled([persistence.createServe(f.input), persistence.createServe(competing)]);
  const winners = results.filter(result => result.status === 'fulfilled');
  const losers = results.filter(result => result.status === 'rejected');
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.ok(losers[0].reason instanceof FeedServeOverlapError);
  const winning = winners[0].value;
  const replayInput = winning.feed_request_id === f.input.feed_request_id ? f.input : competing;
  assert.equal((await persistence.createServe(replayInput)).serve_id, winning.serve_id,
    'the same request remains idempotent after another request loses the session race');
  const rows = await sqlClient`SELECT count(*) FROM telemetry.feed_serve_items item
    JOIN telemetry.feed_serves serve ON serve.serve_id=item.serve_id
    WHERE serve.user_id=${f.user}::uuid AND serve.session_id=${f.session}::uuid AND item.repo_id=${f.repos[0]}::uuid`;
  assert.equal(Number(rows[0].count), 1);
  await assert.rejects(persistence.createServe({ ...f.input, feed_request_id: crypto.randomUUID(), session_id: crypto.randomUUID() }),
    FeedExposureChangedError, 'recent delivery also excludes a fresh browsing session');
});

integration('candidate membership finds older session deliveries beyond generation history limit', async () => {
  const f = await fixture(503);
  const persistence = new PostgresFeedPersistence();
  for (let offset = 0; offset < 502; offset += 100) {
    await persistence.createServe({ ...f.input, feed_request_id: crypto.randomUUID(),
      items: f.input.items.slice(offset, Math.min(offset + 100, 502)).map((item, position) => ({ ...item, position })),
    });
  }
  const boundedHistory = await persistence.listExcludedRepositoryIds(f.user, f.session, 500);
  const omitted = f.repos.slice(0, 502).find(id => !boundedHistory.includes(id));
  assert.ok(omitted);
  assert.deepEqual(await persistence.listServedRepositoryIds(f.user, f.session, [omitted, f.repos[502]]), [omitted]);
  assert.deepEqual(await persistence.listServedRepositoryIds(f.user, crypto.randomUUID(), [omitted]), []);
  await assert.rejects(persistence.listServedRepositoryIds(f.user, f.session, f.repos), /bounded candidate/);
});

integration('durable recovery excludes the current session inside its candidate query', async () => {
  const f = await fixture(2);
  const persistence = new PostgresFeedPersistence();
  await sqlClient`INSERT INTO app.repo_content(repo_id,content_hash,content_version)
    SELECT repo_id,'recovery-fixture',1 FROM unnest(${f.repos}::uuid[]) AS candidate(repo_id)`;
  await persistence.createServe(f.input);
  await sqlClient`UPDATE telemetry.feed_serves SET created_at=now()-interval '8 days' WHERE user_id=${f.user}::uuid`;
  const session = crypto.randomUUID();
  await persistence.createServe({ ...f.input, session_id: session, feed_request_id: crypto.randomUUID(), items: [f.input.items[0]] });
  const recovered = await persistence.getRecentPersonalizedEntries(f.user, 1n, 100, [], session);
  assert.deepEqual(recovered.map(entry => entry.repo_id), [f.repos[1]]);
});

integration('UUID case aliases wait on the same session delivery lock', async () => {
  const f = await fixture(1);
  const persistence = new PostgresFeedPersistence();
  let acquired!: () => void;
  let unlock!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const hold = new Promise<void>(resolve => { unlock = resolve; });
  const owner = sqlClient.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('feed-serve:' || ${f.user}::uuid::text || ':' || ${f.session}::uuid::text,0))`;
    acquired(); await hold;
  });
  await ready;
  const creating = persistence.createServe({ ...f.input, session_id: f.session.toUpperCase() });
  try {
    const state = await Promise.race([creating.then(() => 'committed'), new Promise<string>(resolve => setTimeout(() => resolve('waiting'), 50))]);
    assert.equal(state, 'waiting', 'UUID spelling must not bypass another session writer');
  } finally { unlock(); await owner; await creating; }
});

integration('real feed recovery followed by late ML publication serves only unseen continuation candidates', {
  skip: process.env.RUN_REDIS_INTEGRATION !== '1',
}, async () => {
  const { Redis } = await import('ioredis');
  const { RedisFeedQueue } = await import('../../redis/feedQueue.js');
  const { FeedGenerationService } = await import('../../services/feedGenerationService.js');
  const { FeedV2Service } = await import('../../services/feedV2Service.js');
  const f = await fixture(2);
  const persistence = new PostgresFeedPersistence();
  await sqlClient`INSERT INTO app.repo_content(repo_id,content_hash,content_version)
    SELECT repo_id,'late-generation-fixture',1 FROM unnest(${f.repos}::uuid[]) AS candidate(repo_id)`;
  await persistence.recordMlProfileDelivered(f.user, 1n);
  await persistence.createServe({ ...f.input, items: [f.input.items[0]] });
  await sqlClient`UPDATE telemetry.feed_serves SET created_at=now()-interval '8 days' WHERE user_id=${f.user}::uuid`;
  const redis = new Redis(process.env.REDIS_TEST_URL!);
  const queue = new RedisFeedQueue(redis, 30_000);
  let modelStarted!: () => void;
  const started = new Promise<void>(resolve => { modelStarted = resolve; });
  let finishModel!: () => void;
  const model = new Promise<void>(resolve => { finishModel = resolve; });
  const generation = new FeedGenerationService(persistence, queue, { async generate(input) {
    assert.deepEqual(input.exclude_repo_ids, []);
    modelStarted(); await model;
    return { schema_version: 2, generation_id: input.generation_id, user_id: input.user_id,
      feed_version: ordinaryFeedVersion(input.feed_version), model_version: 'late-test', embedding_version: 'test',
      embedding_versions: ['test'], served_ranker: 'hybrid', heavy_ranker_selected: false, ranker_applied: false,
      fallback_code: null, fallback_reason: null, retrieval_mode: 'hybrid',
      context_status: { cold_start_applied: false, locale: 'not_provided' },
      items: f.repos.map(repo_id => ({ repo_id, score: 1, source: 'semantic' })),
    };
  } });
  let generating: ReturnType<typeof generation.generate> | undefined;
  const service = new FeedV2Service(persistence, queue, (user, _limit, excluded, session) => {
    generating = generation.generate(user, 45, excluded, 'live', session); return generating;
  }, false, 1500, 1, 'test-secret', 100);
  const request = { feed_request_id: crypto.randomUUID(), session_id: crypto.randomUUID(), limit: 1, cursor: null };
  try {
    await redis.flushdb();
    const pendingFirst = service.getFeed(f.user, request);
    await started;
    const first = await pendingFirst;
    assert.deepEqual(first.items.map(item => item.repo_id), [f.repos[0]]);
    assert.ok(first.next_cursor);
    finishModel(); await generating;
    const nextRequest = { ...request, feed_request_id: crypto.randomUUID(), cursor: first.next_cursor };
    const next = await service.getFeed(f.user, nextRequest);
    assert.deepEqual(next.items.map(item => item.repo_id), [f.repos[1]]);
    assert.equal(next.items[0].position, 1);
    assert.deepEqual(await service.getFeed(f.user, nextRequest), next);
    const duplicates = await sqlClient`SELECT item.repo_id,count(*) FROM telemetry.feed_serve_items item
      JOIN telemetry.feed_serves serve ON serve.serve_id=item.serve_id
      WHERE serve.user_id=${f.user}::uuid AND serve.session_id=${request.session_id}::uuid
      GROUP BY item.repo_id HAVING count(*)>1`;
    assert.equal(duplicates.length, 0);
  } finally { finishModel(); await service.stop(); await redis.flushdb(); await redis.quit(); }
});

integration('legacy recovery retains an unverified header hint without guessing each item generation',async()=>{
  const f=await fixture(2),persistence=new PostgresFeedPersistence();
  const generationA=crypto.randomUUID(),generationB=crypto.randomUUID();
  // This is the old registered write shape: the header kept the first input
  // generation, while a mixed page's individual generation IDs were not stored.
  const originalEntries=f.input.items.map((item,index)=>({...item,generation_id:index===0?generationA:generationB}));
  const [header]=await sqlClient`INSERT INTO telemetry.feed_serves(feed_request_id,user_id,session_id,feed_version,generation_id,source,model_version)
    VALUES(${f.input.feed_request_id}::uuid,${f.user}::uuid,${f.session}::uuid,1,${originalEntries[0].generation_id}::uuid,'personalized','test') RETURNING serve_id`;
  for(const item of originalEntries){
    await sqlClient`INSERT INTO telemetry.feed_serve_items(serve_id,position,repo_id,score,source,model_version)
      VALUES(${header.serve_id}::uuid,${item.position},${item.repo_id}::uuid,${item.score},${item.source},${item.model_version})`;
    await sqlClient`INSERT INTO app.repo_content(repo_id,content_version,content_hash) VALUES(${item.repo_id}::uuid,1,'fixture-content')`;
  }
  // Recovery tests an old legacy delivery, outside the seven-day exclusion.
  await sqlClient`UPDATE telemetry.feed_serves SET created_at=now()-interval '8 days' WHERE serve_id=${header.serve_id}::uuid`;
  const legacy=await persistence.getRecentPersonalizedEntries(f.user,1n,2,[],crypto.randomUUID());
  assert.deepEqual(legacy.map(item=>item.generation_id),[undefined,undefined],'the header cannot prove the second item generation');
  assert.deepEqual(legacy.map(item=>item.legacy_generation_hint),[generationA,generationA],'preserve the actual old header as an explicitly unverified hint');
  const original=await persistence.getServeByRequest(f.user,f.input.feed_request_id);
  assert.equal(original?.generation_id,generationA);assert.equal(original?.items[1].generation_id,undefined);
  const recovered=await persistence.createServe({...f.input,feed_request_id:crypto.randomUUID(),session_id:crypto.randomUUID(),generation_id:null,
    items:legacy.map((item,position)=>({...item,position,repository:f.input.items[position].repository}))});
  assert.deepEqual(recovered.items.map(item=>item.generation_id),[undefined,undefined]);
  const replay=await persistence.getServeByRequest(f.user,recovered.feed_request_id);
  assert.deepEqual(replay?.items.map(item=>item.legacy_generation_hint),[generationA,generationA]);
  assert.equal(Number((await sqlClient`SELECT count(*) FROM telemetry.feed_item_provenance WHERE serve_id=${recovered.serve_id}::uuid AND capture_status='captured'`)[0].count),0);
});

integration('batched canonical eligibility matches separate preference and exposure reads for each viewer', async () => {
  const f = await fixture();
  const persistence = new PostgresFeedPersistence();
  try {
    await sqlClient`INSERT INTO app.reactions(user_id,repo_id,reaction) VALUES(${f.user}::uuid,${f.repos[0]!}::uuid,'dislike')`;
    const subset: string[] = [f.repos[1]!];
    await persistence.createServe({...f.input, items:f.input.items.filter(item=>subset.includes(item.repo_id))});
    const queries:string[]=[]; const previous=sqlClient.options.debug;
    let result;
    sqlClient.options.debug=(_connection,query)=>queries.push(query);
    try { result=await persistence.listCandidateEligibility(f.user,f.repos); }
    finally { sqlClient.options.debug=previous; }
    assert.equal(queries.length,1,'Identity, preferences and recent exposures use one round trip');
    assert.deepEqual(result.identities.map(row=>row.repo_id).sort(), [...f.repos].sort());
    assert.deepEqual(result.preferenceIds, await persistence.listPreferenceEligibleRepositoryIds(f.user,f.repos));
    assert.deepEqual(result.exposureIds, await persistence.listExposureEligibleRepositoryIds(f.user,f.repos));
    assert.ok(!result.preferenceIds.includes(f.repos[0]!));
    assert.ok(!result.exposureIds.includes(f.repos[1]!));
    const serving=await persistence.listCandidateEligibility(f.user,f.repos,f.session);
    const aliased=await persistence.listCandidateEligibility(f.user,f.repos,f.session.toUpperCase());
    assert.deepEqual(aliased,serving,'Public UUID case aliases preserve candidate and same-session delivery fences');
    assert.deepEqual(serving.servedIds,[f.repos[1]!]);
    assert.deepEqual(serving.repositories?.map(repo=>repo.repo_id).sort(),[...f.repos].sort());
    const {FeedIntentScopeService}=await import('../../services/feedIntentScopeService.js');
    const scopes=new FeedIntentScopeService({} as never);
    const admission=await scopes.admit(f.user,f.session,f.input.feed_request_id);
    assert.equal(admission.hasReplay,true);
    assert.equal(admission.feedVersion,1n);
    assert.equal(admission.snapshot,null);
    await sqlClient`UPDATE app.user_feed_state SET feed_version=2 WHERE user_id=${f.user}::uuid`;
    await assert.rejects(persistence.createServe({...f.input,feed_request_id:crypto.randomUUID(),
      items:f.input.items.filter(item=>item.repo_id===f.repos[2])}),FeedPreferenceChangedError);
    assert.equal((await persistence.createServe({...f.input,items:f.input.items.filter(item=>subset.includes(item.repo_id))})).items.length,1,
      'A historical same-request replay survives a newer feed version');
  } finally {
    await sqlClient`DELETE FROM app.users WHERE user_id=${f.user}::uuid`;
    await sqlClient`DELETE FROM auth.users WHERE id=${f.user}::uuid`;
    await sqlClient`DELETE FROM app.repos WHERE repo_id=ANY(${f.repos}::uuid[])`;
  }
});
