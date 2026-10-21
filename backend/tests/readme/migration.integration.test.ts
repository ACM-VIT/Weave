import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import postgres from 'postgres';

const integration=process.env.RUN_README_SUMMARY_INTEGRATION==='1'?test:test.skip;
integration('targeted README upgrade preserves V2 migration history and does not skip Search later',async()=>{
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
      const sql=fs.readFileSync(new URL(entry.tag+'.sql',folder),'utf8');
      await isolated.unsafe(sql).simple();
      await isolated`INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES(${crypto.createHash('sha256').update(sql).digest('hex')},${entry.when})`;
    }
    const run=(args:string[])=>{
      const result=spawnSync(process.execPath,['--import','tsx','scripts/migrate.ts',...args],{
        cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:30000,
        env:{...process.env,DATABASE_URL:isolatedUrl.toString(),NODE_ENV:'test'},
      });
      assert.equal(result.status,0,result.stderr||result.stdout);
    };
    run(['--readme-summary-only']);
    assert.equal((await isolated`SELECT to_regclass('app.repo_readme_summaries') AS present`)[0].present,null,'Default is a dry run');
    run(['--readme-summary-only','--execute']);
    assert.ok((await isolated`SELECT to_regclass('app.repo_readme_summaries') AS present`)[0].present);
    assert.equal((await isolated`SELECT to_regprocedure('app.explore_similarity(text,text)') AS present`)[0].present,null,'Unrelated Search DDL is not applied by the targeted upgrade');
    run([]);
    assert.ok((await isolated`SELECT to_regprocedure('app.explore_similarity(text,text)') AS present`)[0].present,'Normal migration reconciles skipped older timestamps');
    run(['--readme-summary-only','--execute']);
  }finally{
    await isolated?.end({timeout:1});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end({timeout:1});
  }
});
