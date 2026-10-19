import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sqlClient } from '../../db/index.js';
import { PostgresSearchPersistence } from '../../adapters/postgresSearchPersistence.js';
import { parseSearchRequest, SearchService, type SearchRef } from '../../services/searchService.js';
import { semanticSearch } from '../../controllers/searchController.js';
import redisClient from '../../config/redis.js';
import { RedisSearchSnapshotStore } from '../../adapters/redisSearchSnapshotStore.js';

test.after(async () => { redisClient.disconnect(); });

const integration = process.env.RUN_SEARCH_INTEGRATION === '1' ? test : test.skip;
const ids: string[] = Array.from({length:16},()=>crypto.randomUUID());
const [viewer,other,claimed,external,repo,deleted,archived,unknown,ownCollection,otherCollection,publicBoard,privateBoard,unlistedBoard] = ids;
const repo2 = ids[13];
const persistence = new PostgresSearchPersistence();
const request = (extra = {}) => parseSearchRequest({schema_version:2,search_id:crypto.randomUUID(),query:'phase4needle',...extra});

integration('isolated PostgreSQL search: hydration, people deduplication, List privacy, filters and reversible migration', async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname) && url.pathname==='/weave_phase4','Only the disposable Phase 4 database is permitted.');
  const migration = await fs.readFile(new URL('../../../database/migrations/0024_explore_search.sql',import.meta.url),'utf8');
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
    // A reused handle with a different numeric GitHub identity must remain discoverable.
    await sqlClient`UPDATE app.users SET github_handle='phase4external' WHERE user_id=${other}::uuid`;
    await sqlClient`UPDATE app.social_profiles SET provider_subject='987654321' WHERE profile_id=${external}::uuid`;
    assert.ok((await persistence.people(request())).some(p=>p.id===`profile:${external}`));
    await sqlClient`UPDATE app.users SET github_id='987654321' WHERE user_id=${other}::uuid`;
    assert.ok(!(await persistence.people(request())).some(p=>p.id===`profile:${external}`));
    await sqlClient`UPDATE app.social_profiles SET provider_subject=NULL WHERE profile_id=${external}::uuid`;
    assert.ok(!(await persistence.people(request())).some(p=>p.id===`profile:${external}`));
    await sqlClient`UPDATE app.users SET github_id='123456789',github_handle='phase4claimed' WHERE user_id=${other}::uuid`;
    const lists = await persistence.lists(viewer,request());
    assert.deepEqual(new Set(lists.map(v=>v.id)),new Set([`collection:${ownCollection}`,`legacy-board:${publicBoard}`]));
    assert.equal((await persistence.lists(other,request())).length,4);
    const refs: SearchRef[] = [unknown,deleted,archived,repo2,repo].map(id=>({type:'repository',id}));
    const hydrated = await persistence.hydrate(viewer,refs);
    assert.deepEqual(new Set(hydrated.map(v=>v.id)),new Set([repo,repo2]));
    assert.equal(hydrated.find(v=>v.id===repo)?.data.full_name,'owner/vision');
    assert.deepEqual((await persistence.lexical(request())).map(v=>v.id),[repo]);
    assert.equal((await persistence.lexical(request({filters:{languages:['Rust']}}))).length,0);
    assert.equal((await persistence.hydrate(viewer,refs,request({filters:{languages:['Rust']}}))).length,0);
    assert.equal((await persistence.hydrate(viewer,refs,request({filters:{topics:['missing-search-topic']}}))).length,0);
    assert.equal((await persistence.lexical(request({query:'%%'}))).length,0);
    const service = new SearchService(persistence,async req=>({schema_version:2,search_id:req.search_id,embedding_version:'test',items:refs.map((ref,index)=>({repo_id:ref.id,score:0.99-index*.01}))}), Date.now, new RedisSearchSnapshotStore(redisClient));
    const response = await service.search(viewer,request({group:'repositories',query:`image understanding ${repo}`}));
    assert.deepEqual(response.items.map(v=>v.id),[repo2,repo], 'conceptual query survives without lexical words in repository name/description');
    const paged = request({group:'lists',limit:1});
    const page1 = await service.search(viewer,paged);
    await sqlClient`UPDATE app.boards SET visibility='private' WHERE board_id=${publicBoard}::uuid`;
    const otherInstance = new SearchService(persistence, async () => { throw new Error('Cursor must reuse the shared ranking'); }, Date.now, new RedisSearchSnapshotStore(redisClient));
    const page2 = await otherInstance.search(viewer,{...paged,cursor:page1.next_cursor});
    assert.ok(!page2.items.some(v=>v.id===`legacy-board:${publicBoard}`),'changed visibility is rechecked on pagination');

    const runtimeUrl = new URL(process.env.DATABASE_URL!);
    runtimeUrl.searchParams.set('options', '-c role=ghsocial_backend');
    await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { PostgresSearchPersistence } from './adapters/postgresSearchPersistence.ts';
      import { parseSearchRequest } from './services/searchService.ts';
      import { sqlClient } from './db/index.ts';
      try {
        assert.equal((await sqlClient\`SELECT current_user AS role\`)[0].role, 'ghsocial_backend');
        const persistence = new PostgresSearchPersistence();
        const request = parseSearchRequest(${JSON.stringify(request())});
        assert.deepEqual((await persistence.lexical(request)).map(row => row.id), [${JSON.stringify(repo)}]);
        assert.ok(!(await persistence.lists(${JSON.stringify(viewer)},request)).some(row => row.id === ${JSON.stringify(`collection:${otherCollection}`)}));
        assert.equal((await persistence.hydrate(${JSON.stringify(viewer)}, [{type:'repository',id:${JSON.stringify(repo)}}], request)).length, 1);
      } finally { await sqlClient.end({timeout:1}); }
    `], { cwd: new URL('../../', import.meta.url), env: { ...process.env, DATABASE_URL: runtimeUrl.toString() } });

    process.env.JWT_SECRET = 'search-integration-test-secret';
    await sqlClient`INSERT INTO app.repo_engagement(repo_id) VALUES (${repo}::uuid),(${repo2}::uuid)`;
    await sqlClient`
      INSERT INTO app.trending_snapshots(snapshot_id,period,source,computed_at,complete,active)
      VALUES (${ids[14]}::uuid,'weekly','search-test','2026-10-18T00:00:00Z',true,false),
        (${ids[15]}::uuid,'weekly','search-test','2026-10-19T00:00:00Z',true,true)
    `;
    await sqlClient`
      INSERT INTO app.trending_snapshot_items(snapshot_id,position,repo_id,score,features)
      VALUES (${ids[14]}::uuid,1,${repo2}::uuid,0.5,'{}'),
        (${ids[15]}::uuid,7,${repo}::uuid,0.9,'{"delta_stars":42}')
    `;
    const { default: routes } = await import('../../routes/productV2Routes.js');
    const app = express();
    app.use(express.json());
    app.use('/api/v2', routes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v2`;
    const headers = { authorization: `Bearer ${jwt.sign({ userId: viewer, email: 'search@example.test' }, process.env.JWT_SECRET)}`, 'content-type': 'application/json' };
    try {
      assert.equal((await fetch(`${base}/search`, { method: 'POST' })).status, 401);
      assert.equal((await fetch(`${base}/search`, { method: 'POST', headers, body: JSON.stringify({ ...request(), query: 'x' }) })).status, 400);
      const response = await fetch(`${base}/search`, { method: 'POST', headers, body: JSON.stringify(request({ group: 'lists' })) });
      assert.equal(response.status, 200);
      const payload = await response.json() as { data: { items: SearchRef[] } };
      assert.deepEqual(payload.data.items.map(item => item.id), [`collection:${ownCollection}`]);
      assert.equal((await fetch(`${base}/repositories/trending?period=yearly`, { headers })).status, 400);
      const trending = await fetch(`${base}/repositories/trending`, { headers });
      assert.equal(trending.status, 200);
      const ranked = (await trending.json() as { data: {
        period: string; available_periods: string[]; captured_at: string;
        items: { repo_id: string; position: number; features: { delta_stars: number } }[];
      } }).data;
      assert.equal(ranked.period, 'weekly');
      assert.deepEqual(ranked.available_periods, ['weekly']);
      assert.equal(ranked.captured_at, '2026-10-19T00:00:00.000Z');
      assert.deepEqual(ranked.items.map((item: { repo_id: string }) => item.repo_id), [repo]);
      assert.equal(ranked.items[0].position, 7);
      assert.equal(ranked.items[0].features.delta_stars, 42);
      const stalePeriod = await fetch(`${base}/repositories/trending?period=monthly`, { headers });
      assert.equal((await stalePeriod.json() as { data: { period: string } }).data.period, 'weekly', 'removed periods fall back to an available snapshot');
      await sqlClient`UPDATE app.trending_snapshots SET period='daily' WHERE snapshot_id=${ids[15]}::uuid`;
      const missingWeekly = await fetch(`${base}/repositories/trending?period=weekly`, { headers });
      const daily = (await missingWeekly.json() as { data: { period: string; available_periods: string[]; items: { repo_id: string }[] } }).data;
      assert.equal(daily.period, 'daily');
      assert.deepEqual(daily.available_periods, ['daily']);
      assert.deepEqual(daily.items.map(item => item.repo_id), [repo]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    const rollback = await fs.readFile(new URL('../../../database/rollbacks/0024_explore_search.sql',import.meta.url),'utf8');
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
    await sqlClient`DELETE FROM app.trending_snapshots WHERE snapshot_id=ANY(${[ids[14],ids[15]]}::uuid[])`;
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
