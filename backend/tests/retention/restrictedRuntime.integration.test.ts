import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import postgres from 'postgres';
import { sqlClient } from '../../db/index.js';
import { RetentionWorker } from '../../workers/retentionWorker.js';

const integration = process.env.RUN_RESTRICTED_RUNTIME_INTEGRATION === '1' ? test : test.skip;
test.after(async () => { if (process.env.RUN_RESTRICTED_RUNTIME_INTEGRATION === '1') await sqlClient.end({timeout:1}); });
integration('restricted runtime allocates topics and prunes history without journal DELETE authority', async () => {
  const target = new URL(process.env.DATABASE_URL!);
  const adminTarget = new URL(process.env.TEST_ADMIN_DATABASE_URL!);
  for (const candidate of [target,adminTarget]) {
    assert.ok(process.env.NODE_ENV !== 'production'
      && ['postgres:','postgresql:'].includes(candidate.protocol)
      && ['127.0.0.1','localhost'].includes(candidate.hostname)
      && candidate.pathname === '/weave_runtime_grants' && !candidate.search && !candidate.hash,
    'Use the owned loopback weave_runtime_grants fixture database');
  }
  assert.equal(adminTarget.port || '5432',target.port || '5432','Admin must target the same owned fixture port');
  const admin = postgres(adminTarget.href, {max:1,prepare:false});
  const aggregate = crypto.randomUUID();
  const older = crypto.randomUUID(), checkpoint = crypto.randomUUID(), feedback = crypto.randomUUID(), journal = crypto.randomUUID();
  const slug = `runtime-${crypto.randomUUID()}`;
  try {
    const functions = await admin`
      SELECT p.proname,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.prosecdef AND (n.nspname='private_scoring' OR
        (n.nspname='telemetry' AND p.proname IN ('prune_runtime_history','prune_model_transients')))
    `;
    assert.equal(functions.length,12);
    for (const row of functions) {
      const setting = (row.proconfig as string[]).find(value => value.startsWith('search_path='));
      assert.deepEqual(setting?.slice('search_path='.length).split(',').map(value => value.trim()),
        ['pg_catalog','pg_temp'],`${row.proname} must resolve trusted built-in types before temporary schemas`);
    }
    assert.equal((await sqlClient`SELECT current_user AS role`)[0].role,'ghsocial_backend');
    await sqlClient`INSERT INTO app.topics(slug,display_name) VALUES(${slug},'Restricted runtime')`;
    for (const [id,kind,version] of [[older,'repo_index',1],[checkpoint,'repo_index',2],[feedback,'feedback',0],[journal,'model_operation',0]] as const) {
      const operation = kind === 'model_operation' ? JSON.stringify({operation_id:id,user_id:aggregate,model_operation_version:'1',previous_model_operation_version:'0'}) : null;
      const digest = operation ? crypto.createHash('sha256').update(operation).digest('hex') : null;
      await admin`INSERT INTO telemetry.ml_outbox(outbox_id,job_type,aggregate_id,idempotency_key,payload,status,created_at,delivered_at,model_operation_version,previous_model_operation_version,operation_json,source_envelope_sha256,logical_request_sha256)
        VALUES(${id}::uuid,${kind},${aggregate}::uuid,${id},${JSON.stringify({content_version:version})}::jsonb,'delivered',now()-interval '40 days',now()-interval '40 days',${operation?1:null},${operation?0:null},${operation},${digest},${digest})`;
    }
    await admin`INSERT INTO auth.users(id) VALUES(${aggregate}::uuid)`;
    await admin`INSERT INTO app.users(user_id,username) VALUES(${aggregate}::uuid,${slug})`;
    await admin`INSERT INTO telemetry.generation_attempts(generation_id,user_id,feed_version,mode,status,created_at)
      VALUES(${aggregate}::uuid,${aggregate}::uuid,1,'fixture','completed',now()-interval '40 days')`;
    const pruned = await new RetentionWorker().runOnce(30,30);
    assert.equal(pruned.outbox,2);
    assert.equal(pruned.generations,1);
    const remaining = await admin`SELECT outbox_id FROM telemetry.ml_outbox WHERE aggregate_id=${aggregate}::uuid`;
    assert.deepEqual(new Set(remaining.map(row=>String(row.outbox_id))),new Set([checkpoint,journal]));
    for (const relation of ['telemetry.ml_outbox','telemetry.generation_attempts']) {
      await assert.rejects(sqlClient.unsafe(`DELETE FROM ${relation} WHERE false`), {code:'42501'});
    }
    for (const invalid of [0,-1,null]) {
      await assert.rejects(sqlClient`SELECT * FROM telemetry.prune_runtime_history(${invalid}::integer,30)`, {code:'22023'});
      await assert.rejects(sqlClient`SELECT * FROM telemetry.prune_runtime_history(30,${invalid}::integer)`, {code:'22023'});
    }
    assert.equal((await admin`SELECT EXISTS(SELECT 1 FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
      WHERE p.oid='telemetry.prune_runtime_history(integer,integer)'::regprocedure
        AND acl.grantee=0 AND acl.privilege_type='EXECUTE') AS allowed`)[0].allowed,false);
  } finally {
    try {
      await admin`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${aggregate}::uuid`;
      await admin`DELETE FROM app.users WHERE user_id=${aggregate}::uuid`;
      await admin`DELETE FROM auth.users WHERE id=${aggregate}::uuid`;
      await admin`DELETE FROM app.topics WHERE slug=${slug}`;
    } finally {
      await admin.end({timeout:1});
    }
  }
});
