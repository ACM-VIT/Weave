import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import test from 'node:test';
import postgres from 'postgres';
import {assertDisposableDatabase} from '../database/disposableDatabase.js';
const enabled=process.env.RUN_MODEL_MIGRATION_INTEGRATION==='1';
const integration=enabled?test:test.skip;
integration('pre-model journal upgrades preserve disabled users, opaque outbox bytes and all historical hashes',{timeout:120000},async()=>{
 assertDisposableDatabase();const db=postgres(process.env.DATABASE_URL!,{max:1,prepare:false});
 const backend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
 const folder=path.resolve(backend,'../database/migrations');
 const journal=JSON.parse(await readFile(path.join(folder,'meta/_journal.json'),'utf8')) as {entries:{idx:number;when:number;tag:string}[]};
 const execute=promisify(execFile);const user=crypto.randomUUID(),job=crypto.randomUUID();
 try{
  assert.equal((await db`SELECT to_regclass('app.users') AS relation`)[0].relation,null,'requires a new owned empty database');
  await db`CREATE SCHEMA auth`;await db`CREATE TABLE auth.users(id uuid PRIMARY KEY,raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb)`;
  await db`CREATE SCHEMA drizzle`;await db`CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY,hash text NOT NULL,created_at bigint)`;
  for(const entry of journal.entries.filter(entry=>entry.idx<49)){
   const source=await readFile(path.join(folder,entry.tag+'.sql'),'utf8');
   await db.begin(async tx=>{for(const statement of source.split('--> statement-breakpoint'))if(statement.trim())await tx.unsafe(statement).simple();
    await tx`INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES(${crypto.createHash('sha256').update(source).digest('hex')},${entry.when})`;});
  }
  const previous=await db`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`;
  await db`INSERT INTO auth.users(id) VALUES(${user}::uuid)`;
  await db`INSERT INTO app.users(user_id,username,status) VALUES(${user}::uuid,${'upgrade_'+user.replaceAll('-','')},'active')`;
  await db`INSERT INTO app.user_feed_state(user_id,feed_version) VALUES(${user}::uuid,7)`;
  const raw='{ "source": "legacy", "unicode": "Ω" }';
  await db`INSERT INTO telemetry.ml_outbox(outbox_id,job_type,aggregate_id,idempotency_key,payload) VALUES(${job}::uuid,'onboard',${user}::uuid,${'upgrade:'+job},${raw}::jsonb)`;
  const original=await db`SELECT * FROM telemetry.ml_outbox WHERE outbox_id=${job}::uuid`;
  for(const script of ['scripts/migrate.ts','scripts/schema-audit.ts'])await execute(process.execPath,['--import','tsx',script],{
   cwd:backend,env:{...process.env,NODE_ENV:'test',BOOTSTRAP_SUPABASE_AUTH_STUB:'1'},timeout:60000,maxBuffer:4194304});
  assert.deepEqual(await db`SELECT hash,created_at FROM drizzle.__drizzle_migrations WHERE created_at<=${journal.entries.find(entry=>entry.idx===48)!.when} ORDER BY created_at`,previous);
  const [state]=await db`SELECT feed_version,model_policy_sha256,model_initialized,model_operation_version FROM app.user_feed_state WHERE user_id=${user}::uuid`;
  assert.equal(String(state.feed_version),'7');assert.equal(state.model_policy_sha256,null);assert.equal(state.model_initialized,false);assert.equal(String(state.model_operation_version),'0');
  const [after]=await db`SELECT * FROM telemetry.ml_outbox WHERE outbox_id=${job}::uuid`;
  for(const key of Object.keys(original[0]))assert.deepEqual(after[key],original[0][key]);
  assert.equal(after.operation_json,null);assert.equal((await db`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`)[0].count,journal.entries.length);
 }finally{await db.end({timeout:1});}
});
