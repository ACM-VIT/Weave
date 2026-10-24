import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Sql } from 'postgres';
import { PostgresScoringPersistence, ScoringPersistenceError } from '../../adapters/postgresScoringPersistence.js';
import { ValidatedScoringGeneration } from '../../services/scoringCaptureValidation.js';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/scoring-capture-v1.json',import.meta.url),'utf8'));
const generation=ValidatedScoringGeneration.validate(fixture.context,[{packet:fixture.packet,rawHeavyScore:0.2,finalScore:0.3,
  source:'semantic',retrievalScores:{}}],{userId:fixture.context.user_id,generationId:fixture.context.generation_id,
  feedVersion:BigInt(fixture.context.feed_version)});
const policy={policyId:'fixture',policyVersion:'1',retentionDays:30};
const allowed={writer:true,exporter:false,retention:false,product:false,rolsuper:false,rolcreaterole:false,
  rolcreatedb:false,rolreplication:false,rolbypassrls:false,reads_inputs:false,reads_context:false,reads_product:false};

test('a failed shared permission probe can recover on the same adapter without leaking its SQL cause',async()=>{
  let permissions=0,writes=0,available=false;
  const sql=(async(parts:TemplateStringsArray)=>{
    if(parts.join('').includes('pg_has_role')){
      permissions++;if(!available)throw Object.assign(new Error('PRIVATE temporary connection detail'),{code:'08006'});
      return [allowed];
    }
    writes++;return [{result:{generation_id:fixture.context.generation_id,expires_at:'2026-11-23T00:00:00.000Z',references:generation.references}}];
  }) as unknown as Sql;
  const adapter=new PostgresScoringPersistence(sql);
  const failed=await Promise.allSettled([adapter.persist(generation,policy),adapter.persist(generation,policy)]);
  assert.equal(permissions,1,'concurrent attempts share one in-flight permission query');
  for(const result of failed){assert.equal(result.status,'rejected');if(result.status==='rejected'){
    assert.ok(result.reason instanceof ScoringPersistenceError);assert.equal(result.reason.reason,'unavailable');
    assert.equal(result.reason.cause,undefined);assert.doesNotMatch(String(result.reason),/PRIVATE/);
  }}
  available=true;
  const result=await adapter.persist(generation,policy);
  assert.deepEqual(result.references,generation.references);assert.equal(permissions,2);assert.equal(writes,1);
  await adapter.persist(generation,policy);assert.equal(permissions,2,'successful permission proof remains cached');
});
