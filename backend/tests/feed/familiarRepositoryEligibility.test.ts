import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import test from 'node:test';
import {loadNegativePreferenceEligibleIds} from '../../services/negativePreferenceEligibility.js';
const enabled=process.env.RUN_FAMILIAR_REPOSITORY_INTEGRATION==='1';
test('known GitHub repositories are viewer-scoped exclusions with a durable fresh-serve fence',{skip:!enabled},async()=>{
  const target=new URL(process.env.DATABASE_URL??'');
  assert.notEqual(process.env.NODE_ENV,'production');
  assert.ok(['127.0.0.1','localhost'].includes(target.hostname));
  assert.equal(target.pathname,'/weave_negative_preferences_test');
  const {sqlClient:sql}=await import('../../db/index.js');
  const {PostgresFeedPersistence}=await import('../../adapters/postgresFeedPersistence.js');
  const {FeedPreferenceChangedError}=await import('../../ports/feedPersistencePort.js');
  const users=[randomUUID(),randomUUID()];const [viewer,peer]=users;
  const githubId=String(800000000000+randomInt(1000000));
  const ids=Array.from({length:5},()=>randomUUID());
  const extraOwnedIds=Array.from({length:501},()=>randomUUID());
  const [owned,starred,contributed,novel,sameOrg]=ids;
  const githubIds=ids.map((_,i)=>String(900000000000+randomInt(1000000)*10+i));
  const snapshot=randomUUID();const persistence=new PostgresFeedPersistence();
  const reader={query:async(text:string,parameters:readonly unknown[])=>[...await sql.unsafe(text,parameters as never)]};
  try {
    for(const id of users){
      await sql`INSERT INTO auth.users(id) VALUES(${id}::uuid)`;
      await sql`INSERT INTO app.users(user_id,username,status,github_id,github_identity_verified_at)
        VALUES(${id}::uuid,${'familiar_'+id.replaceAll('-','')},'active',${id===viewer?githubId:null},${id===viewer?new Date().toISOString():null})`;
      await sql`INSERT INTO app.user_feed_state(user_id,feed_version) VALUES(${id}::uuid,1)`;
    }
    for(let i=0;i<ids.length;i++){
      const owner=i===0?githubId:'777777777777';const name='repo_'+ids[i];
      await sql`INSERT INTO app.repos(repo_id,github_id,owner_github_id,owner,name,full_name,url,status)
        VALUES(${ids[i]}::uuid,${githubIds[i]}::bigint,${owner}::bigint,'familiar',${name},${'familiar/'+name},${'https://github.com/familiar/'+name},'active')`;
      await sql`INSERT INTO app.repo_content(repo_id,description,content_hash) VALUES(${ids[i]}::uuid,'Fixture source',${'a'.repeat(64)})`;
    }
    const provenance={repository_ids:[{github_id:githubIds[1],sources:['starred']},{github_id:githubIds[2],sources:['contributed']}]};
    await sql`INSERT INTO app.user_github_imports(user_id,github_id,accepted_at,provenance)
      VALUES(${viewer!}::uuid,${githubId},now(),${JSON.stringify(provenance)}::jsonb)`;
    assert.deepEqual(new Set(await loadNegativePreferenceEligibleIds(reader,viewer!,ids)),new Set([novel,sameOrg]));
    assert.deepEqual(new Set(await loadNegativePreferenceEligibleIds(reader,peer!,ids)),new Set(ids));
    const hints=await persistence.listExcludedRepositoryIds(viewer!,undefined,500);
    for(const id of [owned,starred,contributed])assert.ok(hints.includes(id!),'ML hints exclude familiar repos before ranking');
    assert.ok(!hints.includes(sameOrg!),'organization membership is not a blanket exclusion');
    await sql`INSERT INTO app.trending_snapshots(snapshot_id,period,source,computed_at,activated_at,complete,active)
      VALUES(${snapshot}::uuid,${'familiar_'+snapshot},'fixture',now(),now(),true,true)`;
    for(let i=0;i<ids.length;i++)await sql`INSERT INTO app.trending_snapshot_items(snapshot_id,position,repo_id) VALUES(${snapshot}::uuid,${i},${ids[i]}::uuid)`;
    assert.deepEqual((await persistence.getTrendingFallback(1,[],viewer!)).map(row=>row.repo_id),[novel]);
    const [repository]=await persistence.listActiveRepositories([novel!],viewer!);
    assert.ok(repository);
    const input={feed_request_id:randomUUID(),user_id:viewer!,session_id:randomUUID(),feed_version:1n,generation_id:null,
      source:'personalized' as const,model_version:'fixture',next_cursor:null,
      items:[{repo_id:novel!,score:1,source:'semantic',model_version:'fixture',summary_id:null,position:0,repository:repository!}]};
    const served=await persistence.createServe(input);
    provenance.repository_ids.push({github_id:githubIds[3]!,sources:['contributed']});
    await sql`UPDATE app.user_github_imports SET provenance=${JSON.stringify(provenance)}::jsonb WHERE user_id=${viewer!}::uuid`;
    await sql`UPDATE telemetry.feed_serves SET created_at=now()-interval '8 days' WHERE serve_id=${served.serve_id}::uuid`;
    assert.deepEqual(await persistence.getRecentPersonalizedEntries(viewer!,1n,1,[],randomUUID()),[], 'durable recovery filters familiar candidates before LIMIT');
    await assert.rejects(persistence.createServe({...input,feed_request_id:randomUUID(),session_id:randomUUID()}),FeedPreferenceChangedError);
    assert.equal((await persistence.createServe(input)).serve_id,served.serve_id,'durable historical replay is unchanged');
    await sql`UPDATE app.user_github_imports SET revoked_at=now() WHERE user_id=${viewer!}::uuid`;
    assert.deepEqual(new Set(await loadNegativePreferenceEligibleIds(reader,viewer!,ids)),new Set([starred,contributed,novel,sameOrg]));
    assert.deepEqual((await persistence.getRecentPersonalizedEntries(viewer!,1n,1,[],randomUUID())).map(row=>row.repo_id),[novel]);
    // Familiarity must not displace the original recent-history hints, even
    // when the owner has enough repositories to fill the entire ML contract.
    const ownedRows=extraOwnedIds.map((repo_id,index)=>({repo_id,github_id:String(990000000000000+index),
      owner_github_id:githubId,name:'history_'+repo_id,full_name:'familiar/history_'+repo_id,
      url:'https://github.com/familiar/history_'+repo_id}));
    await sql`INSERT INTO app.repos(repo_id,github_id,owner_github_id,owner,name,full_name,url,status)
      SELECT repo_id::uuid,github_id::bigint,owner_github_id::bigint,'familiar',name,full_name,url,'active'
      FROM jsonb_to_recordset(${JSON.stringify(ownedRows)}::jsonb)
        AS row(repo_id text,github_id text,owner_github_id text,name text,full_name text,url text)`;
    await sql`UPDATE telemetry.feed_serves SET created_at=now() WHERE serve_id=${served.serve_id}::uuid`;
    for(const repoId of [novel,sameOrg])await sql`INSERT INTO telemetry.interaction_events
      (event_id,schema_version,user_id,repo_id,session_id,event_type,client_occurred_at)
      VALUES(${randomUUID()}::uuid,2,${viewer!}::uuid,${repoId!}::uuid,${input.session_id}::uuid,'github_open',now())`;
    await sql`INSERT INTO telemetry.interaction_events
      (event_id,schema_version,user_id,repo_id,session_id,event_type,client_occurred_at,server_received_at)
      VALUES(${randomUUID()}::uuid,2,${viewer!}::uuid,${owned!}::uuid,${input.session_id}::uuid,
        'github_open',now()-interval '1 day',now()-interval '1 day')`;
    const boundedHints=await persistence.listExcludedRepositoryIds(viewer!,input.session_id,500);
    assert.equal(boundedHints.length,500);
    assert.equal(new Set(boundedHints).size,500,'overlapping serve and interaction hints are deduplicated');
    assert.ok(boundedHints.includes(novel!),'recent serves retain hint slots under familiarity saturation');
    assert.ok(boundedHints.includes(sameOrg!),'recent interactions retain hint slots under familiarity saturation');
    assert.deepEqual(await persistence.listExcludedRepositoryIds(viewer!,input.session_id,2),[novel,sameOrg],
      'small budgets retain the original serve-before-interaction history ordering');
    assert.deepEqual(await persistence.listExcludedRepositoryIds(viewer!,input.session_id,3),[novel,sameOrg,owned],
      'familiarity does not inflate older interaction timestamps ahead of genuine newer history');
    await sql`UPDATE app.users SET github_identity_verified_at=NULL WHERE user_id=${viewer!}::uuid`;
    assert.deepEqual(new Set(await loadNegativePreferenceEligibleIds(reader,viewer!,ids)),new Set(ids));
  }finally{
    try{
      await sql`DELETE FROM app.trending_snapshots WHERE snapshot_id=${snapshot}::uuid`;
      await sql`DELETE FROM app.users WHERE user_id=ANY(${users}::uuid[])`;
      await sql`DELETE FROM app.repos WHERE repo_id=ANY(${[...ids,...extraOwnedIds]}::uuid[])`;
      await sql`DELETE FROM auth.users WHERE id=ANY(${users}::uuid[])`;
    }finally{await sql.end({timeout:1});}
  }
});
