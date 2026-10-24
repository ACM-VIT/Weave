import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postgres from 'postgres';
import { assertDisposableDatabase } from './disposableDatabase.js';
import { ValidatedScoringGeneration } from '../../services/scoringCaptureValidation.js';
const enabled = process.env.RUN_DATABASE_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();
const integration = enabled ? test : test.skip;
const fixture = JSON.parse(readFileSync(new URL('../fixtures/scoring-capture-v1.json', import.meta.url), 'utf8'));

integration('durable item provenance rejects foreign/stale references atomically and survives private deletion', async () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 2, prepare: false });
  const suffix = crypto.randomBytes(6).toString('hex'), owner = fixture.context.user_id, repo = fixture.packet.snapshot.repo_id;
  const peer = crypto.randomUUID(), generation = fixture.context.generation_id;
  const role = 'provenance_product_' + suffix;
  let product: ReturnType<typeof postgres> | undefined, seeded = false, roleCreated = false;
  try {
    assert.ok((await sql`SELECT to_regclass('telemetry.feed_item_provenance') AS table_name`)[0].table_name,
      'migration must provide durable per-item provenance');
    assert.equal(Number((await sql`SELECT count(*) FROM app.users WHERE user_id IN (${owner}::uuid,${peer}::uuid)`)[0].count), 0);
    await sql`INSERT INTO auth.users(id) VALUES(${owner}::uuid),(${peer}::uuid)`;
    await sql`INSERT INTO app.users(user_id,username,status) VALUES(${owner}::uuid,${'provenance_'+suffix},'active'),
      (${peer}::uuid,${'provenance_peer_'+suffix},'active')`;
    seeded = true;
    await sql`INSERT INTO app.repos(repo_id,github_id,owner,name,full_name,url)
      VALUES(${repo}::uuid,${String(crypto.randomInt(1_000_000_000,2_000_000_000))}::bigint,
        'fixture',${suffix},${'fixture/'+suffix},${'https://github.com/fixture/'+suffix})`;
    const validated = ValidatedScoringGeneration.validate(fixture.context, [{packet:fixture.packet,rawHeavyScore:0.2,
      finalScore:0.3,source:'semantic',retrievalScores:{}}], { userId:owner,generationId:generation,
      feedVersion:BigInt(fixture.context.feed_version) });
    await sql`SELECT private_scoring.persist_generation(${validated.serializeForPersistence({policyId:'fixture',policyVersion:'1',retentionDays:30})})`;
    await sql.unsafe(`CREATE ROLE ${role} LOGIN IN ROLE ghsocial_backend`); roleCreated = true;
    const url = new URL(process.env.DATABASE_URL!); url.username = role; url.password = '';
    product = postgres(url.toString(), { max:1,prepare:false });
    await assert.rejects(product`SELECT input_bytes FROM private_scoring.scoring_inputs`, {code:'42501'});
    const digest = validated.references[0].record_digest;
    const insert = async (options: { user?:string; digest?:string; score?:number; generation?:string; status?:string } = {}) => product!.begin(async tx => {
      const [header] = await tx`INSERT INTO telemetry.feed_serves(feed_request_id,user_id,session_id,feed_version,source)
        VALUES(${crypto.randomUUID()}::uuid,${options.user ?? owner}::uuid,${crypto.randomUUID()}::uuid,
        ${fixture.context.feed_version}::bigint,'personalized') RETURNING serve_id`;
      await tx`INSERT INTO telemetry.feed_serve_items(serve_id,position,repo_id,score,source,model_version)
        VALUES(${header.serve_id}::uuid,0,${repo}::uuid,${options.score ?? 0.3},'semantic',${fixture.context.model_version})`;
      const [item] = await tx`INSERT INTO telemetry.feed_item_provenance(serve_id,position,user_id,repo_id,generation_id,record_digest,capture_status)
        VALUES(${header.serve_id}::uuid,0,${options.user ?? owner}::uuid,${repo}::uuid,
          ${options.generation ?? generation}::uuid,${options.digest ?? digest},${options.status ?? 'captured'}) RETURNING *`;
      return item;
    });
    const first = await insert();
    assert.ok(first.exposure_id); assert.equal(first.generation_id,generation); assert.equal(first.record_digest,digest);
    for (const options of [{user:peer},{digest:'0'.repeat(64)},{score:0.4},{generation:crypto.randomUUID()}]) {
      await assert.rejects(insert(options), {message:'FEED_PROVENANCE_INVALID'});
    }
    assert.equal(Number((await sql`SELECT count(*) FROM telemetry.feed_serves WHERE user_id IN (${owner}::uuid,${peer}::uuid)`)[0].count),1,
      'invalid reference rolls back header and items');
    await assert.rejects(product`UPDATE telemetry.feed_item_provenance SET generation_id=${crypto.randomUUID()}::uuid`,{code:'42501'});
    await assert.rejects(sql`UPDATE telemetry.feed_item_provenance SET record_digest=${'0'.repeat(64)}`, {message:'SCORING_IMMUTABLE'});
    // Explicit fixture-only clock shift: immutable production rows remain
    // protected, while an expired still-present packet must fail on serving.
    const shift=async(direction:1|-1)=>sql.begin(async tx=>{
      await tx.unsafe('SET LOCAL session_replication_role=replica');
      await tx`UPDATE private_scoring.scoring_generations SET created_at=created_at+${direction*31}*interval '24 hours',
        expires_at=expires_at+${direction*31}*interval '24 hours' WHERE generation_id=${generation}::uuid`;
    });
    await shift(-1);await assert.rejects(insert(),{message:'FEED_PROVENANCE_INVALID'});await shift(1);
    await sql`INSERT INTO private_scoring.generation_witnesses(generation_id,event_type) VALUES(${generation}::uuid,'revoked')`;
    await assert.rejects(insert(),{message:'FEED_PROVENANCE_INVALID'});
    await sql`DELETE FROM private_scoring.scoring_generations WHERE generation_id=${generation}::uuid`;
    await assert.rejects(insert(),{message:'FEED_PROVENANCE_INVALID'});
    const [replay] = await product`SELECT * FROM telemetry.feed_item_provenance WHERE exposure_id=${first.exposure_id}::uuid`;
    assert.deepEqual(replay, first, 'private deletion preserves immutable durable exposure and original reference');
  } finally {
    await product?.end();
    if (seeded) {
      await sql`DELETE FROM telemetry.feed_item_provenance WHERE user_id IN (${owner}::uuid,${peer}::uuid)`;
      await sql`DELETE FROM telemetry.feed_serve_items WHERE serve_id IN (SELECT serve_id FROM telemetry.feed_serves WHERE user_id IN (${owner}::uuid,${peer}::uuid))`;
      await sql`DELETE FROM telemetry.feed_serves WHERE user_id IN (${owner}::uuid,${peer}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id IN (${owner}::uuid,${peer}::uuid)`;
      await sql`DELETE FROM app.repos WHERE repo_id=${repo}::uuid`;
    }
    if (roleCreated) await sql.unsafe(`DROP ROLE ${role}`);
    await sql.end();
  }
});
