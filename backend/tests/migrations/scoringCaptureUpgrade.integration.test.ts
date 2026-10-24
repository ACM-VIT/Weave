import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import postgres from 'postgres';
import { assertDisposableDatabase } from '../database/disposableDatabase.js';

const enabled = process.env.RUN_SCORING_MIGRATION_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();
const integration = enabled ? test : test.skip;
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const execute = promisify(execFile);

integration('fresh scoring migration and pre-scoring upgrade preserve baseline rows, hashes and private grants', { timeout: 120_000 }, async () => {
  const admin = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  const userId = crypto.randomUUID(); let seeded = false;
  const run = (script: string) => execute(process.execPath, ['--import','tsx',script], { cwd: backend,
    env: { ...process.env, BOOTSTRAP_SUPABASE_AUTH_STUB: '1', NODE_ENV: 'test' }, timeout: 60_000, maxBuffer: 4_194_304 });
  try {
    assert.equal((await admin`SELECT to_regclass('app.users') AS relation`)[0].relation, null,
      'migration fixture requires its own empty disposable database');
    await run('scripts/migrate.ts');
    await run('scripts/schema-audit.ts');
    const journal = JSON.parse(readFileSync(path.resolve(backend,'../database/migrations/meta/_journal.json'),'utf8'));
    const entry = journal.entries.find((row: { tag: string })=>row.tag==='0042_private_scoring_provenance');
    const serving = journal.entries.find((row: { tag: string })=>row.tag==='0043_feed_item_provenance');
    const exporting = journal.entries.find((row: { tag: string })=>row.tag==='0044_private_scoring_exports');
    const impression = journal.entries.find((row: { tag: string })=>row.tag==='0045_original_impression_links');
    assert.equal(impression.idx,48);
    assert.equal(exporting.idx,47);
    assert.equal(serving.idx,46);
    assert.equal(entry.idx,45);
    const previous = await admin`SELECT hash,created_at FROM drizzle.__drizzle_migrations WHERE created_at<${entry.when} ORDER BY created_at`;
    await admin`INSERT INTO auth.users(id) VALUES(${userId}::uuid)`;
    await admin`INSERT INTO app.users(user_id,username,status) VALUES(${userId}::uuid,${'capture_upgrade_'+userId.replaceAll('-','')},'active')`;
    seeded = true;
    // Construct only this owned fixture's pre-0042 state. Never alter a shared
    // ledger: assertDisposableDatabase and the empty-database guard are required.
    await admin.begin(async tx=>{
      assert.equal(Number((await tx`SELECT count(*) FROM private_scoring.scoring_generations`)[0].count),0);
      await tx.unsafe('DROP TABLE telemetry.feed_item_provenance');
      await tx.unsafe('DROP SCHEMA private_scoring CASCADE');
      await tx.unsafe('ALTER TABLE telemetry.interaction_events DROP COLUMN impression_event_id');
      assert.equal((await tx`DELETE FROM drizzle.__drizzle_migrations WHERE created_at=${impression.when} RETURNING hash`).length,1);
      assert.equal((await tx`DELETE FROM drizzle.__drizzle_migrations WHERE created_at=${serving.when} RETURNING hash`).length,1);
      assert.equal((await tx`DELETE FROM drizzle.__drizzle_migrations WHERE created_at=${exporting.when} RETURNING hash`).length,1);
      const removed=await tx`DELETE FROM drizzle.__drizzle_migrations WHERE created_at=${entry.when} RETURNING hash`;
      assert.equal(removed.length,1);
    });
    await run('scripts/migrate.ts');
    await run('scripts/schema-audit.ts');
    assert.deepEqual(await admin`SELECT hash,created_at FROM drizzle.__drizzle_migrations WHERE created_at<${entry.when} ORDER BY created_at`,previous,
      'existing migration identities remain unchanged');
    assert.equal(Number((await admin`SELECT count(*) FROM app.users WHERE user_id=${userId}::uuid`)[0].count),1);
    const [functionRow]=await admin`SELECT prosecdef,proconfig,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(proacl,acldefault('f',proowner))) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
      FROM pg_proc WHERE oid='private_scoring.persist_generation(text)'::regprocedure`;
    assert.equal(functionRow.prosecdef,true); assert.ok(functionRow.proconfig.includes('search_path=pg_catalog'));
    assert.equal(functionRow.public_execute,false);
    for(const role of ['ghsocial_scoring_writer','ghsocial_scoring_exporter','ghsocial_scoring_retention']) {
      const [record]=await admin`SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=${role}`;
      assert.deepEqual({...record},{rolcanlogin:false,rolsuper:false,rolbypassrls:false});
    }
  } finally {
    if(seeded){await admin`DELETE FROM app.users WHERE user_id=${userId}::uuid`;await admin`DELETE FROM auth.users WHERE id=${userId}::uuid`;}
    await admin.end({timeout:1});
  }
});
