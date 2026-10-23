import assert from 'node:assert/strict';
import test from 'node:test';
import {canonicalGithubRepositoryId,mergeRepositoryLineage,validateRepositoryLineage,type RepositoryLineage} from '../../services/repositoryLineage.js';
const known:RepositoryLineage={is_fork:true,fork_parent_github_id:'2',fork_family_github_id:'3',lineage_source:'github-graphql-repository',lineage_observed_at:'2026-10-23T00:00:00.000002Z'};
test('lineage validates exact decimal identities and explicit observed ancestry',()=>{
  assert.equal(canonicalGithubRepositoryId('0009223372036854775807'),'9223372036854775807');
  for(const value of ['0','-1','9223372036854775808',1,1.2])assert.throws(()=>canonicalGithubRepositoryId(value));
  validateRepositoryLineage({},'1');validateRepositoryLineage(known,'1');
  for(const value of [
    {...known,is_fork:'false'}, {...known,fork_parent_github_id:'01'}, {...known,fork_family_github_id:'1'},
    {...known,is_fork:false}, {...known,is_fork:null}, {...known,lineage_source:null},
    {...known,lineage_source:'inferred-name'}, {...known,lineage_observed_at:'2026-10-23T00:00:00'},
    {...known,lineage_observed_at:'2026-02-30T00:00:00Z'},
  ])assert.throws(()=>validateRepositoryLineage(value as RepositoryLineage,'1'));
});
test('missing and stale observations cannot erase known family, including submillisecond updates',()=>{
  assert.deepEqual(mergeRepositoryLineage({},known,'1'),known);
  assert.deepEqual(mergeRepositoryLineage({...known,fork_family_github_id:'4',lineage_observed_at:'2026-10-23T00:00:00.000001Z'},known,'1'),known);
  assert.throws(()=>mergeRepositoryLineage({...known,fork_family_github_id:'4'},known,'1'),/Conflicting/);
  const later={...known,fork_family_github_id:'4',lineage_observed_at:'2026-10-23T00:00:00.000003Z'};
  assert.deepEqual(mergeRepositoryLineage(later,known,'1'),later);
});
test('explicit newer unknown ancestry stays unknown and nonfork does not invent a family',()=>{
  const unknown={is_fork:null,lineage_source:'github-rest-repository' as const,lineage_observed_at:'2026-10-24T00:00:00Z'};
  const result=mergeRepositoryLineage(unknown,known,'1');
  assert.equal(result.fork_family_github_id,null);assert.equal(result.is_fork,null);
  validateRepositoryLineage({is_fork:false,lineage_source:'github-rest-repository',lineage_observed_at:'2026-10-24T00:00:00Z'},'1');
});

const integrationEnabled=process.env.RUN_REPOSITORY_LINEAGE_INTEGRATION==='1';
test('real lineage migration reapplies and enforces observed identities without losing microseconds', {skip:!integrationEnabled},async()=>{
  const target=new URL(process.env.DATABASE_URL??'');
  assert.notEqual(process.env.NODE_ENV,'production');
  assert.ok(['postgres:','postgresql:'].includes(target.protocol));
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname));
  assert.equal(target.pathname,'/weave_repository_lineage_test');assert.equal(target.search,'');assert.equal(target.hash,'');
  const {readFile}=await import('node:fs/promises');
  const {randomInt}=await import('node:crypto');
  const {sqlClient:sql}=await import('../../db/index.js');
  const base=BigInt(Date.now())*1000n+BigInt(randomInt(1000));const ids:string[]=[];
  const insert=async (state:unknown,parent:unknown,family:unknown,source:unknown,time:unknown)=>{
    const id=(base+BigInt(ids.length)).toString();ids.push(id);
    const record={github_id:id,is_fork:state,fork_parent_github_id:parent,
      fork_family_github_id:family==='self'?id:family,lineage_source:source,lineage_observed_at:time};
    await sql`INSERT INTO app.repos(github_id,full_name,owner,name,url,is_fork,fork_parent_github_id,
        fork_family_github_id,lineage_source,lineage_observed_at)
      SELECT github_id::bigint,'lineage-fixture/'||github_id,'lineage-fixture',github_id,
        'https://github.com/lineage-fixture/'||github_id,is_fork,fork_parent_github_id::bigint,
        fork_family_github_id::bigint,lineage_source,lineage_observed_at::timestamptz
      FROM jsonb_to_recordset(${JSON.stringify([record])}::text::jsonb) AS incoming(
        github_id text,is_fork boolean,fork_parent_github_id text,fork_family_github_id text,
        lineage_source text,lineage_observed_at text)`;
    return id;
  };
  try {
    const migration=await readFile(new URL('../../../database/migrations/0038_repository_lineage.sql',import.meta.url),'utf8');
    await sql.unsafe(migration);await sql.unsafe(migration);
    await insert(null,null,null,null,null);
    const precise=await insert(true,null,null,'github-graphql-repository','2026-10-23T00:00:00.000001Z');
    await insert(false,null,'self','github-rest-repository','2026-10-23T00:00:00Z');
    await insert(true,'2','3','github-rest-repository','2026-10-23T00:00:00Z');
    for(const [state,parent,family,source,time] of [
      [null,'2',null,null,null],[false,'2','self','github-rest-repository','2026-10-23Z'],
      [false,null,'2','github-rest-repository','2026-10-23Z'],
      [true,null,'self','github-rest-repository','2026-10-23Z'],
      [true,'0','2','github-rest-repository','2026-10-23Z'],
      [true,'2','-1','github-rest-repository','2026-10-23Z'],[true,null,null,null,null],
      [true,null,null,'inferred-name','2026-10-23Z'],[null,null,null,'github-rest-repository',null],
      [null,null,null,null,'2026-10-23Z'],[true,null,null,'github-rest-repository','infinity'],
    ])await assert.rejects(insert(state,parent,family,source,time),(error:unknown)=>(error as {code?:string}).code==='23514');
    const [row]=await sql`SELECT to_char(lineage_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed
      FROM app.repos WHERE github_id=${precise}::bigint`;
    assert.equal(row.observed,'2026-10-23T00:00:00.000001Z');

    const {PostgresRepositoryPersistence}=await import('../../adapters/postgresRepositoryPersistence.js');
    const persistence=new PostgresRepositoryPersistence(sql);
    const githubId=(base+100n).toString(),ownerId=(base+101n).toString();ids.push(githubId);
    const owner='lineage-'+base.toString();
    const seed={github_id:githubId,owner_github_id:ownerId,owner,name:'repository',full_name:owner+'/repository',
      url:'https://github.com/'+owner+'/repository',description:'Isolated lineage fixture.',topics:['testing'],
      observed_at:'2026-10-23T01:00:00Z',is_fork:true,fork_parent_github_id:'222',fork_family_github_id:'333',
      lineage_source:'github-graphql-repository' as const,lineage_observed_at:'2026-10-23T00:00:00.000002Z'};
    const [first]=await persistence.bulkUpsert([seed]);
    assert.equal(first.content_version,1);
    const indices=async()=>await sql`SELECT payload FROM telemetry.ml_outbox
      WHERE aggregate_id=${first.repo_id}::uuid AND job_type='repo_index' ORDER BY (payload->>'content_version')::integer`;
    const initial=(await indices())[0].payload.repository;
    assert.equal(initial.owner_github_id,ownerId);assert.equal(initial.fork_family_github_id,'333');
    assert.equal(initial.lineage_observed_at,seed.lineage_observed_at);
    const [poll]=await persistence.bulkUpsert([{...seed,observed_at:'2026-10-23T02:00:00Z',lineage_observed_at:'2026-10-23T00:00:00.000003Z'}]);
    assert.equal(poll.changed,false);assert.equal(poll.content_version,1);assert.equal((await indices()).length,1);
    const [stale]=await persistence.bulkUpsert([{...seed,observed_at:'2026-10-23T03:00:00Z',
      lineage_observed_at:'2026-10-23T00:00:00.000001Z',fork_family_github_id:'444'}]);
    assert.equal(stale.changed,false);assert.equal(stale.content_version,1);
    const material={...seed,observed_at:'2026-10-23T04:00:00Z',
      lineage_observed_at:'2026-10-23T00:00:00.000004Z',fork_family_github_id:'444'};
    const [changed]=await persistence.bulkUpsert([material]);
    assert.equal(changed.content_version,2);assert.equal(changed.repo_id,first.repo_id);
    assert.equal((await indices())[1].payload.repository.fork_family_github_id,'444');
    const beforeConflict=await sql`SELECT count(*)::integer AS n FROM telemetry.ml_outbox WHERE aggregate_id=${first.repo_id}::uuid`;
    await assert.rejects(persistence.bulkUpsert([{...material,observed_at:'2026-10-23T05:00:00Z',fork_family_github_id:'555'}]),/Conflicting lineage/);
    assert.deepEqual(await sql`SELECT count(*)::integer AS n FROM telemetry.ml_outbox WHERE aggregate_id=${first.repo_id}::uuid`,beforeConflict);
    // Numeric account identity is stable; repository ownership can transfer.
    // This tests existing transfer behavior, not a new global freshness policy.
    const nextOwner='transferred-'+base.toString();
    const transferred={...seed,owner_github_id:(base+102n).toString(),owner:nextOwner,
      full_name:nextOwner+'/repository',url:'https://github.com/'+nextOwner+'/repository',observed_at:'2026-10-23T06:00:00Z'};
    delete (transferred as Partial<typeof transferred>).is_fork;
    delete (transferred as Partial<typeof transferred>).fork_parent_github_id;
    delete (transferred as Partial<typeof transferred>).fork_family_github_id;
    delete (transferred as Partial<typeof transferred>).lineage_source;
    delete (transferred as Partial<typeof transferred>).lineage_observed_at;
    const [transfer]=await persistence.bulkUpsert([transferred]);
    assert.equal(transfer.repo_id,first.repo_id);assert.equal(transfer.content_version,3);
    assert.equal((await indices())[2].payload.repository.owner_github_id,transferred.owner_github_id);
    assert.equal((await indices())[2].payload.repository.fork_family_github_id,'444','Omission preserves known ancestry.');
    const [state]=await sql`SELECT fork_family_github_id::text,
      to_char(lineage_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed
      FROM app.repos WHERE repo_id=${first.repo_id}::uuid`;
    assert.equal(state.observed,material.lineage_observed_at);assert.equal(state.fork_family_github_id,'444');
    const [unknown]=await persistence.bulkUpsert([{...transferred,is_fork:null,fork_parent_github_id:null,
      fork_family_github_id:null,lineage_source:'github-rest-repository',lineage_observed_at:'2026-10-23T00:00:00.000005Z',
      observed_at:'2026-10-23T07:00:00Z'}]);
    assert.equal(unknown.content_version,4);
    const unknownPayload=(await indices())[3].payload.repository;
    assert.equal(Object.hasOwn(unknownPayload,'is_fork'),false);
    assert.equal(Object.hasOwn(unknownPayload,'fork_family_github_id'),false);
    assert.equal(unknownPayload.lineage_source,'github-rest-repository');
    const [cleared]=await sql`SELECT is_fork,fork_family_github_id FROM app.repos WHERE repo_id=${first.repo_id}::uuid`;
    assert.equal(cleared.is_fork,null);assert.equal(cleared.fork_family_github_id,null);

    await Promise.all([
      persistence.bulkUpsert([{...transferred,is_fork:true,fork_parent_github_id:'222',fork_family_github_id:'888',
        lineage_source:'github-graphql-repository',lineage_observed_at:'2026-10-23T00:00:00.000006Z',observed_at:'2026-10-23T08:00:00Z'}]),
      persistence.bulkUpsert([{...transferred,is_fork:true,fork_parent_github_id:'222',fork_family_github_id:'777',
        lineage_source:'github-graphql-repository',lineage_observed_at:'2026-10-23T00:00:00.000004Z',observed_at:'2026-10-23T09:00:00Z'}]),
    ]);
    const [concurrent]=await sql`SELECT fork_family_github_id::text FROM app.repos WHERE repo_id=${first.repo_id}::uuid`;
    assert.equal(concurrent.fork_family_github_id,'888','Existing ingestion locks serialize a concurrent stale observation behind the latest lineage.');

    const jobs=await sql`SELECT payload FROM telemetry.ml_outbox WHERE aggregate_id=${first.repo_id}::uuid AND job_type='repo_refresh'`;
    assert.ok(jobs.some(job=>job.payload.required_content_version===3));
    assert.ok(jobs.every(job=>!Object.hasOwn(job.payload.features,'fork_family_github_id')));

  }finally{
    try{
      await sql`DELETE FROM telemetry.ml_outbox WHERE aggregate_id IN (SELECT repo_id FROM app.repos WHERE github_id=ANY(${ids}::bigint[]))`;
      await sql`DELETE FROM app.repos WHERE github_id=ANY(${ids}::bigint[])`;
      await sql`DELETE FROM app.social_profiles WHERE provider='github' AND claimed_by_user_id IS NULL
        AND provider_subject=ANY(${[(base+101n).toString(),(base+102n).toString()]}::text[])`;
    }finally{await sql.end({timeout:1});}
  }
});
