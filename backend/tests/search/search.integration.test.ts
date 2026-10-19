import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { sqlClient } from '../../db/index.js';
import { PostgresSearchPersistence } from '../../adapters/postgresSearchPersistence.js';
import { parseSearchRequest, SearchService, type SearchRef } from '../../services/searchService.js';
import { semanticSearch } from '../../controllers/searchController.js';

const integration = process.env.RUN_SEARCH_INTEGRATION === '1' ? test : test.skip;
const ids: string[] = Array.from({length:16},()=>crypto.randomUUID());
const [viewer,other,claimed,external,repo,deleted,archived,unknown,ownCollection,otherCollection,publicBoard,privateBoard,unlistedBoard] = ids;
const repo2 = ids[13];
const persistence = new PostgresSearchPersistence();
const request = (extra = {}) => parseSearchRequest({schema_version:2,search_id:crypto.randomUUID(),query:'phase4needle',...extra});

integration('isolated PostgreSQL search: hydration, people deduplication, List privacy, filters and reversible migration', async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname) && url.pathname==='/weave_phase4','Only the disposable Phase 4 database is permitted.');
  const migration = await fs.readFile(new URL('../../../database/migrations/0025_explore_search.sql',import.meta.url),'utf8');
  try {
    await sqlClient.unsafe(migration).simple();
    await sqlClient`INSERT INTO auth.users(id,raw_user_meta_data) VALUES (${viewer}::uuid,'{}'::jsonb),(${other}::uuid,'{}'::jsonb)`;
    await sqlClient`INSERT INTO app.users(user_id,username,full_name,bio,github_id,github_handle,github_identity_verified_at) VALUES
      (${viewer}::uuid,${`viewer_${viewer}`},'phase4needle viewer','profile text',NULL,NULL,NULL),
      (${other}::uuid,${`other_${other}`},'phase4needle other','conceptual person','123456789','phase4claimed',now())`;
    await sqlClient`INSERT INTO app.social_profiles(profile_id,handle,display_name,provider_subject,claimed_by_user_id,profile_kind) VALUES
      (${claimed}::uuid,'phase4claimed','phase4needle claimed','123456789',${other}::uuid,'user'),
      (${external}::uuid,'phase4external','phase4needle external',NULL,NULL,'user')`;
    for (const [id,name,status] of [[repo,'vision','active'],[deleted,'deleted','deleted'],[archived,'archived','archived'],[repo2,'canonical-active-two','active']]) {
      await sqlClient`INSERT INTO app.repos(repo_id,github_id,owner,full_name,name,url,status)
        VALUES (${id!}::uuid,${String(ids.indexOf(id!)+99000000)}::bigint,'owner',${`owner/${name}`},${name!},${`https://github.com/owner/${name}`},${status!})`;
      await sqlClient`INSERT INTO app.repo_content(repo_id,description,primary_language,content_hash) VALUES (${id!}::uuid,${id === repo2 ? 'Database utilities' : 'phase4needle image models'},'Python','search-integration')`;
    }
    await sqlClient`INSERT INTO app.board_collections(collection_id,user_id,name) VALUES
      (${ownCollection}::uuid,${viewer}::uuid,'phase4needle own'),(${otherCollection}::uuid,${other}::uuid,'phase4needle private collection')`;
    for (const [id,visibility] of [[publicBoard,'public'],[privateBoard,'private'],[unlistedBoard,'unlisted']]) {
      await sqlClient`INSERT INTO app.boards(board_id,user_id,name,visibility) VALUES(${id!}::uuid,${other}::uuid,${`phase4needle ${visibility}`},${visibility!})`;
    }
    const people = await persistence.people(request());
    assert.equal(people.filter(p=>p.id===`user:${other}`).length,1);
    assert.ok(!people.some(p=>p.id===`profile:${claimed}`));
    assert.ok(people.some(p=>p.id===`profile:${external}`));
    const lists = await persistence.lists(viewer,request());
    assert.deepEqual(new Set(lists.map(v=>v.id)),new Set([`collection:${ownCollection}`,`legacy-board:${publicBoard}`]));
    assert.equal((await persistence.lists(other,request())).length,4);
    const refs: SearchRef[] = [unknown,deleted,archived,repo2,repo].map(id=>({type:'repository',id}));
    const hydrated = await persistence.hydrate(viewer,refs);
    assert.deepEqual(new Set(hydrated.map(v=>v.id)),new Set([repo,repo2]));
    assert.equal(hydrated.find(v=>v.id===repo)?.data.full_name,'owner/vision');
    assert.deepEqual((await persistence.lexical(request())).map(v=>v.id),[repo]);
    assert.equal((await persistence.lexical(request({filters:{languages:['Rust']}}))).length,0);
    assert.equal((await persistence.lexical(request({query:'%%'}))).length,0);
    const service = new SearchService(persistence,async req=>({schema_version:2,search_id:req.search_id,embedding_version:'test',items:refs.map((ref,index)=>({repo_id:ref.id,score:0.99-index*.01}))}));
    const response = await service.search(viewer,request({group:'repositories',query:`image understanding ${repo}`}));
    assert.deepEqual(response.items.map(v=>v.id),[repo2,repo], 'conceptual query survives without lexical words in repository name/description');
    const paged = request({group:'lists',limit:1});
    const page1 = await service.search(viewer,paged);
    await sqlClient`UPDATE app.boards SET visibility='private' WHERE board_id=${publicBoard}::uuid`;
    const page2 = await service.search(viewer,{...paged,cursor:page1.next_cursor});
    assert.ok(!page2.items.some(v=>v.id===`legacy-board:${publicBoard}`),'changed visibility is rechecked on pagination');
    const rollback = await fs.readFile(new URL('../../../database/rollbacks/0025_explore_search.sql',import.meta.url),'utf8');
    await sqlClient.unsafe(migration).simple();await sqlClient.unsafe(migration).simple();
    await sqlClient.unsafe(rollback).simple();await sqlClient.unsafe(rollback).simple();
    await sqlClient`CREATE SCHEMA IF NOT EXISTS phase4_extensions`;
    await sqlClient`ALTER EXTENSION pg_trgm SET SCHEMA phase4_extensions`;
    await sqlClient.unsafe(migration).simple();
    assert.equal((await persistence.lexical(request())).length,1,'search works with a preinstalled extension outside public');
    await sqlClient.begin(async tx => {
      await tx`SET LOCAL ROLE ghsocial_backend`;
      const compared = await tx`SELECT app.explore_similarity('vision','vision') AS score`;
      assert.equal(compared[0].score,1,'the actual backend role can execute namespaced trigram search');
    });
    await sqlClient`ALTER EXTENSION pg_trgm SET SCHEMA public`;
    await sqlClient.unsafe(migration).simple();
    const indexes = await sqlClient`SELECT indexname FROM pg_indexes WHERE schemaname='app' AND indexname IN ('repos_active_search_trgm','users_active_search_trgm','boards_public_search_trgm')`;
    assert.equal(indexes.length,3);
  } finally {
    await sqlClient`DELETE FROM app.social_profiles WHERE profile_id=ANY(${[claimed,external]}::uuid[])`;
    await sqlClient`DELETE FROM app.users WHERE user_id=ANY(${[viewer,other]}::uuid[])`;
    await sqlClient`DELETE FROM app.repos WHERE repo_id=ANY(${[repo,repo2,deleted,archived]}::uuid[])`;
    await sqlClient.end({timeout:1});
  }
});

integration('real authenticated ML HTTP transport times out into lexical fallback', async () => {
  let secret: string | undefined; let path: string | undefined;
  const server = http.createServer((req) => {secret=String(req.headers['x-internal-secret']);path=req.url;});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address = server.address() as {port:number};
  const previous = {url:process.env.ML_SERVICE_URL,secret:process.env.INTERNAL_API_SECRET};
  process.env.ML_SERVICE_URL=`http://127.0.0.1:${address.port}`;process.env.INTERNAL_API_SECRET='phase4-local-secret';
  try {
    const service = new SearchService({lexical:async()=>[{id:repo,exact:true}],people:async()=>[],lists:async()=>[],hydrate:async(_v,refs)=>refs.map(ref=>({...ref,data:{}}))},semanticSearch);
    const result = await service.search(viewer,request({group:'repositories'}));
    assert.equal(result.mode,'lexical');assert.equal(result.items[0].id,repo);
    assert.equal(secret,'phase4-local-secret');assert.equal(path,'/api/v2/search/repositories');
  } finally {
    if(previous.url===undefined) delete process.env.ML_SERVICE_URL;else process.env.ML_SERVICE_URL=previous.url;
    if(previous.secret===undefined) delete process.env.INTERNAL_API_SECRET;else process.env.INTERNAL_API_SECRET=previous.secret;
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
