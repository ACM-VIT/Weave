import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { assertDisposableDatabase } from './disposableDatabase.js';
import type { RepositoryUpsert } from '../../contracts/ingestion.v2.js';

const enabled = process.env.RUN_DATABASE_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();
const integration = enabled ? test : test.skip;
test.after(async()=>{if(enabled){const {sqlClient}=await import('../../db/index.js');await sqlClient.end({timeout:1});}});

integration('create-only graph discovery preserves rich content and races safely with canonical ingestion', async () => {
  const [{ sqlClient }, { PostgresRepositoryPersistence }] = await Promise.all([
    import('../../db/index.js'), import('../../adapters/postgresRepositoryPersistence.js'),
  ]);
  const persistence = new PostgresRepositoryPersistence();
  const githubIds = Array.from({ length: 3 }, () => String(crypto.randomInt(1_000_000_000, 2_000_000_000)));
  const ownerId = String(crypto.randomInt(2_000_000_000, 3_000_000_000));
  const owner = `discovery-${ownerId}`;
  const record = (id: string): RepositoryUpsert => ({ github_id: id, owner_github_id: ownerId,
    owner, name: `repo-${id}`, full_name: `${owner}/repo-${id}`, url: `https://github.com/${owner}/repo-${id}`,
    description: 'Source-provided description', primary_language: 'TypeScript', topics: ['testing'],
    star_count: 17, fork_count: 3, open_issues_count: 2, observed_at: new Date().toISOString(),
  });
  try {
    const rich = { ...record(githubIds[0]), readme: '# Canonical Markdown\n\n![original](docs/diagram.png)',
      readme_source_path: 'README.md', readme_default_branch: 'main',
      readme_base_url: `https://raw.githubusercontent.com/${owner}/repo-${githubIds[0]}/refs/heads/main/` };
    const [original] = await persistence.bulkUpsert([rich]);
    const created = await persistence.registerDiscoveredRepositories([record(githubIds[0]), record(githubIds[1])]);
    assert.equal(created.length, 1);
    assert.equal(created[0].github_id, githubIds[1]);
    assert.match(created[0].repo_id, /^[0-9a-f-]{36}$/);
    const [content] = await sqlClient`SELECT readme,content_version,readme_source_path FROM app.repo_content WHERE repo_id=${original.repo_id}::uuid`;
    assert.equal(content.readme, rich.readme);
    assert.equal(content.readme_source_path, 'README.md');
    assert.equal(Number(content.content_version), original.content_version);
    const [job] = await sqlClient`SELECT payload FROM telemetry.ml_outbox WHERE aggregate_id=${created[0].repo_id}::uuid AND job_type='repo_index'`;
    assert.equal(job.payload.repo_id, created[0].repo_id);
    assert.equal(job.payload.repository.github_id, githubIds[1]);
    assert.equal(job.payload.repository.readme ?? null, null, 'unknown README is not fabricated');
    const [observed] = await sqlClient`SELECT star_count,fork_count,open_issues_count FROM app.repo_stat_snapshots WHERE repo_id=${created[0].repo_id}::uuid`;
    assert.deepEqual([Number(observed.star_count), Number(observed.fork_count), Number(observed.open_issues_count)], [17, 3, 2]);
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => persistence.registerDiscoveredRepositories([record(githubIds[2])])));
    assert.equal(concurrent.reduce((sum, rows) => sum + rows.length, 0), 1);
    await Promise.all([
      persistence.registerDiscoveredRepositories([record(githubIds[2])]),
      persistence.bulkUpsert([{ ...record(githubIds[2]), readme: '# Real enriched content' }]),
    ]);
    const [final] = await sqlClient`SELECT content.readme FROM app.repos repo JOIN app.repo_content content USING(repo_id) WHERE github_id=${githubIds[2]}::bigint`;
    assert.equal(final.readme, '# Real enriched content');
    assert.equal(Number((await sqlClient`SELECT count(*) FROM app.repos WHERE github_id=${githubIds[2]}::bigint`)[0].count), 1);
    const [versions] = await sqlClient`SELECT count(*) FROM telemetry.ml_outbox job JOIN app.repos repo ON job.aggregate_id=repo.repo_id WHERE repo.github_id=${githubIds[2]}::bigint AND job.job_type='repo_index'`;
    assert.equal(Number(versions.count), 2, 'one initial index and one real enrichment version');
  } finally {
    await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id IN (SELECT repo_id FROM app.repos WHERE github_id=ANY(${githubIds}::bigint[]))`;
    await sqlClient`DELETE FROM app.repos WHERE github_id=ANY(${githubIds}::bigint[])`;
    await sqlClient`DELETE FROM app.social_profiles WHERE provider='github' AND provider_subject=${ownerId}`;
  }
});


integration('canonical language observations survive SQL and outbox without stale or name-only erasure',async()=>{
  const [{sqlClient:sql},{PostgresRepositoryPersistence},{getRepositoryDetail}]=await Promise.all([
    import('../../db/index.js'),import('../../adapters/postgresRepositoryPersistence.js'),import('../../services/repositoryDetailService.js'),
  ]);
  const persistence=new PostgresRepositoryPersistence(),githubId=String(crypto.randomInt(3_000_000_000,4_000_000_000)),ownerId=String(crypto.randomInt(4_000_000_000,5_000_000_000));
  const owner='languages-'+ownerId,viewer=crypto.randomUUID();
  const rich=[{name:'Python',color:'#3572A5',size:300,percentage:30},{name:'Rust',color:'#DEA584',size:200,percentage:20}];
  const source:RepositoryUpsert={github_id:githubId,owner_github_id:ownerId,owner,name:'repository',full_name:owner+'/repository',url:'https://github.com/'+owner+'/repository',
    description:'Sourced language fixture',primary_language:'Rust',languages:['Python','Rust'],language_breakdown:rich,
    language_total_size:1000,language_breakdown_complete:false,observed_at:'2026-10-27T00:00:00.000002Z'};
  let id:string|undefined;
  try {
    const [created]=await persistence.bulkUpsert([source]);id=created.repo_id;
    const read=async()=>(await sql`SELECT languages,primary_language,language_breakdown,language_total_size::float8 AS language_total_size,language_breakdown_complete,
      to_char(language_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS language_observed_at FROM app.repo_content WHERE repo_id=${id!}::uuid`)[0]!;
    const stored=await read();assert.deepEqual(stored.language_breakdown,rich);assert.deepEqual(stored.languages,['Python','Rust']);assert.equal(stored.primary_language,'Rust');
    assert.equal(stored.language_total_size,1000);assert.equal(stored.language_breakdown_complete,false);assert.equal(stored.language_observed_at,source.observed_at);
    const jobs=await sql`SELECT payload FROM telemetry.ml_outbox WHERE aggregate_id=${id}::uuid AND job_type='repo_index'`;
    assert.deepEqual(jobs[0].payload.repository.language_breakdown,rich);assert.equal(jobs[0].payload.repository.language_total_size,1000);
    const [retry]=await persistence.bulkUpsert([source]);
    assert.equal(retry.changed,false,'Same-time source retry remains idempotent after JSONB key reordering');
    assert.deepEqual(await read(),stored);
    assert.equal((await sql`SELECT count(*)::int AS count FROM telemetry.ml_outbox WHERE aggregate_id=${id}::uuid AND job_type='repo_index'`)[0].count,jobs.length);
    const omitted={...source,language_breakdown:undefined,language_total_size:undefined,language_breakdown_complete:undefined,observed_at:'2026-10-28T00:00:00Z'};
    await persistence.bulkUpsert([omitted]);assert.deepEqual(await read(),stored,'Name-only imports cannot erase sourced composition');
    await persistence.bulkUpsert([{...source,observed_at:'2026-10-27T00:00:00.000001Z',language_total_size:2000,language_breakdown:rich.map(row=>({...row,percentage:row.percentage/2}))}]);
    assert.deepEqual(await read(),stored,'Submillisecond older composition remains fenced');
    await assert.rejects(persistence.bulkUpsert([{...source,language_breakdown:rich.map(row=>({...row,color:'#000000'}))}]),/Conflicting language/);
    await persistence.bulkUpsert([{...source,observed_at:'2026-10-27T00:00:00.000003Z'}]);
    assert.equal((await read()).language_observed_at,'2026-10-27T00:00:00.000003Z','Identical content still advances its observation clock');
    const detail=await getRepositoryDetail(viewer,id!);assert.deepEqual(detail?.language_breakdown,rich);assert.equal(detail?.primary_language,'Rust');
    await sql`INSERT INTO auth.users(id) VALUES(${viewer}::uuid)`;
    await sql`INSERT INTO app.users(user_id,username,status) VALUES(${viewer}::uuid,${'language_viewer_'+viewer.replaceAll('-','')},'active')`;
    await sql`INSERT INTO app.user_stats(user_id) VALUES(${viewer}::uuid)`;
    await sql`INSERT INTO app.user_feed_state(user_id) VALUES(${viewer}::uuid)`;
    const {PostgresFeedPersistence}=await import('../../adapters/postgresFeedPersistence.js');const feed=new PostgresFeedPersistence();
    const [projection]=await feed.listActiveRepositories([id!],viewer);assert.deepEqual(projection.language_breakdown,rich);
    const requestId=crypto.randomUUID();
    const serve=await feed.createServe({user_id:viewer,session_id:crypto.randomUUID(),feed_request_id:requestId,feed_version:1n,generation_id:null,
      source:'personalized',model_version:'language-fixture',next_cursor:null,items:[{repo_id:id!,position:0,score:1,source:'semantic',model_version:'language-fixture',summary_id:null,repository:projection}]});
    assert.deepEqual(serve.items[0].repository.language_breakdown,rich);
    const replay=await feed.getServeByRequest(viewer,requestId);assert.equal(replay?.serve_id,serve.serve_id);assert.deepEqual(replay?.items[0].repository.language_breakdown,rich);
    await persistence.bulkUpsert([{...source,languages:[],primary_language:null,language_breakdown:[],language_total_size:0,language_breakdown_complete:true,observed_at:'2026-10-29T00:00:00Z'}]);
    assert.deepEqual((await read()).language_breakdown,[]);assert.equal((await read()).primary_language,null);
  }finally{
    await sql`DELETE FROM app.users WHERE user_id=${viewer}::uuid`;await sql`DELETE FROM auth.users WHERE id=${viewer}::uuid`;
    if(id){await sql`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${id}::uuid`;await sql`DELETE FROM app.repos WHERE repo_id=${id}::uuid`;}
    await sql`DELETE FROM app.social_profiles WHERE provider='github' AND provider_subject=${ownerId}`;
  }
});
