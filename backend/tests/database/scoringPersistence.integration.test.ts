import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postgres from 'postgres';
import { assertDisposableDatabase } from './disposableDatabase.js';
import { PostgresScoringPersistence, ScoringPersistenceError, createPrivateScoringPersistence } from '../../adapters/postgresScoringPersistence.js';
import { ValidatedScoringGeneration } from '../../services/scoringCaptureValidation.js';

const enabled = process.env.RUN_DATABASE_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();
const integration = enabled ? test : test.skip;
const golden = JSON.parse(readFileSync(new URL('../fixtures/scoring-capture-v1.json', import.meta.url), 'utf8'));
const selector = { userId: golden.context.user_id, generationId: golden.context.generation_id,
  feedVersion: BigInt(golden.context.feed_version) };
const policy = { policyId: 'disposable-fixture', policyVersion: '1', retentionDays: 30 };
const candidate = () => ({ packet: structuredClone(golden.packet), rawHeavyScore: 0.25, finalScore: 0.3,
  source: 'semantic', retrievalScores: { semantic: 0.4 } });
const validated = (row = candidate()) => ValidatedScoringGeneration.validate(golden.context, [row], selector);

integration('private scoring persistence enforces exact bytes, atomic retries, roles and redacted errors in real SQL', async () => {
  const admin = postgres(process.env.DATABASE_URL!, { max: 2, prepare: false });
  const suffix = crypto.randomBytes(6).toString('hex');
  const writerRole = `capture_writer_${suffix}`, productRole = `capture_product_${suffix}`;
  let writer: ReturnType<typeof postgres> | undefined, product: ReturnType<typeof postgres> | undefined;
  let seeded = false;
  const peerId = crypto.randomUUID(); let peerSeeded = false;
  try {
    assert.equal(createPrivateScoringPersistence({ enabled: false }), null, 'disabled runtime opens no private pool');
    assert.equal(Number((await admin`SELECT count(*) FROM app.users WHERE user_id=${selector.userId}::uuid`)[0].count), 0);
    assert.equal(Number((await admin`SELECT count(*) FROM app.repos WHERE repo_id=${golden.packet.snapshot.repo_id}::uuid`)[0].count), 0);
    await admin`INSERT INTO auth.users(id) VALUES(${selector.userId}::uuid)`;
    await admin`INSERT INTO app.users(user_id,username,full_name,status) VALUES(${selector.userId}::uuid,${'capture_'+suffix},'Tarun','active')`;
    await admin`INSERT INTO app.repos(repo_id,github_id,owner,name,full_name,url)
      VALUES(${golden.packet.snapshot.repo_id}::uuid,${String(crypto.randomInt(1_000_000_000, 2_000_000_000))}::bigint,
        'fixture',${suffix},${'fixture/'+suffix},${'https://github.com/fixture/'+suffix})`;
    seeded = true;
    await admin.unsafe(`CREATE ROLE ${writerRole} LOGIN IN ROLE ghsocial_scoring_writer`);
    await admin.unsafe(`CREATE ROLE ${productRole} LOGIN IN ROLE ghsocial_backend`);
    const writerUrl = new URL(process.env.DATABASE_URL!); writerUrl.username = writerRole; writerUrl.password = '';
    const productUrl = new URL(process.env.DATABASE_URL!); productUrl.username = productRole; productUrl.password = '';
    writer = postgres(writerUrl.toString(), { max: 2, prepare: false });
    product = postgres(productUrl.toString(), { max: 1, prepare: false });
    for (const connection of [writer, product]) {
      await assert.rejects(connection`SELECT input_bytes FROM private_scoring.scoring_inputs`, { code: '42501' });
      await assert.rejects(connection`SELECT context_bytes FROM private_scoring.scoring_generations`, { code: '42501' });
    }
    await assert.rejects(product`SELECT private_scoring.persist_generation(${validated().serializeForPersistence(policy)}::text)`, { code: '42501' });
    const privileged = new PostgresScoringPersistence(admin);
    await assert.rejects(privileged.persist(validated(), policy), (error: unknown) =>
      error instanceof ScoringPersistenceError && error.reason === 'permission');

    // A separate URL must also be a separate least-privilege credential.
    await admin.unsafe(`GRANT ghsocial_backend TO ${writerRole}`);
    try {
      await assert.rejects(new PostgresScoringPersistence(writer).persist(validated(),policy),
        (error:unknown)=>error instanceof ScoringPersistenceError && error.reason==='permission');
    } finally { await admin.unsafe(`REVOKE ghsocial_backend FROM ${writerRole}`); }
    await admin.unsafe(`GRANT USAGE ON SCHEMA app TO ${writerRole}`);
    await admin.unsafe(`GRANT SELECT(user_id) ON app.users TO ${writerRole}`);
    try {
      await assert.rejects(new PostgresScoringPersistence(writer).persist(validated(),policy),
        (error:unknown)=>error instanceof ScoringPersistenceError && error.reason==='permission');
    } finally {
      await admin.unsafe(`REVOKE SELECT(user_id) ON app.users FROM ${writerRole}`);
      await admin.unsafe(`REVOKE USAGE ON SCHEMA app FROM ${writerRole}`);
    }
    const storage = new PostgresScoringPersistence(writer);
    const [first, retry] = await Promise.all([storage.persist(validated(), policy), storage.persist(validated(), policy)]);
    assert.deepEqual(first, retry, 'concurrent identical submissions reuse one immutable set and expiry');
    assert.equal(first.generationId, selector.generationId);
    assert.deepEqual(first.references, validated().references);
    const [stored] = await admin`SELECT input.input_bytes,input.snapshot_bytes,input.stage_bytes,input.raw_heavy_score,input.final_score,
      generation.context_bytes,generation.feed_version,generation.created_at,generation.expires_at
      FROM private_scoring.scoring_inputs input JOIN private_scoring.scoring_generations generation USING(generation_id,user_id)
      WHERE generation_id=${selector.generationId}::uuid`;
    assert.deepEqual(stored.input_bytes, Buffer.from(golden.packet.input_base64, 'base64'));
    assert.equal(String(stored.feed_version), '9007199254740993');
    assert.equal(stored.raw_heavy_score, 0.25); assert.equal(stored.final_score, 0.3);
    assert.equal(new Date(stored.expires_at).getTime()-new Date(stored.created_at).getTime(), 30*86_400_000);
    assert.equal(Number((await admin`SELECT count(*) FROM private_scoring.scoring_generations`)[0].count), 1);
    assert.equal(Number((await admin`SELECT count(*) FROM private_scoring.scoring_inputs`)[0].count), 1);
    assert.equal(Number((await admin`SELECT count(*) FROM private_scoring.generation_witnesses`)[0].count), 1);
    const changed = candidate(); changed.finalScore = 0.31;
    await assert.rejects(storage.persist(validated(changed), policy), (error: unknown) =>
      error instanceof ScoringPersistenceError && error.reason === 'conflict');
    await assert.rejects(storage.persist(validated(), { ...policy, retentionDays: 90 }), (error: unknown) =>
      error instanceof ScoringPersistenceError && error.reason === 'conflict');
    await admin`INSERT INTO auth.users(id) VALUES(${peerId}::uuid)`;
    await admin`INSERT INTO app.users(user_id,username,status) VALUES(${peerId}::uuid,${'capture_peer_'+suffix},'active')`;
    peerSeeded = true;
    const rebind = (context: Record<string, unknown>, row: ReturnType<typeof candidate>) => {
      const contextJson = JSON.stringify(context,Object.keys(context).sort());
      const snapshotJson = JSON.stringify(row.packet.snapshot,Object.keys(row.packet.snapshot).sort());
      row.packet.binding_sha256 = crypto.createHash('sha256').update(Buffer.concat([
        Buffer.from('{"context":'+contextJson+',"snapshot":'+snapshotJson+'}'),Buffer.from(row.packet.input_base64,'base64')])).digest('hex');
      return row;
    };
    const foreignContext = {...golden.context,user_id:peerId};
    const foreign = ValidatedScoringGeneration.validate(foreignContext,[rebind(foreignContext,candidate())],{...selector,userId:peerId});
    await assert.rejects(storage.persist(foreign,policy),(error: unknown)=>error instanceof ScoringPersistenceError && error.reason==='conflict');

    // The first valid row/header must roll back if a later canonical FK fails.
    const failedGeneration = crypto.randomUUID(), missingRepo = crypto.randomUUID();
    const failedContext = {...golden.context,generation_id:failedGeneration};
    const missing = candidate(); missing.packet.snapshot.repo_id=missingRepo;
    const multiple = ValidatedScoringGeneration.validate(failedContext,[rebind(failedContext,candidate()),rebind(failedContext,missing)],
      {...selector,generationId:failedGeneration});
    await assert.rejects(storage.persist(multiple,policy),(error: unknown)=>error instanceof ScoringPersistenceError && error.reason==='invalid');
    assert.equal(Number((await admin`SELECT count(*) FROM private_scoring.scoring_generations WHERE generation_id=${failedGeneration}::uuid`)[0].count),0);
    assert.equal(Number((await admin`SELECT count(*) FROM private_scoring.scoring_inputs WHERE generation_id=${failedGeneration}::uuid`)[0].count),0);
    assert.equal(Number((await admin`SELECT count(*) FROM private_scoring.generation_witnesses WHERE generation_id=${failedGeneration}::uuid`)[0].count),0);

    // Deliberate disposable corruption leaves stored hashes unchanged. Equality
    // retries must compare actual immutable bytes, not accept hash agreement.
    const corrupted = Buffer.from(stored.input_bytes); corrupted.writeFloatLE(0.125,2000);
    await admin.begin(async tx=>{await tx`SET LOCAL session_replication_role='replica'`;
      await tx`UPDATE private_scoring.scoring_inputs SET input_bytes=${corrupted} WHERE generation_id=${selector.generationId}::uuid`;});
    try { await assert.rejects(storage.persist(validated(),policy),(error: unknown)=>error instanceof ScoringPersistenceError && error.reason==='conflict'); }
    finally { await admin.begin(async tx=>{await tx`SET LOCAL session_replication_role='replica'`;
      await tx`UPDATE private_scoring.scoring_inputs SET input_bytes=${stored.input_bytes} WHERE generation_id=${selector.generationId}::uuid`;}); }
    await assert.rejects(admin`UPDATE private_scoring.scoring_inputs SET input_bytes=input_bytes WHERE generation_id=${selector.generationId}::uuid`, /SCORING_IMMUTABLE/);
    await assert.rejects(writer`DELETE FROM private_scoring.scoring_inputs WHERE generation_id=${selector.generationId}::uuid`, { code: '42501' });

    const bad = JSON.parse(validated().serializeForPersistence(policy));
    bad.items[0].input_base64 = 'SECRET_PACKET_SENTINEL';
    await assert.rejects(writer`SELECT private_scoring.persist_generation(${JSON.stringify(bad)}::text)`, (error: any) =>
      error.code === '22023' && error.message === 'SCORING_CAPTURE_INVALID');
    for(const offset of [0,2000]) {
      const malformed=JSON.parse(validated().serializeForPersistence(policy));
      const raw=Buffer.from(malformed.items[0].input_base64,'base64'); raw.writeFloatLE(offset===0?0.5:Infinity,offset);
      malformed.items[0].input_base64=raw.toString('base64');
      malformed.items[0].binding_sha256=crypto.createHash('sha256').update(Buffer.concat([
        Buffer.from('{"context":'+malformed.context_json+',"snapshot":'+malformed.items[0].snapshot_json+'}'),raw])).digest('hex');
      malformed.items[0].record_digest=crypto.createHash('sha256').update(Buffer.concat([
        Buffer.from(malformed.context_json),Buffer.from(malformed.items[0].snapshot_json),raw,Buffer.from(malformed.items[0].stage_json)])).digest('hex');
      await assert.rejects(writer`SELECT private_scoring.persist_generation(${JSON.stringify(malformed)}::text)`,{code:'22023',message:'SCORING_CAPTURE_INVALID'});
    }
    const noBinding=JSON.parse(validated().serializeForPersistence(policy));noBinding.items[0].binding_sha256=null;
    await assert.rejects(writer`SELECT private_scoring.persist_generation(${JSON.stringify(noBinding)}::text)`,{code:'22023',message:'SCORING_CAPTURE_INVALID'});
    const context90={...golden.context,generation_id:crypto.randomUUID()};
    const capture90=ValidatedScoringGeneration.validate(context90,[rebind(context90,candidate())],{...selector,generationId:context90.generation_id});
    await storage.persist(capture90,{...policy,retentionDays:90});
    const [retained90]=await admin`SELECT created_at,expires_at FROM private_scoring.scoring_generations WHERE generation_id=${context90.generation_id}::uuid`;
    assert.equal(new Date(retained90.expires_at).getTime()-new Date(retained90.created_at).getTime(),90*86_400_000);

    // Inject an actual server error whose DETAIL contains the private binding
    // parameter. The public adapter error must retain neither it nor its cause.
    const migration=readFileSync(new URL('../../../database/migrations/0042_private_scoring_provenance.sql',import.meta.url),'utf8');
    const functionStart=migration.indexOf('CREATE OR REPLACE FUNCTION private_scoring.persist_generation');
    const functionEnd=migration.indexOf('\n$$;',functionStart)+4;
    try {
      await admin.unsafe(`CREATE OR REPLACE FUNCTION private_scoring.persist_generation(payload_text text)
        RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
        BEGIN RAISE EXCEPTION 'fixture SQL transport fault' USING DETAIL=payload_text; END $$`);
      await assert.rejects(writer`SELECT private_scoring.persist_generation(${validated().serializeForPersistence(policy)}::text)`,(error: any)=>error.detail.includes(golden.packet.input_base64));
      await assert.rejects(storage.persist(validated(),policy),(error: unknown)=>{
        assert.ok(error instanceof ScoringPersistenceError); assert.equal(error.reason,'unavailable');
        assert.equal('cause' in error,false); assert.equal(JSON.stringify(error).includes(golden.packet.input_base64),false);
        assert.equal(String(error).includes(golden.packet.input_base64),false); return true;
      });
    } finally { await admin.unsafe(migration.slice(functionStart,functionEnd)); }
    const [after] = await admin`SELECT input_bytes,stage_bytes FROM private_scoring.scoring_inputs WHERE generation_id=${selector.generationId}::uuid`;
    assert.deepEqual(after.input_bytes, stored.input_bytes); assert.deepEqual(after.stage_bytes, stored.stage_bytes);
  } finally {
    await Promise.all([writer?.end({ timeout: 1 }), product?.end({ timeout: 1 })]);
    if (seeded) {
      await admin`DELETE FROM app.repos WHERE repo_id=${golden.packet.snapshot.repo_id}::uuid`;
      await admin`DELETE FROM app.users WHERE user_id=${selector.userId}::uuid`;
      await admin`DELETE FROM auth.users WHERE id=${selector.userId}::uuid`;
    }
    if(peerSeeded){await admin`DELETE FROM app.users WHERE user_id=${peerId}::uuid`;await admin`DELETE FROM auth.users WHERE id=${peerId}::uuid`;}
    await admin.unsafe(`DROP ROLE IF EXISTS ${writerRole}`); await admin.unsafe(`DROP ROLE IF EXISTS ${productRole}`);
    await admin.end({ timeout: 1 });
  }
});
