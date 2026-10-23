import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSocialNeighborhoodRows, PUBLIC_SOCIAL_NEIGHBORHOODS_SQL } from '../../services/socialNeighborhoodProjection.js';
const user = '00000000-0000-4000-8000-000000000001';
const repo = '00000000-0000-4000-8000-000000000002';
const row = { repo_id:repo,owner_github_id:'123',source:'followed_like',actor_key:`public-like:${user}`,star_count:5 };

test('social neighborhood loader uses one viewer-bound snapshot and returns source evidence without product data', async () => {
  let calls = 0;
  const result = await loadSocialNeighborhoodRows({ query:async (sql,parameters) => {
    calls++; assert.equal(sql,PUBLIC_SOCIAL_NEIGHBORHOODS_SQL); assert.deepEqual(parameters,[user,'[]']);
    return [row,{...row,source:'board_topic',actor_key:`public-board-owner:${user}`},
      {...row,source:'adjacent_interest',actor_key:`own-positive-seed:${repo}`}];
  } },user);
  assert.equal(calls,1);
  await loadSocialNeighborhoodRows({ query:async (_sql,parameters) => {
    assert.deepEqual(parameters,[user,JSON.stringify([repo])]); return [];
  } },user,[repo.toUpperCase(),repo]);
  assert.deepEqual(result.map(item => item.source),['followed_like','board_topic','adjacent_interest']);
  assert.ok(result.every(item => item.viewer_can_access && item.actor_active && item.signal_allowed));
  assert.ok(result.every(item => !('description' in item) && !('readme' in item) && !('score' in item)));
});

test('neighborhood loader rejects invalid viewers before SQL and rejects malformed/unbounded evidence', async () => {
  let calls = 0;
  await assert.rejects(loadSocialNeighborhoodRows({ query:async () => { calls++; return []; } },'mutable-handle'),/canonical UUID/);
  await assert.rejects(loadSocialNeighborhoodRows({ query:async () => { calls++; return []; } },user,['mutable-repo']),/bounded canonical/);
  await assert.rejects(loadSocialNeighborhoodRows({ query:async () => { calls++; return []; } },user,Array(1501).fill(repo)),/bounded canonical/);
  assert.equal(calls,0);
  for (const patch of [{owner_github_id:'handle'},{owner_github_id:'9223372036854775808'},
    {repo_id:'name/repo'},{source:'followed_save'},{star_count:-1},
    {actor_key:`public-board-owner:${user}`},{actor_key:'public-like:'+'-'.repeat(36)}]) {
    await assert.rejects(loadSocialNeighborhoodRows({ query:async () => [{...row,...patch}] },user),/canonical/);
  }
  await assert.rejects(loadSocialNeighborhoodRows({ query:async () => Array(10001).fill(row) },user),/budget/);
});

test('SQL discovery policy includes only public boards, public likes and viewer-owned private seeds', () => {
  assert.match(PUBLIC_SOCIAL_NEIGHBORHOODS_SQL,/board\.visibility='public'/);
  assert.doesNotMatch(PUBLIC_SOCIAL_NEIGHBORHOODS_SQL,/unlisted|collection_repos|board_collections/);
  assert.match(PUBLIC_SOCIAL_NEIGHBORHOODS_SQL,/saved\.user_id IN \(SELECT user_id FROM viewer\)/);
  assert.match(PUBLIC_SOCIAL_NEIGHBORHOODS_SQL,/follow\.follower_id IN \(SELECT user_id FROM viewer\)/);
  assert.match(PUBLIC_SOCIAL_NEIGHBORHOODS_SQL,/'public-board-owner:'\|\|board\.user_id/);
  assert.match(PUBLIC_SOCIAL_NEIGHBORHOODS_SQL,/repo\.owner_github_id>0/);
  assert.match(PUBLIC_SOCIAL_NEIGHBORHOODS_SQL,/LIMIT 10001/);
});

const integrationEnabled = process.env.RUN_PUBLIC_SOCIAL_NEIGHBORHOODS_INTEGRATION === '1';
test('real SQL neighborhoods exclude private/unlisted discovery and other accounts saved activity', { skip:!integrationEnabled },async () => {
  const target = new URL(process.env.DATABASE_URL ?? '');
  assert.notEqual(process.env.NODE_ENV,'production');
  assert.ok(['postgres:','postgresql:'].includes(target.protocol));
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname));
  assert.equal(target.pathname,'/weave_social_neighborhoods_test');
  assert.equal(target.search,''); assert.equal(target.hash,'');
  const { randomUUID } = await import('node:crypto');
  const { sqlClient:sql } = await import('../../db/index.js');
  const users = Array.from({length:4},() => randomUUID());
  const [viewer,a,b,inactive] = users;
  const repos = Array.from({length:6},() => randomUUID());
  const [seed,publicRepo,privateRepo,unlistedRepo,otherSaved,ownAdjacent] = repos;
  const boards:string[] = []; const topic = 'social-fixture-'+randomUUID();
  try {
    for (const [index,id] of users.entries()) {
      await sql`INSERT INTO auth.users(id) VALUES(${id}::uuid)`;
      await sql`INSERT INTO app.users(user_id,username,status) VALUES(${id}::uuid,${'n_'+id.replaceAll('-','')},${index===3?'suspended':'active'})`;
    }
    for (const [index,id] of repos.entries()) {
      await sql`INSERT INTO app.repos(repo_id,github_id,owner_github_id,full_name,owner,name,url,status)
        VALUES(${id}::uuid,${String(BigInt('0x'+id.replaceAll('-','').slice(0,13)))}::bigint,${String(100+index)}::bigint,
        ${'neighborhood/'+id},'neighborhood',${id},${'https://github.com/neighborhood/'+id},'active')`;
      await sql`INSERT INTO app.repo_stat_snapshots(repo_id,star_count,observed_at) VALUES(${id}::uuid,10,now())`;
    }
    await sql`INSERT INTO app.reactions(user_id,repo_id,reaction) VALUES(${viewer!}::uuid,${seed!}::uuid,'like')`;
    for (const actor of [a,b,inactive]) {
      await sql`INSERT INTO app.follows(follower_id,following_id) VALUES(${viewer!}::uuid,${actor!}::uuid)`;
      await sql`INSERT INTO app.reactions(user_id,repo_id,reaction) VALUES(${actor!}::uuid,${publicRepo!}::uuid,'like')`;
      await sql`INSERT INTO app.reactions(user_id,repo_id,reaction) VALUES(${actor!}::uuid,${seed!}::uuid,'like')`;
    }
    await sql`INSERT INTO app.saves(user_id,repo_id) VALUES(${a!}::uuid,${otherSaved!}::uuid)`;
    const [t] = await sql`INSERT INTO app.topics(slug,display_name) VALUES(${topic},'fixture') RETURNING topic_id`;
    for (const id of [seed,ownAdjacent]) await sql`INSERT INTO app.repo_topics(repo_id,topic_id) VALUES(${id!}::uuid,${t!.topic_id})`;
    for (const [owner,visibility,candidate] of [
      [a,'public',publicRepo],[a,'public',publicRepo],[b,'public',publicRepo],
      [a,'private',privateRepo],[a,'unlisted',unlistedRepo],
    ] as const) {
      const board = randomUUID(); boards.push(board);
      await sql`INSERT INTO app.boards(board_id,user_id,name,visibility) VALUES(${board}::uuid,${owner!}::uuid,${'fixture-'+board},${visibility})`;
      for (const id of [seed,candidate]) await sql`INSERT INTO app.board_repos(board_id,repo_id,added_by)
        VALUES(${board}::uuid,${id!}::uuid,${owner!}::uuid)`;
    }
    const reader = { query:async (text:string,parameters:readonly string[]) => [...await sql.unsafe(text,[...parameters])] };
    const result = await loadSocialNeighborhoodRows(reader,viewer!);
    assert.equal(new Set(result.filter(r => r.source==='followed_like' && r.repo_id===publicRepo).map(r => r.actor_key)).size,2);
    assert.equal(new Set(result.filter(r => r.source==='board_topic' && r.repo_id===publicRepo).map(r => r.actor_key)).size,2,
      'Two boards from one owner cannot inflate distinct owner support.');
    assert.ok(result.some(r => r.source==='adjacent_interest' && r.repo_id===ownAdjacent));
    assert.equal(new Set(result.filter(r => r.source==='co_like' && r.repo_id===publicRepo).map(r => r.actor_key)).size,2);
    const {PostgresFeedPersistence}=await import('../../adapters/postgresFeedPersistence.js');
    const projected=await new PostgresFeedPersistence().listSocialRepositoryCandidates(viewer!,100);
    for (const source of ['followed_like','co_like','board_topic']) {
      const candidate=projected.find(row => row.source===source && row.repo_id===publicRepo);
      assert.equal(candidate?.support,2,`Actual projection must deduplicate supporters for ${source}`);
    }
    assert.ok(projected.some(row => row.source==='adjacent_interest' && row.repo_id===ownAdjacent));
    assert.ok(projected.every(row => !('actor_key' in row)));
    assert.ok(result.every(r => ![privateRepo,unlistedRepo,otherSaved,seed].includes(r.repo_id as typeof seed)));
    // Fill each recent public source sample with excluded entries. The older
    // eligible candidate must survive all source caps, not merely a final filter.
    const excluded: string[] = Array.from({length:20},()=>randomUUID()); repos.push(...excluded);
    await sql`INSERT INTO app.repos(repo_id,github_id,owner_github_id,full_name,owner,name,url,status)
      SELECT id,${String(Date.now()*100)}::bigint+n,1000+n,'excluded/'||id,'excluded',id::text,'https://github.com/excluded/'||id,'active'
      FROM unnest(${excluded}::uuid[]) WITH ORDINALITY AS incoming(id,n)`;
    await sql`INSERT INTO app.repo_stat_snapshots(repo_id,star_count,observed_at) SELECT unnest(${excluded}::uuid[]),10,now()`;
    await sql`INSERT INTO app.reactions(user_id,repo_id,reaction,updated_at)
      SELECT actor,id,'like','2030-01-01'::timestamptz FROM unnest(${[a!,b!]}::uuid[]) actor CROSS JOIN unnest(${excluded}::uuid[]) id`;
    await sql`INSERT INTO app.board_repos(board_id,repo_id,added_by,added_at)
      SELECT board.board_id,id,board.user_id,'2030-01-01'::timestamptz FROM app.boards board
      CROSS JOIN unnest(${excluded}::uuid[]) id WHERE board.board_id=ANY(${boards.slice(0,3)}::uuid[])`;
    const withoutExclusions = await new PostgresFeedPersistence().listSocialRepositoryCandidates(viewer!,100);
    for (const source of ['followed_like','co_like','board_topic']) assert.ok(!withoutExclusions.some(row=>row.source===source&&row.repo_id===publicRepo), `${source} fixture must reproduce crowding before filtering`);
    const afterCaps = await new PostgresFeedPersistence().listSocialRepositoryCandidates(viewer!,100,excluded);
    for (const source of ['followed_like','co_like','board_topic']) {
      assert.ok(afterCaps.some(row=>row.source===source&&row.repo_id===publicRepo),`${source} excluded sample must not crowd out older evidence`);
    }
    assert.ok(afterCaps.every(row=>!excluded.includes(row.repo_id)));
    assert.deepEqual(await new PostgresFeedPersistence().listSocialRepositoryCandidates(viewer!,100,[...excluded,publicRepo!,ownAdjacent!]),[]);
    const otherViewer = await loadSocialNeighborhoodRows(reader,b!);
    assert.ok(otherViewer.every(r => r.source!=='followed_like'),'Another viewer cannot inherit the first viewer follows.');
    assert.deepEqual(await loadSocialNeighborhoodRows(reader,inactive!),[],'Suspended viewers have no candidate evidence.');
    await sql`UPDATE app.boards SET visibility='private' WHERE user_id=${b!}::uuid`;
    const revoked = await loadSocialNeighborhoodRows(reader,viewer!);
    assert.equal(new Set(revoked.filter(r => r.source==='board_topic').map(r => r.actor_key)).size,1);
    assert.ok(!(await new PostgresFeedPersistence().listSocialRepositoryCandidates(viewer!,100))
      .some(row => row.source==='board_topic'),'Visibility revocation below minimum support removes the source.');
    const postgres=(await import('postgres')).default;
    const blocker=postgres(process.env.DATABASE_URL!,{max:1,prepare:false});
    let release!:()=>void; let locked!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const acquired=new Promise<void>(resolve=>{locked=resolve;});
    const holding=blocker.begin(async tx=>{
      await tx`LOCK TABLE app.reactions IN ACCESS EXCLUSIVE MODE`;
      locked(); await gate;
    });
    await acquired;
    try {
      await assert.rejects(new PostgresFeedPersistence().listSocialRepositoryCandidates(viewer!,100),
        (error:unknown)=>typeof error==='object' && error!==null && 'code' in error && error.code==='57014',
        'The real server cancels blocked social source reads at the local statement deadline.');
    } finally {release();await holding;await blocker.end({timeout:1});}
    assert.ok((await new PostgresFeedPersistence().listSocialRepositoryCandidates(viewer!,100)).length>0,
      'Timed-out read rolls back and subsequent queries recover.');
  } finally {
    try {
      await sql`DELETE FROM app.boards WHERE board_id=ANY(${boards}::uuid[])`;
      await sql`DELETE FROM app.repos WHERE repo_id=ANY(${repos}::uuid[])`;
      await sql`DELETE FROM app.topics WHERE slug=${topic}`;
      await sql`DELETE FROM app.users WHERE user_id=ANY(${users}::uuid[])`;
      await sql`DELETE FROM auth.users WHERE id=ANY(${users}::uuid[])`;
    } finally { await sql.end({timeout:1}); }
  }
});
