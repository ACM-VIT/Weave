import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import postgres from 'postgres';

const integration=process.env.RUN_README_SUMMARY_INTEGRATION==='1'?test:test.skip;
for (const history of ['readme-first', 'search-first', 'incomplete-baseline'] as const)
integration(`V2 migration histories reconcile safely: ${history}`,async()=>{
  const url=new URL(process.env.README_SUMMARY_TEST_DATABASE_URL??'');
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
  const admin=postgres(url.toString(),{max:1,prepare:false});
  const name='readme_upgrade_'+crypto.randomUUID().replaceAll('-','');
  let isolated:ReturnType<typeof postgres>|undefined;
  try{
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const isolatedUrl=new URL(url);isolatedUrl.pathname='/'+name;
    isolated=postgres(isolatedUrl.toString(),{max:1,prepare:false,onnotice:()=>{}});
    await isolated`CREATE SCHEMA auth`;
    await isolated`CREATE TABLE auth.users(id uuid PRIMARY KEY,raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb)`;
    await isolated`CREATE SCHEMA drizzle`;
    await isolated`CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY,hash text NOT NULL,created_at bigint)`;
    const folder=new URL('../../../database/migrations/',import.meta.url);
    const journal=JSON.parse(fs.readFileSync(new URL('meta/_journal.json',folder),'utf8'));
    for(const entry of journal.entries){
      if(Number(entry.tag.slice(0,4))>=24)continue;
      if(history === 'incomplete-baseline' && Number(entry.tag.slice(0,4)) > 19)continue;
      // Reproduce a V2 journal advanced by the targeted README migration while
      // owner identity and active-handle migrations are still pending.
      if(history === 'search-first' && ['0022_repo_owner_github_identity','0023_active_social_profile_handles'].includes(entry.tag))continue;
      const sql=fs.readFileSync(new URL(entry.tag+'.sql',folder),'utf8');
      await isolated.unsafe(sql).simple();
      await isolated`INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES(${crypto.createHash('sha256').update(sql).digest('hex')},${entry.when})`;
    }
    const run=(args:string[], expectedStatus=0)=>{
      const result=spawnSync(process.execPath,['--import','tsx','scripts/migrate.ts',...args],{
        cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:30000,
        env:{...process.env,DATABASE_URL:isolatedUrl.toString(),NODE_ENV:'test'},
      });
      assert.equal(result.status,expectedStatus,result.stderr||result.stdout);
      return result;
    };
    if (history === 'incomplete-baseline') {
      const before=await isolated`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
      const blocked=run(['--readme-summary-only','--execute'],1);
      assert.match(blocked.stderr,/Missing prerequisites:.*0021_external_social_profiles/);
      assert.deepEqual(await isolated`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`,before,'Refused upgrades must not advance migration history');
      assert.equal((await isolated`SELECT to_regclass('app.repo_readme_summaries') AS present`)[0].present,null);
      run([]);
      assert.ok((await isolated`SELECT to_regclass('app.social_profiles') AS present`)[0].present);
      assert.ok((await isolated`SELECT to_regclass('app.social_profile_follows') AS present`)[0].present);
      run(['--readme-summary-only','--execute']);
      return;
    }
    if (history === 'search-first') {
      const entry=journal.entries.find((entry:{tag:string})=>entry.tag==='0024_explore_search');
      const source=fs.readFileSync(new URL(entry.tag+'.sql',folder),'utf8');
      await isolated.unsafe(source).simple();
      await isolated`INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES(${crypto.createHash('sha256').update(source).digest('hex')},${entry.when})`;
      // Simulate dev already migrated beyond the older summary timestamp.
      run([]);
      assert.ok((await isolated`SELECT to_regclass('app.repo_readme_summaries') AS present`)[0].present);
      assert.ok((await isolated`SELECT column_name FROM information_schema.columns WHERE table_schema='app' AND table_name='repos' AND column_name='owner_github_id'`)[0], 'Retroactive repair applies the skipped owner identity migration');
      assert.ok((await isolated`SELECT to_regclass('app.social_profiles_provider_handle_uidx') AS present`)[0].present, 'Retroactive repair applies the skipped active handle index migration');
      const hashes=await isolated`SELECT hash,count(*)::int AS n FROM drizzle.__drizzle_migrations GROUP BY hash`;
      assert.ok(hashes.every(row=>row.n===1),'Applied hashes must not be duplicated');
      run([]);
      return;
    }
    run(['--readme-summary-only']);
    assert.equal((await isolated`SELECT to_regclass('app.repo_readme_summaries') AS present`)[0].present,null,'Default is a dry run');
    run(['--readme-summary-only','--execute']);
    assert.ok((await isolated`SELECT to_regclass('app.repo_readme_summaries') AS present`)[0].present);
    assert.equal((await isolated`SELECT to_regprocedure('app.explore_similarity(text,text)') AS present`)[0].present,null,'Unrelated Search DDL is not applied by the targeted upgrade');
    run([]);
    assert.ok((await isolated`SELECT column_name FROM information_schema.columns WHERE table_schema='app' AND table_name='repos' AND column_name='owner_github_id'`)[0], 'Retroactive repair applies the skipped owner identity migration');
    assert.ok((await isolated`SELECT to_regclass('app.social_profiles_provider_handle_uidx') AS present`)[0].present, 'Retroactive repair applies the skipped active handle index migration');
    assert.ok((await isolated`SELECT to_regprocedure('app.explore_similarity(text,text)') AS present`)[0].present,'Normal migration reconciles skipped older timestamps');
    run(['--readme-summary-only','--execute']);
    const audit=()=>spawnSync(process.execPath,['--import','tsx','scripts/schema-audit.ts'],{
      cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:30000,
      env:{...process.env,DATABASE_URL:isolatedUrl.toString(),NODE_ENV:'test'},
    });
    const healthy=audit();assert.equal(healthy.status,0,healthy.stderr||healthy.stdout);
    await isolated`ALTER TABLE app.repo_readme_summaries RENAME TO missing_readme_summaries`;
    const missingTable=audit();assert.equal(missingTable.status,1);assert.match(missingTable.stderr,/table:app.repo_readme_summaries/);
    await isolated`ALTER TABLE app.missing_readme_summaries RENAME TO repo_readme_summaries`;
    await isolated`DROP INDEX app.repo_readme_summaries_active_uidx`;
    const missingIndex=audit();assert.equal(missingIndex.status,1);assert.match(missingIndex.stderr,/index:repo_readme_summaries_active_uidx/);
  }finally{
    await isolated?.end({timeout:1});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end({timeout:1});
  }
});
