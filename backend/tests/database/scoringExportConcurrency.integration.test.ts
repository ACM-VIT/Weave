import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import postgres from 'postgres';
import {PostgresScoringExport} from '../../adapters/postgresScoringExport.js';
import {scoringExportPolicyDigest} from '../../config/scoringExport.js';
import {ValidatedScoringGeneration} from '../../services/scoringCaptureValidation.js';

import {assertDisposableDatabase} from './disposableDatabase.js';
const enabled=process.env.RUN_DATABASE_INTEGRATION==='1'&&process.env.RUN_SCORING_EXPORT_INTEGRATION==='1';
if(enabled)assertDisposableDatabase();
const integration=enabled?test:test.skip;
integration('full-schema concurrent account deletion must not invert export source locks', {timeout:20000},async()=>{
 const url=process.env.DATABASE_URL!;const admin=postgres(url,{max:4,prepare:false,connection:{statement_timeout:10000,lock_timeout:0}});
 const user=crypto.randomUUID(),repo=crypto.randomUUID(),generation=crypto.randomUUID(),session=crypto.randomUUID(),suffix=crypto.randomBytes(5).toString('hex');
 const role='delete_export_'+suffix,pause='pause_export_'+suffix;
 let exporter:any,guard:any,seeded=false,roleCreated=false,trigger=false;
 let exporting:Promise<any>|undefined,deleting:Promise<any>|undefined;
 const policy={policyId:'fixture',policyVersion:'1',snapshotTtlSeconds:600,labelHorizonSeconds:10,lateArrivalSeconds:5,clockSkewSeconds:0,labelerVersion:'scoring-labels-v1' as const};
 try{
  await admin`INSERT INTO auth.users(id) VALUES(${user}::uuid)`;await admin`INSERT INTO app.users(user_id,username,status) VALUES(${user}::uuid,${'delete_'+suffix},'active')`;seeded=true;
  await admin`INSERT INTO app.repos(repo_id,github_id,full_name,owner,name,url) VALUES(${repo}::uuid,${String(crypto.randomInt(1000000000,2000000000))}::bigint,${'fixture/'+repo},'fixture',${repo},${'https://github.com/fixture/'+repo})`;
  const f=JSON.parse(readFileSync(new URL('../fixtures/scoring-capture-v1.json',import.meta.url),'utf8'));
  const context={...f.context,user_id:user,generation_id:generation,feed_version:'1'},packet=structuredClone(f.packet);packet.snapshot.repo_id=repo;
  const canonical=(v:object)=>JSON.stringify(v,Object.keys(v).sort());packet.binding_sha256=crypto.createHash('sha256').update(Buffer.concat([Buffer.from('{"context":'+canonical(context)+',"snapshot":'+canonical(packet.snapshot)+'}'),Buffer.from(packet.input_base64,'base64')])).digest('hex');
  const validated=ValidatedScoringGeneration.validate(context,[{packet,rawHeavyScore:0.2,finalScore:0.3,source:'semantic',retrievalScores:{}}],{userId:user,generationId:generation,feedVersion:1n});
  await admin`SELECT private_scoring.persist_generation(${validated.serializeForPersistence({policyId:'fixture',policyVersion:'1',retentionDays:30})})`;
  const [serve]=await admin`INSERT INTO telemetry.feed_serves(feed_request_id,user_id,session_id,feed_version,source,model_version,created_at) VALUES(${crypto.randomUUID()}::uuid,${user}::uuid,${session}::uuid,1,'personalized',${context.model_version},now()-interval '1 minute') RETURNING serve_id`;
  await admin`INSERT INTO telemetry.feed_serve_items(serve_id,position,repo_id,score,source,model_version) VALUES(${serve.serve_id}::uuid,0,${repo}::uuid,0.3,'semantic',${context.model_version})`;
  await admin`INSERT INTO telemetry.feed_item_provenance(serve_id,position,user_id,repo_id,generation_id,record_digest,capture_status) VALUES(${serve.serve_id}::uuid,0,${user}::uuid,${repo}::uuid,${generation}::uuid,${validated.references[0].record_digest},'captured')`;
  await admin.unsafe(`CREATE ROLE ${role} LOGIN IN ROLE ghsocial_scoring_exporter`);roleCreated=true;
  await admin`INSERT INTO private_scoring.export_authorizations(principal_id,policy_digest,scope,subject_ids,expires_at) VALUES(${user}::uuid,${scoringExportPolicyDigest(policy)},'owner',ARRAY[${user}::uuid],now()+interval '1 hour')`;
  const writer=new URL(url);writer.username=role;exporter=postgres(writer.toString(),{max:2,prepare:false,connection:{statement_timeout:10000,lock_timeout:0}});
  const adapter=new PostgresScoringExport(exporter,policy),selection={subjectUserId:user,servedFrom:new Date(Date.now()-3600000).toISOString(),servedTo:new Date(Date.now()-500).toISOString()};
  await adapter.create(user,selection); // Existing fence FK may skip a repeated owner lock.
  const before=Number((await admin`SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()`)[0].deadlocks);
  guard=await admin.reserve();await guard`SELECT pg_advisory_lock(260044,999)`;
  await admin.unsafe(`CREATE FUNCTION private_scoring.${pause}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(260044,999);RETURN NEW;END $$`);
  await admin.unsafe(`CREATE TRIGGER fixture_export_pause BEFORE INSERT ON private_scoring.export_snapshots FOR EACH ROW EXECUTE FUNCTION private_scoring.${pause}()`);trigger=true;
  exporting=adapter.create(user,selection).then(value=>({value}),error=>({error}));
  const wait=async(check:()=>Promise<boolean>)=>{const until=Date.now()+4000;while(!await check()){assert.ok(Date.now()<until,'Expected fixture lock was not reached');await new Promise(resolve=>setTimeout(resolve,10));}};
  await wait(async()=>Number((await admin`SELECT count(*) FROM pg_stat_activity WHERE usename=${role} AND wait_event='advisory'`)[0].count)>0);
  let deletePid=0;deleting=admin.begin(async tx=>{deletePid=Number((await tx`SELECT pg_backend_pid() AS id`)[0].id);await tx`DELETE FROM app.users WHERE user_id=${user}::uuid`;throw new Error('FIXTURE_ROLLBACK');}).then(()=>({}),error=>({error}));
  await wait(async()=>deletePid>0 && Number((await admin`SELECT count(*) FROM pg_stat_activity WHERE pid=${deletePid} AND wait_event_type='Lock'`)[0].count)>0);
  await guard`SELECT pg_advisory_unlock(260044,999)`;guard.release();guard=undefined;
  const [exported,deleted]=await Promise.all([exporting,deleting]);
  await admin`SELECT pg_stat_clear_snapshot()`;
  const after=Number((await admin`SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()`)[0].deadlocks);
  assert.equal(after-before,0,'account deletion and export must preserve user-before-private lock order');
  assert.ok(exported.value);assert.equal(deleted.error?.message,'FIXTURE_ROLLBACK');
 }finally{
  if(guard){await guard`SELECT pg_advisory_unlock(260044,999)`;guard.release();}
  await Promise.allSettled([exporting,deleting]);
  if(trigger)await admin.unsafe('DROP TRIGGER fixture_export_pause ON private_scoring.export_snapshots');
  await admin.unsafe(`DROP FUNCTION IF EXISTS private_scoring.${pause}()`);
  await exporter?.end({timeout:1});
  if(seeded){await admin`DELETE FROM auth.users WHERE id=${user}::uuid`;await admin`DELETE FROM app.repos WHERE repo_id=${repo}::uuid`;}
  if(roleCreated)await admin.unsafe(`DROP ROLE ${role}`);
  await admin.end({timeout:1});
 }
});

integration('export locks at most its501-row rejection prefix, not a later source row', {timeout:30000},async()=>{
 const url=process.env.DATABASE_URL!,admin=postgres(url,{max:3,prepare:false});
 const user=crypto.randomUUID(),repos=Array.from({length:502},()=>crypto.randomUUID()),suffix=crypto.randomBytes(5).toString('hex'),role='bound_export_'+suffix;
 const policy={policyId:'fixture',policyVersion:'1',snapshotTtlSeconds:600,labelHorizonSeconds:10,lateArrivalSeconds:5,clockSkewSeconds:0,labelerVersion:'scoring-labels-v1' as const};
 let exporter:any,release:any,blocking:Promise<any>|undefined,roleCreated=false,seeded=false;
 try{
  await admin`INSERT INTO auth.users(id) VALUES(${user}::uuid)`;await admin`INSERT INTO app.users(user_id,username,status) VALUES(${user}::uuid,${'bound_'+suffix},'active')`;seeded=true;
  const baseId=crypto.randomInt(1000000,2000000)*1000;
  await admin`INSERT INTO app.repos(repo_id,github_id,owner,name,full_name,url)
   SELECT repo,${baseId}::bigint+ordinal,'fixture',repo::text,'fixture/'||repo::text,'https://github.com/fixture/'||repo::text
   FROM unnest(${repos}::uuid[]) WITH ORDINALITY entry(repo,ordinal)`;
  const f=JSON.parse(readFileSync(new URL('../fixtures/scoring-capture-v1.json',import.meta.url),'utf8'));
  const canonical=(v:object)=>JSON.stringify(v,Object.keys(v).sort());const references:any[]=[];
  for(let offset=0;offset<repos.length;offset+=150){
   const generation=crypto.randomUUID(),context={...f.context,user_id:user,generation_id:generation,feed_version:'1'};
   const candidates=repos.slice(offset,offset+150).map(repo=>{
    const packet=structuredClone(f.packet);packet.snapshot.repo_id=repo;
    packet.binding_sha256=crypto.createHash('sha256').update(Buffer.concat([Buffer.from('{"context":'+canonical(context)+',"snapshot":'+canonical(packet.snapshot)+'}'),Buffer.from(packet.input_base64,'base64')])).digest('hex');
    return{packet,rawHeavyScore:0.2,finalScore:0.3,source:'semantic',retrievalScores:{}};
   });
   const validated=ValidatedScoringGeneration.validate(context,candidates,{userId:user,generationId:generation,feedVersion:1n});
   await admin`SELECT private_scoring.persist_generation(${validated.serializeForPersistence({policyId:'fixture',policyVersion:'1',retentionDays:30})})`;
   references.push(...validated.references);
  }
  for(let offset=0;offset<repos.length;offset+=25){
   const [header]=await admin`INSERT INTO telemetry.feed_serves(feed_request_id,user_id,session_id,feed_version,source,model_version,created_at)
    VALUES(${crypto.randomUUID()}::uuid,${user}::uuid,${crypto.randomUUID()}::uuid,1,'personalized',${f.context.model_version},now()-interval '1 minute'+${offset}*interval '1 millisecond') RETURNING serve_id`;
   const rows=repos.slice(offset,offset+25).map((repo,position)=>({repo_id:repo,position,generation_id:references[offset+position].generation_id,record_digest:references[offset+position].record_digest}));
   await admin`INSERT INTO telemetry.feed_serve_items(serve_id,position,repo_id,score,source,model_version)
    SELECT ${header.serve_id}::uuid,position,repo_id,0.3,'semantic',${f.context.model_version}
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb) AS item(repo_id uuid,position smallint)`;
   await admin`INSERT INTO telemetry.feed_item_provenance(serve_id,position,user_id,repo_id,generation_id,record_digest,capture_status)
    SELECT ${header.serve_id}::uuid,position,${user}::uuid,repo_id,generation_id,record_digest,'captured'
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb) AS item(repo_id uuid,position smallint,generation_id uuid,record_digest text)`;
  }
  await admin.unsafe(`CREATE ROLE ${role} LOGIN IN ROLE ghsocial_scoring_exporter`);roleCreated=true;
  await admin`INSERT INTO private_scoring.export_authorizations(principal_id,policy_digest,scope,subject_ids,expires_at) VALUES(${user}::uuid,${scoringExportPolicyDigest(policy)},'owner',ARRAY[${user}::uuid],now()+interval '1 hour')`;
  let ready:any;const locked=new Promise<void>(resolve=>ready=resolve),unlock=new Promise<void>(resolve=>release=resolve);
  blocking=admin.begin(async tx=>{await tx`SELECT repo_id FROM private_scoring.scoring_inputs WHERE generation_id=${references[501].generation_id}::uuid AND repo_id=${repos[501]}::uuid FOR UPDATE`;ready();await unlock;});await locked;
  const writer=new URL(url);writer.username=role;exporter=postgres(writer.toString(),{max:1,prepare:false,connection:{statement_timeout:500,lock_timeout:0}});
  const adapter=new PostgresScoringExport(exporter,policy);
  const result=await adapter.create(user,{subjectUserId:user,servedFrom:new Date(Date.now()-3600000).toISOString(),servedTo:new Date(Date.now()-500).toISOString()}).then(value=>({value}),error=>({error}));
  assert.ok('error' in result);assert.equal(result.error?.reason,'bounds','reject over500rows without waiting on the502nd source');
  assert.equal(Number((await admin`SELECT count(*) FROM private_scoring.export_snapshots WHERE principal_id=${user}::uuid`)[0].count),0);
 }finally{
  release?.();await blocking;await exporter?.end({timeout:1});
  if(seeded){await admin`DELETE FROM auth.users WHERE id=${user}::uuid`;await admin`DELETE FROM app.repos WHERE repo_id=ANY(${repos}::uuid[])`;}
  if(roleCreated)await admin.unsafe(`DROP ROLE ${role}`);await admin.end({timeout:1});
 }
});

integration('export engine faults stay retryable and redact SQL details',async()=>{
 const admin=postgres(process.env.DATABASE_URL!,{max:2,prepare:false});
 const user=crypto.randomUUID(),suffix=crypto.randomBytes(5).toString('hex'),role='fault_export_'+suffix;
 const policy={policyId:'fixture',policyVersion:'1',snapshotTtlSeconds:600,labelHorizonSeconds:10,lateArrivalSeconds:5,clockSkewSeconds:0,labelerVersion:'scoring-labels-v1' as const};
 let exporter:ReturnType<typeof postgres>|undefined,seeded=false,roleCreated=false,trigger=false;
 try{
  await admin`INSERT INTO auth.users(id) VALUES(${user}::uuid)`;
  await admin`INSERT INTO app.users(user_id,username,status) VALUES(${user}::uuid,${'fault_'+suffix},'active')`;seeded=true;
  await admin`INSERT INTO private_scoring.export_authorizations(principal_id,policy_digest,scope,subject_ids,expires_at)
    VALUES(${user}::uuid,${scoringExportPolicyDigest(policy)},'owner',ARRAY[${user}::uuid],now()+interval '1 hour')`;
  await admin.unsafe(`CREATE ROLE ${role} LOGIN IN ROLE ghsocial_scoring_exporter`);roleCreated=true;
  const url=new URL(process.env.DATABASE_URL!);url.username=role;url.password='';exporter=postgres(url.toString(),{max:1,prepare:false});
  await admin.unsafe("CREATE FUNCTION private_scoring.fixture_export_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='40P01',MESSAGE='PRIVATE injected engine detail'; END $$");
  await admin.unsafe('CREATE TRIGGER fixture_export_fault BEFORE INSERT ON private_scoring.export_snapshots FOR EACH ROW EXECUTE FUNCTION private_scoring.fixture_export_fault()');trigger=true;
  const selection={subjectUserId:user,servedFrom:new Date(Date.now()-3600000).toISOString(),servedTo:new Date(Date.now()-1000).toISOString()};
  const port=new PostgresScoringExport(exporter,policy);
  await assert.rejects(port.create(user,selection),(error:unknown)=>{
    assert.ok(error instanceof Error);assert.equal('cause' in error,false);assert.doesNotMatch(String(error),/PRIVATE/);
    assert.equal((error as {reason?:string}).reason,'unavailable');return true;
  });
  await admin.unsafe('DROP TRIGGER fixture_export_fault ON private_scoring.export_snapshots');trigger=false;
  assert.equal((await port.create(user,selection)).row_count,0,'the same adapter recovers after the engine fault');
 }finally{
  if(trigger)await admin.unsafe('DROP TRIGGER fixture_export_fault ON private_scoring.export_snapshots');
  await admin.unsafe('DROP FUNCTION IF EXISTS private_scoring.fixture_export_fault()');await exporter?.end({timeout:1});
  if(seeded)await admin`DELETE FROM auth.users WHERE id=${user}::uuid`;
  if(roleCreated)await admin.unsafe(`DROP ROLE ${role}`);await admin.end({timeout:1});
 }
});

async function withAdmissionFixture(run:(admin:ReturnType<typeof postgres>,exporter:ReturnType<typeof postgres>,port:PostgresScoringExport,users:string[],selection:{subjectUserId:string;servedFrom:string;servedTo:string})=>Promise<void>){
 const admin=postgres(process.env.DATABASE_URL!,{max:4,prepare:false}),users=[crypto.randomUUID(),crypto.randomUUID(),crypto.randomUUID()];
 const suffix=crypto.randomBytes(5).toString('hex'),role='admission_export_'+suffix;
 const policy={policyId:'fixture',policyVersion:'1',snapshotTtlSeconds:600,labelHorizonSeconds:10,lateArrivalSeconds:5,clockSkewSeconds:0,labelerVersion:'scoring-labels-v1' as const};
 let exporter:ReturnType<typeof postgres>|undefined,roleCreated=false;
 try{
  for(const [i,user]of users.entries()){
   await admin`INSERT INTO auth.users(id) VALUES(${user}::uuid)`;
   await admin`INSERT INTO app.users(user_id,username,status) VALUES(${user}::uuid,${'admission_'+suffix+'_'+i},'active')`;
  }
  await admin.unsafe(`CREATE ROLE ${role} LOGIN IN ROLE ghsocial_scoring_exporter`);roleCreated=true;
  const url=new URL(process.env.DATABASE_URL!);url.username=role;url.password='';exporter=postgres(url.toString(),{max:2,prepare:false,connection:{statement_timeout:5000}});
  await admin`INSERT INTO private_scoring.export_authorizations(principal_id,policy_digest,scope,subject_ids,expires_at)
   VALUES(${users[0]}::uuid,${scoringExportPolicyDigest(policy)},'admin',${users}::uuid[],now()+interval '1 hour')`;
  const selection={subjectUserId:users[1],servedFrom:new Date(Date.now()-3600000).toISOString(),servedTo:new Date(Date.now()-1000).toISOString()};
  await run(admin,exporter,new PostgresScoringExport(exporter,policy),users,selection);
 }finally{
  await exporter?.end({timeout:1});
  await admin`DELETE FROM telemetry.interaction_events WHERE user_id=ANY(${users}::uuid[])`;
  await admin`DELETE FROM auth.users WHERE id=ANY(${users}::uuid[])`;
  if(roleCreated)await admin.unsafe(`DROP ROLE ${role}`);await admin.end({timeout:1});
 }
}

integration('different-subject RR exports cannot overbook the same principal capacity', {timeout:15000},async()=>{
 await withAdmissionFixture(async(admin,exporter,port,users,selection)=>{
  for(let i=0;i<4;i++)await port.create(users[0],selection);
  const guard=await admin.reserve();let waiting:Promise<PromiseSettledResult<unknown>[]>|undefined,locked=false;
  try{
   await guard`SELECT pg_advisory_lock(260044,1)`;locked=true;
   waiting=Promise.allSettled([port.create(users[0],selection),port.create(users[0],{...selection,subjectUserId:users[2]})]);
   const deadline=Date.now()+5000;
   while(Number((await admin`SELECT count(*) FROM pg_stat_activity WHERE usename=${exporter.options.user} AND wait_event='advisory'`)[0].count)<2){assert.ok(Date.now()<deadline,'Both old RR snapshots must reach admission');await new Promise(resolve=>setTimeout(resolve,10));}
   await guard`SELECT pg_advisory_unlock(260044,1)`;locked=false;
   const results=await waiting;
   assert.equal(Number((await admin`SELECT count(*) FROM private_scoring.export_snapshots WHERE principal_id=${users[0]}::uuid`)[0].count),5);
   assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
   const rejected=results.find(result=>result.status==='rejected');assert.ok(rejected&&rejected.status==='rejected');assert.equal(rejected.reason.reason,'capacity');
  }finally{if(locked)await guard`SELECT pg_advisory_unlock(260044,1)`;guard.release();await waiting;}
 });
});

integration('registry revocation after an RR snapshot cannot authorize stale exports',async()=>{
 await withAdmissionFixture(async(admin,exporter,port,users,selection)=>{
  await port.create(users[0],selection); // Existing subject fence avoids a new-row conflict masking grant authorization.
  let ready!:()=>void,proceed!:()=>void;const started=new Promise<void>(resolve=>ready=resolve),gate=new Promise<void>(resolve=>proceed=resolve);
  const stale=exporter.begin('isolation level repeatable read',async tx=>{
   await tx`SELECT pg_current_snapshot()`;ready();await gate;
   await tx`SELECT private_scoring.create_export_snapshot(${users[0]}::uuid,${users[1]}::uuid,${selection.servedFrom}::timestamptz,${selection.servedTo}::timestamptz,
    ${JSON.stringify({clockSkewSeconds:0,labelHorizonSeconds:10,labelerVersion:'scoring-labels-v1',lateArrivalSeconds:5,policyId:'fixture',policyVersion:'1',snapshotTtlSeconds:600})}::text)`;
  });
  try{await started;await admin`UPDATE private_scoring.export_authorizations SET revoked=true WHERE principal_id=${users[0]}::uuid`;proceed();await assert.rejects(stale,{code:'40001'});}
  finally{proceed();await Promise.allSettled([stale]);}
  await assert.rejects(port.create(users[0],selection),(error:unknown)=>!!error&&typeof error==='object'&&'reason'in error&&error.reason==='forbidden');
  await admin`UPDATE private_scoring.export_authorizations SET revoked=false WHERE principal_id=${users[0]}::uuid`;
  assert.equal((await port.create(users[0],selection)).row_count,0);
 });
});

integration('global event overflow rejects before any exposure/event JSON timestamp materialization',async()=>{
 await withAdmissionFixture(async(admin,_exporter,port,users,selection)=>{
  const repo=crypto.randomUUID(),repo2=crypto.randomUUID(),serve=crypto.randomUUID();let instrumented=false;
  try{
   await admin`INSERT INTO app.repos(repo_id,github_id,owner,name,full_name,url) VALUES(${repo}::uuid,${String(crypto.randomInt(1000000000,2000000000))}::bigint,'fixture',${repo},${'fixture/'+repo},${'https://github.com/fixture/'+repo})`;
   await admin`INSERT INTO app.repos(repo_id,github_id,owner,name,full_name,url) VALUES(${repo2}::uuid,${String(crypto.randomInt(1000000000,2000000000))}::bigint,'fixture',${repo2},${'fixture/'+repo2},${'https://github.com/fixture/'+repo2})`;
   await admin`INSERT INTO telemetry.feed_serves(serve_id,feed_request_id,user_id,session_id,feed_version,source,model_version,created_at)
    VALUES(${serve}::uuid,${crypto.randomUUID()}::uuid,${users[1]}::uuid,${crypto.randomUUID()}::uuid,1,'personalized','fixture',now()-interval '1 minute')`;
   await admin`INSERT INTO telemetry.feed_serve_items(serve_id,position,repo_id,score,source,model_version) VALUES(${serve}::uuid,0,${repo}::uuid,0.3,'semantic','fixture'),(${serve}::uuid,1,${repo2}::uuid,0.3,'semantic','fixture')`;
   await admin`INSERT INTO telemetry.interaction_events(event_id,schema_version,user_id,session_id,serve_id,repo_id,position,event_type,client_occurred_at)
    SELECT gen_random_uuid(),2,${users[1]}::uuid,${crypto.randomUUID()}::uuid,${serve}::uuid,CASE WHEN number%2=0 THEN ${repo}::uuid ELSE ${repo2}::uuid END,(number%2)::smallint,'impression',now()-interval '30 seconds' FROM generate_series(1,5001)number`;
   await admin.unsafe('CREATE SEQUENCE private_scoring.fixture_timestamp_calls');
   await admin.unsafe(`CREATE OR REPLACE FUNCTION private_scoring.export_timestamp(value timestamptz) RETURNS text LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ BEGIN PERFORM nextval('private_scoring.fixture_timestamp_calls'); RETURN to_char(value AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');END $$`);instrumented=true;
   await assert.rejects(port.create(users[0],selection),(error:unknown)=>!!error&&typeof error==='object'&&'reason'in error&&error.reason==='bounds');
   assert.equal((await admin`SELECT is_called FROM private_scoring.fixture_timestamp_calls`)[0].is_called,false,'global5001 preflight must reject before materializing any per-row JSON');
   assert.equal(Number((await admin`SELECT count(*) FROM private_scoring.export_snapshots WHERE principal_id=${users[0]}::uuid`)[0].count),0);
  }finally{
   if(instrumented){
    const source=readFileSync(new URL('../../../database/migrations/0044_private_scoring_exports.sql',import.meta.url),'utf8');
    const original=source.match(/CREATE FUNCTION private_scoring\.export_timestamp[\s\S]*?\$\$;/)?.[0];assert.ok(original);await admin.unsafe(original.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'));
   }
   await admin.unsafe('DROP SEQUENCE IF EXISTS private_scoring.fixture_timestamp_calls');
   await admin`DELETE FROM telemetry.interaction_events WHERE serve_id=${serve}::uuid`;
   await admin`DELETE FROM telemetry.feed_serve_items WHERE serve_id=${serve}::uuid`;await admin`DELETE FROM telemetry.feed_serves WHERE serve_id=${serve}::uuid`;await admin`DELETE FROM app.repos WHERE repo_id=ANY(${[repo,repo2]}::uuid[])`;
  }
 });
});


integration('a snapshot cannot commit an exposure too large for even a one-row export page',async()=>{
 await withAdmissionFixture(async(admin,_exporter,port,users,selection)=>{
  const repo=crypto.randomUUID(),repo2=crypto.randomUUID(),serve=crypto.randomUUID();
  try{
   await admin`INSERT INTO app.repos(repo_id,github_id,owner,name,full_name,url) VALUES(${repo}::uuid,${String(crypto.randomInt(1000000000,2000000000))}::bigint,'fixture',${repo},${'fixture/'+repo},${'https://github.com/fixture/'+repo})`;
   await admin`INSERT INTO app.repos(repo_id,github_id,owner,name,full_name,url) VALUES(${repo2}::uuid,${String(crypto.randomInt(1000000000,2000000000))}::bigint,'fixture',${repo2},${'fixture/'+repo2},${'https://github.com/fixture/'+repo2})`;
   await admin`INSERT INTO telemetry.feed_serves(serve_id,feed_request_id,user_id,session_id,feed_version,source,model_version,created_at)
    VALUES(${serve}::uuid,${crypto.randomUUID()}::uuid,${users[1]}::uuid,${crypto.randomUUID()}::uuid,1,'personalized','fixture',now()-interval '1 minute')`;
   await admin`INSERT INTO telemetry.feed_serve_items(serve_id,position,repo_id,score,source,model_version) VALUES(${serve}::uuid,0,${repo}::uuid,0.3,'semantic','fixture'),(${serve}::uuid,1,${repo2}::uuid,0.3,'semantic','fixture')`;
   await admin`INSERT INTO telemetry.interaction_events(event_id,schema_version,user_id,session_id,serve_id,repo_id,position,event_type,client_occurred_at)
    SELECT gen_random_uuid(),2,${users[1]}::uuid,${crypto.randomUUID()}::uuid,${serve}::uuid,${repo}::uuid,0,'impression',now()-interval '30 seconds' FROM generate_series(1,2000)number`;
   await assert.rejects(port.create(users[0],selection),(error:unknown)=>!!error&&typeof error==='object'&&'reason'in error&&error.reason==='bounds');
   assert.equal(Number((await admin`SELECT count(*) FROM private_scoring.export_snapshots WHERE principal_id=${users[0]}::uuid`)[0].count),0);
  }finally{
   await admin`DELETE FROM telemetry.interaction_events WHERE serve_id=${serve}::uuid`;
   await admin`DELETE FROM telemetry.feed_serve_items WHERE serve_id=${serve}::uuid`;await admin`DELETE FROM telemetry.feed_serves WHERE serve_id=${serve}::uuid`;await admin`DELETE FROM app.repos WHERE repo_id=ANY(${[repo,repo2]}::uuid[])`;
  }
 });
});
