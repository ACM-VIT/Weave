import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

const enabled = process.env.RUN_SHORT_QUERY_INTEGRATION === '1';
// Frozen pre-optimization reference: the extra projections intentionally remain
// here to verify both the exact ordering and actual hydrated counter contract.
const legacyCandidates = `SELECT 'collection:'||c.collection_id::text AS id,c.collection_id AS raw_id,'collection' AS source,
  c.user_id,c.name,c.description,c.icon,c.color,c.created_at,c.updated_at,
  (SELECT count(*)::int FROM app.collection_repos cr JOIN app.repos r USING(repo_id) WHERE cr.collection_id=c.collection_id AND r.status='active') AS repo_count,
  (SELECT count(*)::int FROM app.boards b WHERE b.collection_id=c.collection_id) AS board_count,
  lower(c.name||' '||coalesce(c.description,'')) AS search_text
  FROM app.board_collections c JOIN app.users owner ON owner.user_id=c.user_id AND owner.status='active' WHERE c.user_id=$1::uuid
  UNION ALL SELECT 'legacy-board:'||b.board_id::text,b.board_id,'legacy-board',b.user_id,b.name,b.description,
  NULL::text,NULL::text,b.created_at,NULL::timestamptz,
  (SELECT count(*)::int FROM app.board_repos br JOIN app.repos r USING(repo_id) WHERE br.board_id=b.board_id AND r.status='active'),0,
  lower(b.name||' '||coalesce(b.description,'')) FROM app.boards b
  JOIN app.users owner ON owner.user_id=b.user_id AND owner.status='active' WHERE (b.user_id=$1::uuid OR b.visibility='public')`;

test('short broad List ranking preserves exact references, live counters and account visibility', { skip: !enabled }, async () => {
  const { assertShortQueryTarget } = await import('../../scripts/short-query-policy-evidence.js');
  assertShortQueryTarget(process.env.DATABASE_URL);
  const [{ sqlClient: sql }, { PostgresSearchPersistence, searchPattern }, { SearchService, parseSearchRequest }, { closeSearchSql }] = await Promise.all([
    import('../../db/index.js'), import('../../adapters/postgresSearchPersistence.js'), import('../../services/searchService.js'), import('../../db/searchSqlLane.js'),
  ]);
  const ids = Array.from({ length: 15 }, () => crypto.randomUUID());
  const [viewer, peer, inactive, ownCollection, peerCollection, ownBoard, publicBoard, privateBoard, unlistedBoard, inactiveBoard, nestedBoard, activeRepo, deletedRepo] = ids;
  const suffix = viewer!.slice(0,8), query = 'zq';
  const request = (q=query, group='lists', filters={}) => parseSearchRequest({schema_version:2,search_id:crypto.randomUUID(),query:q,group,filters,limit:50});
  const persistence = new PostgresSearchPersistence();
  const legacy = async (actor: string, q: string) => (await sql.unsafe(`WITH candidates AS (${legacyCandidates}) SELECT id FROM candidates
    WHERE search_text LIKE $2 ORDER BY (lower(name)=lower($3)) DESC,app.explore_similarity(search_text,lower($3)) DESC,id LIMIT 100`,[actor,searchPattern(q),q])).map(row=>String(row.id));
  try {
    await sql`INSERT INTO auth.users(id) SELECT unnest(${[viewer,peer,inactive]}::uuid[])`;
    for (const [id, status] of [[viewer,'active'],[peer,'active'],[inactive,'suspended']] as const) {
      await sql`INSERT INTO app.users(user_id,username,full_name,bio,status) VALUES(${id}::uuid,${'q_'+id!.replaceAll('-','')},'Tarun',${'description-only zqrawlong '+suffix},${status})`;
    }
    for (const [id,name,status] of [[activeRepo,'neutral','active'],[deletedRepo,'deleted','deleted']] as const) {
      await sql`INSERT INTO app.repos(repo_id,github_id,owner,name,full_name,url,status)
        VALUES(${id}::uuid,${String(crypto.randomInt(100_000_000,700_000_000))}::bigint,${suffix},${name},${suffix+'/'+name},${'https://github.com/'+suffix+'/'+name},${status})`;
      await sql`INSERT INTO app.repo_content(repo_id,description,primary_language,content_hash) VALUES(${id}::uuid,'zqrawlong description-only 数据 éé literal %_','TypeScript','short-query-fixture')`;
    }
    await sql`INSERT INTO app.board_collections(collection_id,user_id,name,description) VALUES
      (${ownCollection}::uuid,${viewer}::uuid,'zq','description-only zqrawlong 数据 éé literal %_'),
      (${peerCollection}::uuid,${peer}::uuid,${'other_'+suffix},'zqrawlong')`;
    for (const [id,owner,visibility] of [[ownBoard,viewer,'unlisted'],[publicBoard,peer,'public'],[privateBoard,peer,'private'],[unlistedBoard,peer,'unlisted'],[inactiveBoard,inactive,'public'],[nestedBoard,viewer,'private']] as const) {
      await sql`INSERT INTO app.boards(board_id,user_id,collection_id,name,description,visibility)
        VALUES(${id}::uuid,${owner}::uuid,${id===nestedBoard?ownCollection:null}::uuid,${'board_'+id},'zqrawlong description-only 数据 éé literal %_',${visibility})`;
    }
    for (const repo of [activeRepo,deletedRepo]) {
      await sql`INSERT INTO app.collection_repos(collection_id,repo_id,added_by) VALUES(${ownCollection}::uuid,${repo}::uuid,${viewer}::uuid)`;
      await sql`INSERT INTO app.board_repos(board_id,repo_id,added_by) VALUES(${publicBoard}::uuid,${repo}::uuid,${peer}::uuid)`;
    }
    for (const q of ['zq','zqr','zqrawlong','数据','éé','%_','😀','e\u0301']) for (const actor of [viewer!,peer!]) {
      const actual = await persistence.lists(actor,request(q));
      assert.deepEqual(actual.map(row=>row.id),await legacy(actor,q),`ordered parity for ${q}/${actor}`);
      assert.deepEqual((await persistence.lists(actor,request(q,'lists',{languages:['Python'],topics:['databases']}))).map(row=>row.id),actual.map(row=>row.id),'repository filters retain existing List behavior');
    }
    assert.throws(()=>request('z'));
    const refs = await persistence.lists(viewer!,request());
    const visible = new Set(refs.map(row=>row.id));
    for (const id of [ownCollection,ownBoard,publicBoard,nestedBoard]) assert.ok([...visible].some(ref=>ref.endsWith(id!)));
    for (const id of [peerCollection,privateBoard,unlistedBoard,inactiveBoard]) assert.ok(![...visible].some(ref=>ref.endsWith(id!)));
    const hydrated = await persistence.hydrate(viewer!,refs,request());
    const own = hydrated.find(row=>row.id===`collection:${ownCollection}`)!.data;
    const board = hydrated.find(row=>row.id===`legacy-board:${publicBoard}`)!.data;
    assert.equal(own.repositoryCount,1); assert.equal(own.nestedListCount,1); assert.equal(board.repositoryCount,1);
    // Counts and visibility are current at hydration; ranking references cache neither.
    await sql`UPDATE app.repos SET status='archived' WHERE repo_id=${activeRepo}::uuid`;
    await sql`UPDATE app.boards SET visibility='private' WHERE board_id=${publicBoard}::uuid`;
    const current = await persistence.hydrate(viewer!,refs,request());
    assert.equal(current.find(row=>row.id===`collection:${ownCollection}`)!.data.repositoryCount,0);
    assert.ok(!current.some(row=>row.id===`legacy-board:${publicBoard}`));
    await sql`UPDATE app.repos SET status='active' WHERE repo_id=${activeRepo}::uuid`;
    const semanticQueries: string[]=[];
    const service = new SearchService(persistence,async req=>{semanticQueries.push(req.query);return{schema_version:2,search_id:req.search_id,embedding_version:'fixture',items:[]};});
    for (const q of ['zq','zqr','zqrawlong']) for (const group of ['all','repositories','people','lists']) {
      const result=await service.search(viewer!,request(q,group));
      if(group==='all'||group==='repositories') assert.ok(result.items.some(row=>row.type==='repository'&&row.id===activeRepo),'description-only repository remains searchable');
      if(group==='all'||group==='people') assert.ok(result.items.some(row=>row.type==='person'&&row.id===`user:${peer}`),'bio-only person remains searchable');
    }
    const filtered=await service.search(viewer!,request('zq','repositories',{languages:['Python']}));
    assert.equal(filtered.items.length,0,'repository language filter still removes nonmatching content');
    const unicode=await service.search(viewer!,request('😀','repositories'));
    assert.deepEqual(unicode.items.map(row=>row.id),(await persistence.lexical(request('😀','repositories'))).map(row=>row.id));
    assert.ok(semanticQueries.includes('😀'),'current two-UTF16-unit eligibility is preserved without a counting-policy change');
    await service.search(viewer!,request('zq','repositories'));
    assert.ok(semanticQueries.includes('zq'),'two-character semantic eligibility stays unchanged');
  } finally {
    await sql`DELETE FROM app.users WHERE user_id=ANY(${[viewer,peer,inactive]}::uuid[])`;
    await sql`DELETE FROM auth.users WHERE id=ANY(${[viewer,peer,inactive]}::uuid[])`;
    await sql`DELETE FROM app.repos WHERE repo_id=ANY(${[activeRepo,deletedRepo]}::uuid[])`;
    await closeSearchSql(); await sql.end({timeout:1});
  }
});
