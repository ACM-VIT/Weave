import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import postgres from 'postgres';
import {assertDisposableDatabase} from './disposableDatabase.js';
import {ValidatedScoringGeneration} from '../../services/scoringCaptureValidation.js';

const enabled=process.env.RUN_SCORING_REPAIR_INTEGRATION==='1';
if(enabled)assertDisposableDatabase();
const integration=enabled?test:test.skip;
const golden=JSON.parse(readFileSync(new URL('../fixtures/scoring-capture-v1.json',import.meta.url),'utf8'));

integration('publication repair probes captured generation identity without scanning the owners history', {timeout:30000},async t=>{
 const admin=postgres(process.env.DATABASE_URL!,{max:1,prepare:false});
 const rollback=new Error('owned fixture rollback');
 try {
  await admin.begin(async tx=>{
   const user=crypto.randomUUID(),repo=crypto.randomUUID(),generation=crypto.randomUUID(),missing=crypto.randomUUID();
   await tx`INSERT INTO auth.users(id) VALUES(${user}::uuid)`;
   await tx`INSERT INTO app.users(user_id,username,status) VALUES(${user}::uuid,${'repair_'+user.replaceAll('-','')},'active')`;
   await tx`INSERT INTO app.repos(repo_id,github_id,owner,name,full_name,url) VALUES(${repo}::uuid,${String(crypto.randomInt(1000000000,2000000000))}::bigint,'fixture',${repo},${'fixture/'+repo},${'https://github.com/fixture/'+repo})`;
   const context={...golden.context,user_id:user,generation_id:generation};
   const packet=structuredClone(golden.packet);packet.snapshot.repo_id=repo;
   const canonical=(value:object)=>JSON.stringify(value,Object.keys(value).sort());
   packet.binding_sha256=crypto.createHash('sha256').update(Buffer.concat([Buffer.from('{"context":'+canonical(context)+',"snapshot":'+canonical(packet.snapshot)+'}'),Buffer.from(packet.input_base64,'base64')])).digest('hex');
   const captured=ValidatedScoringGeneration.validate(context,[{packet,rawHeavyScore:0.2,finalScore:0.3,source:'semantic',retrievalScores:{}}],{userId:user,generationId:generation,feedVersion:BigInt(context.feed_version)});
   await tx`SELECT private_scoring.persist_generation(${captured.serializeForPersistence({policyId:'owned-repair-fixture',policyVersion:'1',retentionDays:30})})`;
   await tx`WITH inserted AS (
    INSERT INTO telemetry.feed_serves(feed_request_id,user_id,session_id,feed_version,generation_id,source,model_version)
    SELECT gen_random_uuid(),${user}::uuid,gen_random_uuid(),${context.feed_version}::bigint,${generation}::uuid,'personalized',${context.model_version}
    FROM generate_series(1,12000) RETURNING serve_id
   ) INSERT INTO telemetry.feed_serve_items(serve_id,position,repo_id,score,source,model_version)
     SELECT serve_id,0,${repo}::uuid,0.3,'semantic',${context.model_version} FROM inserted`;
   await tx`INSERT INTO telemetry.feed_item_provenance(serve_id,position,user_id,repo_id,generation_id,record_digest,capture_status)
    SELECT serve_id,0,${user}::uuid,${repo}::uuid,${generation}::uuid,${captured.references[0].record_digest},'captured'
    FROM telemetry.feed_serves WHERE user_id=${user}::uuid`;
   await tx.unsafe('ANALYZE telemetry.feed_item_provenance');
   // Exact missing-generation EXISTS branch used by the repair function. An
   // abandoned private generation must not repeatedly read 12000 older serves.
   const rows=await tx`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT 1 FROM telemetry.feed_item_provenance item
    JOIN telemetry.feed_serves serve USING(serve_id)
    WHERE item.generation_id=${missing}::uuid AND item.user_id=${user}::uuid
      AND item.capture_status='captured' AND serve.feed_version=${context.feed_version}::bigint`;
   const plan=rows[0]['QUERY PLAN'][0].Plan;
   const nodes=(node:any):any[]=>[node,...(node.Plans??[]).flatMap(nodes)];
   const all=nodes(plan),index=all.find(node=>node['Index Name']==='feed_item_provenance_generation_owner_idx');
   t.diagnostic(JSON.stringify({rows:12000,nodes:all.map(node=>({type:node['Node Type'],index:node['Index Name'],filtered:node['Rows Removed by Filter'],hits:node['Shared Hit Blocks']}))}));
   assert.ok(index,'repair must use the captured generation/owner index');
   assert.equal(index['Actual Rows'],0);
   assert.ok((plan['Shared Hit Blocks']??0)+(plan['Shared Read Blocks']??0)<50,'missing generation lookup remains bounded independently of owner history');
   throw rollback;
  });
 }catch(error){if(error!==rollback)throw error;}
 finally{await admin.end({timeout:1});}
});
