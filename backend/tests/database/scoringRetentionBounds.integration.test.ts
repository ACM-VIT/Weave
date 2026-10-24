import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import postgres from 'postgres';
import {assertDisposableDatabase} from './disposableDatabase.js';
import {ValidatedScoringGeneration} from '../../services/scoringCaptureValidation.js';

const enabled=process.env.RUN_SCORING_RETENTION_BOUNDS_INTEGRATION==='1';
if(enabled)assertDisposableDatabase();
const integration=enabled?test:test.skip;
const golden=JSON.parse(readFileSync(new URL('../fixtures/scoring-capture-v1.json',import.meta.url),'utf8'));
for(const kind of ['generation','snapshot'] as const)integration(`private retention bounds subject locks before selecting a ${kind} deletion`,{timeout:30000},async t=>{
 const admin=postgres(process.env.DATABASE_URL!,{max:2,prepare:false});
 const blocker=postgres(process.env.DATABASE_URL!,{max:1,prepare:false});
 const owners=Array.from({length:16},()=>crypto.randomUUID()).sort(),repo=crypto.randomUUID();
 let release:(()=>void)|undefined,holding:Promise<unknown>|undefined;
 try {
  for(const owner of owners){
   await admin`INSERT INTO auth.users(id) VALUES(${owner}::uuid)`;
   await admin`INSERT INTO app.users(user_id,username,status) VALUES(${owner}::uuid,${'purge_'+owner.replaceAll('-','')},'active')`;
  }
  await admin`INSERT INTO app.repos(repo_id,github_id,owner,name,full_name,url) VALUES(${repo}::uuid,${String(crypto.randomInt(1000000000,2000000000))}::bigint,'fixture',${repo},${'fixture/'+repo},${'https://github.com/fixture/'+repo})`;
  for(const owner of owners){
   if(kind==='snapshot'){
    await admin`INSERT INTO private_scoring.export_snapshots(principal_id,subject_user_id,policy_digest,manifest,frozen_rows,expires_at)
     VALUES(${owner}::uuid,${owner}::uuid,'owned-fixture','{}','[]',clock_timestamp()-interval '1 second')`;
   }else{
    const generation=crypto.randomUUID(),context={...golden.context,user_id:owner,generation_id:generation};
    const packet=structuredClone(golden.packet);packet.snapshot.repo_id=repo;
    const canonical=(value:object)=>JSON.stringify(value,Object.keys(value).sort());
    packet.binding_sha256=crypto.createHash('sha256').update(Buffer.concat([Buffer.from('{"context":'+canonical(context)+',"snapshot":'+canonical(packet.snapshot)+'}'),Buffer.from(packet.input_base64,'base64')])).digest('hex');
    const captured=ValidatedScoringGeneration.validate(context,[{packet,rawHeavyScore:0.2,finalScore:0.3,source:'semantic',retrievalScores:{}}],{userId:owner,generationId:generation,feedVersion:BigInt(context.feed_version)});
    await admin`SELECT private_scoring.persist_generation(${captured.serializeForPersistence({policyId:'owned-retention-fixture',policyVersion:'1',retentionDays:30})})`;
    await admin`INSERT INTO private_scoring.subject_revocations(user_id) VALUES(${owner}::uuid)`;
   }
  }
  const expected=(count:number)=>({generations_deleted:kind==='generation'?count:0,snapshots_deleted:kind==='snapshot'?count:0});
  await admin.begin(async tx=>{
   await tx.unsafe('SET LOCAL ROLE ghsocial_scoring_retention');
   const [row]=await tx`SELECT private_scoring.purge_scoring_private(1) AS result`;
   assert.deepEqual(row.result,expected(1));
   const [locks]=await tx`SELECT count(*)::integer AS count FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'`;
   t.diagnostic(`${kind}:16 subjects,batch1,advisory locks=${locks.count}`);
   assert.equal(locks.count,1,'only a bounded candidate subject may be locked');
  });
  // The next selected subject can be busy in capture/export. Do not fan out
  // across the remaining backlog trying more locks to fill this small batch.
  let locked!:()=>void;
  const acquired=new Promise<void>(resolve=>{locked=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  holding=blocker.begin(async tx=>{await tx`SELECT pg_advisory_xact_lock(hashtextextended(${owners[1]}::text,260044))`;locked();await gate;});
  await acquired;
  try {
   const [blocked]=await admin`SELECT private_scoring.purge_scoring_private(1) AS result`;
   assert.deepEqual(blocked.result,expected(0),'busy bounded candidates remain for a later cycle');
  }finally{release?.();await holding;holding=undefined;}
  const [retry]=await admin`SELECT private_scoring.purge_scoring_private(1) AS result`;
  assert.deepEqual(retry.result,expected(1),'the same work remains eligible after its subject lock is released');
 }finally{
  release?.();await holding;
  await admin`DELETE FROM auth.users WHERE id=ANY(${owners}::uuid[])`;
  await admin`DELETE FROM app.repos WHERE repo_id=${repo}::uuid`;
  await blocker.end({timeout:1});await admin.end({timeout:1});
 }
});
