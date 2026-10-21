import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

const integration = process.env.RUN_CATALOGUE_INTEGRATION === '1' ? test : test.skip;

integration('canonical catalogue returns stored counts, summaries and real owner follow identity', async () => {
  const target = new URL(process.env.CATALOGUE_TEST_DATABASE_URL ?? '');
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname), 'An isolated loopback database is required');
  process.env.DATABASE_URL = target.toString();
  const { sqlClient: db } = await import('../../db/index.js');
  const { PostgresRepositoryPersistence } = await import('../../adapters/postgresRepositoryPersistence.js');
  const { listRepositories } = await import('../../controllers/productV2Controller.js');
  const suffix = crypto.randomUUID().replaceAll('-','').slice(0,12);
  const owner = `catalogue-${suffix}`;
  const githubId = String(Date.now());
  const ownerGithubId = String(BigInt(githubId) + 100000000000000n);
  let repoId: string | undefined;
  try {
    const [mapping] = await new PostgresRepositoryPersistence().bulkUpsert([{
      github_id: githubId, owner_github_id: ownerGithubId, full_name:`${owner}/project`, owner, name:'project',
      url:`https://github.com/${owner}/project`,description:'Canonical catalogue fixture.',readme:'# Source documentation',
      languages:['TypeScript'],topics:[],star_count:42,fork_count:3,open_issues_count:2,observed_at:new Date().toISOString(),
    }]);
    repoId=mapping.repo_id;
    await db`UPDATE app.repo_engagement SET likes_count=7 WHERE repo_id=${repoId}::uuid`;
    let status=0;
    let payload:any;
    const response:any={status(value:number){status=value;return this;},json(value:unknown){payload=value;return this;}};
    await listRepositories({user:{userId:crypto.randomUUID()},query:{q:owner,limit:'10',offset:'0'}} as any,response);
    assert.equal(status,200);
    assert.equal(payload.data.items.length,1);
    const row=payload.data.items[0];
    assert.equal(row.repo_id,repoId);assert.equal(row.likes_count,7);assert.equal(Number(row.star_count),42);
    assert.equal(row.readme_md,'# Source documentation');assert.equal(row.readme_digest,null);
    assert.ok(row.owner_profile_id);assert.equal(row.owner_username,owner);
    assert.equal(row.viewer_follows_owner,false);assert.equal(row.viewer_reaction,null);assert.equal(row.viewer_saved,false);
    assert.equal(row.serve_id,undefined,'Catalogue reads cannot invent a recommendation serve');
  } finally {
    if(repoId){await db`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${repoId}::uuid`;await db`DELETE FROM app.repos WHERE repo_id=${repoId}::uuid`;}
    await db`DELETE FROM app.social_profiles WHERE provider='github' AND provider_subject=${ownerGithubId}`;
    await db.end({timeout:5});
  }
});
