import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {Server} from 'node:http';
import test from 'node:test';
import postgres from 'postgres';
import jwt from 'jsonwebtoken';
import {ValidatedScoringGeneration} from '../../services/scoringCaptureValidation.js';
import {scoringExportPolicyDigest} from '../../config/scoringExport.js';
import {assertDisposableDatabase} from '../database/disposableDatabase.js';
import type {ScoringExportManifest,ScoringExportPage,ScoringExportPolicy} from '../../contracts/scoringExport.js';
const enabled=process.env.RUN_DATABASE_INTEGRATION==='1'&&process.env.RUN_SCORING_EXPORT_INTEGRATION==='1'&&process.env.RUN_REDIS_INTEGRATION==='1';
if(enabled)assertDisposableDatabase();
const integration=enabled?test:test.skip;

integration('registered API serves captured rows, accepts immutable activity, exports only approved callers and closes separate pools', {timeout:30000},async()=>{
 const target=new URL(process.env.REDIS_TEST_URL??'');assert.ok(['127.0.0.1','localhost'].includes(target.hostname)&&target.pathname==='/15');
 const admin=postgres(process.env.DATABASE_URL!,{max:3,prepare:false});
 const user=crypto.randomUUID(),repo=crypto.randomUUID(),generation=crypto.randomUUID(),session=crypto.randomUUID(),suffix=crypto.randomBytes(5).toString('hex');
 const exporterRole='http_export_'+suffix,retentionRole='http_retention_'+suffix;
 const policy:ScoringExportPolicy={policyId:'http-fixture',policyVersion:'1',snapshotTtlSeconds:600,labelHorizonSeconds:10,lateArrivalSeconds:5,clockSkewSeconds:0,labelerVersion:'scoring-labels-v1'};
 const golden=JSON.parse(readFileSync(new URL('../fixtures/scoring-capture-v1.json',import.meta.url),'utf8'));
 let seeded=false,roles=false,server:Server|undefined,api:any,maintenance:any,redis:any,productSql:any;
 try{
  await admin`INSERT INTO auth.users(id) VALUES(${user}::uuid)`;
  await admin`INSERT INTO app.users(user_id,username,status) VALUES(${user}::uuid,${'http_export_'+suffix},'active')`;seeded=true;
  await admin`INSERT INTO app.repos(repo_id,github_id,owner,name,full_name,url) VALUES(${repo}::uuid,${String(crypto.randomInt(1000000000,2000000000))}::bigint,'fixture',${repo},${'fixture/'+repo},${'https://github.com/fixture/'+repo})`;
  await admin`INSERT INTO app.repo_content(repo_id,content_hash,content_version) VALUES(${repo}::uuid,'fixture',1)`;
  const context={...golden.context,user_id:user,generation_id:generation,feed_version:'1'},packet=structuredClone(golden.packet);packet.snapshot.repo_id=repo;
  const canonical=(value:object)=>JSON.stringify(value,Object.keys(value).sort());
  packet.binding_sha256=crypto.createHash('sha256').update(Buffer.concat([Buffer.from('{"context":'+canonical(context)+',"snapshot":'+canonical(packet.snapshot)+'}'),Buffer.from(packet.input_base64,'base64')])).digest('hex');
  const validated=ValidatedScoringGeneration.validate(context,[{packet,rawHeavyScore:0.2,finalScore:0.3,source:'semantic',retrievalScores:{}}],{userId:user,generationId:generation,feedVersion:1n});
  await admin`SELECT private_scoring.persist_generation(${validated.serializeForPersistence({policyId:'fixture',policyVersion:'1',retentionDays:30})})`;
  await admin.unsafe(`CREATE ROLE ${exporterRole} LOGIN IN ROLE ghsocial_scoring_exporter; CREATE ROLE ${retentionRole} LOGIN IN ROLE ghsocial_scoring_retention`);roles=true;
  const exportUrl=new URL(process.env.DATABASE_URL!);exportUrl.username=exporterRole;exportUrl.password='';
  const retentionUrl=new URL(exportUrl);retentionUrl.username=retentionRole;
  Object.assign(process.env,{NODE_ENV:'test',REDIS_URL:target.toString(),JWT_SECRET:'scoring-http-fixture-signing-only',
    SUPABASE_URL:'http://127.0.0.1:9',SUPABASE_KEY:'fixture-only',ML_V2_RECOMMENDATIONS:'false',ML_FEEDBACK_OUTBOX:'false',TRENDING_INGESTION:'false',
    FEED_REFILL_INDEX_READY:'false',SCORING_CAPTURE_ENABLED:'false',SCORING_RETENTION_ENABLED:'false',SCORING_EXPORT_ENABLED:'true',
    SCORING_EXPORT_POLICY_ID:policy.policyId,SCORING_EXPORT_POLICY_VERSION:policy.policyVersion,SCORING_EXPORT_SNAPSHOT_TTL_SECONDS:'600',
    SCORING_EXPORT_LABEL_HORIZON_SECONDS:'10',SCORING_EXPORT_LATE_ARRIVAL_SECONDS:'5',SCORING_EXPORT_CLOCK_SKEW_SECONDS:'0',
    SCORING_EXPORT_DATABASE_URL:exportUrl.toString(),SCORING_EXPORT_STATEMENT_TIMEOUT_MS:'2000'});
  const [{default:app},{getApplicationRuntime,ApplicationRuntime},{default:runtimeRedis},{sqlClient}]=await Promise.all([
    import('../../app.js'),import('../../runtime/applicationRuntime.js'),import('../../config/redis.js'),import('../../db/index.js')]);
  api=getApplicationRuntime();redis=runtimeRedis;productSql=sqlClient;
  await api.queue.replace(user,1n,[{repo_id:repo,score:0.3,source:'semantic',model_version:context.model_version,generation_id:generation,scoring_reference:validated.references[0]}],600);
  server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server!.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
  const token=jwt.sign({userId:user,email:'fixture@example.invalid'},process.env.JWT_SECRET!,{expiresIn:60});
  const headers={authorization:'Bearer '+token,'content-type':'application/json'};
  const post=(path:string,body:unknown)=>fetch(origin+path,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
  assert.equal((await fetch(origin+'/healthz')).status,200);
  assert.equal((await fetch(origin+'/api/v2/repositories/'+repo+'/share')).status,200,'export authentication must not intercept public share metadata');
  assert.equal((await fetch(origin+'/api/v2/scoring-exports/00000000-0000-0000-0000-000000000000')).status,401);
  const request={feed_request_id:crypto.randomUUID(),session_id:session,limit:1,cursor:null};
  const served=await post('/api/v2/feed',request);assert.equal(served.status,200,await served.clone().text());
  const feed=await served.json() as {serve_id:string;items:Array<{exposure_id:string;generation_id:string;repo_id:string;position:number}>};assert.ok(feed.items[0].exposure_id);
  assert.doesNotMatch(JSON.stringify(feed),/scoring_reference|record_digest|input_base64|scoring_context/);
  const timestamp=new Date().toISOString();
  const events=['impression','share','like'].map(event_type=>({event_id:crypto.randomUUID(),schema_version:2,repo_id:repo,session_id:session,serve_id:feed.serve_id,position:0,event_type,client_occurred_at:timestamp,context:{},dwell_ms:null}));
  const activity=await post('/api/v2/interactions/batch',{events});assert.equal(activity.status,202,await activity.clone().text());
  assert.equal((await post('/api/v2/interactions/batch',{events})).status,202);
  const selection={subject_user_id:user,served_from:new Date(Date.now()-3600000).toISOString(),served_to:new Date().toISOString()};
  assert.equal((await post('/api/v2/scoring-exports',selection)).status,403,'ordinary product authentication grants no export authority');
  await admin`INSERT INTO private_scoring.export_authorizations(principal_id,policy_digest,scope,subject_ids,expires_at) VALUES(${user}::uuid,${scoringExportPolicyDigest(policy)},'owner',ARRAY[${user}::uuid],now()+interval '1 hour')`;
  assert.equal((await post('/api/v2/scoring-exports',{...selection,padding:'PRIVATE'.repeat(1000)})).status,413,'4KB parser must run before the global256KB parser');
  const created=await post('/api/v2/scoring-exports',selection);assert.equal(created.status,201,await created.clone().text());
  const manifest=await created.json() as ScoringExportManifest;
  const read=await fetch(origin+'/api/v2/scoring-exports/'+manifest.job_id,{headers});assert.equal(read.status,200);
  assert.equal(read.headers.get('cache-control'),'no-store');const page=await read.json() as ScoringExportPage;
  assert.equal(page.rows.length,1);assert.equal(page.rows[0].input!.input_base64,golden.packet.input_base64);
  assert.equal(page.rows[0].exposure.exposure_id,feed.items[0].exposure_id);
  assert.deepEqual(page.rows[0].exposure.events.map(event=>event.event_id).sort(),events.map(event=>event.event_id).sort());
  assert.equal(page.rows[0].labels.action_counts.share,1);assert.equal(page.rows[0].labels.action_counts.like,1);
  await admin.begin(async tx=>{await tx.unsafe('SET LOCAL session_replication_role=replica');await tx`UPDATE private_scoring.scoring_generations SET created_at=created_at-interval '31 days',expires_at=expires_at-interval '31 days' WHERE generation_id=${generation}::uuid`;});
  assert.equal((await fetch(origin+'/api/v2/scoring-exports/'+manifest.job_id,{headers})).status,410);
  Object.assign(process.env,{SCORING_RETENTION_ENABLED:'true',SCORING_RETENTION_DATABASE_URL:retentionUrl.toString(),SCORING_RETENTION_STATEMENT_TIMEOUT_MS:'2000',SCORING_RETENTION_BATCH_SIZE:'1',SCORING_RETENTION_INTERVAL_MS:'1000',DB_SCHEMA_V2_READS:'false',DB_SCHEMA_V2_WRITES:'false',FEED_V2:'false',FEED_RESERVATIONS:'false'});
  maintenance=new ApplicationRuntime('maintenance');assert.equal(maintenance.privateScoringExport,null);maintenance.start();
  const deadline=Date.now()+5000;
  while(Number((await admin`SELECT count(*) FROM private_scoring.scoring_generations WHERE generation_id=${generation}::uuid`)[0].count)>0){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(Number((await admin`SELECT count(*) FROM telemetry.feed_item_provenance WHERE user_id=${user}::uuid`)[0].count),1,'private retention cannot erase exposure history');
  Object.assign(process.env,{DB_SCHEMA_V2_READS:'true',DB_SCHEMA_V2_WRITES:'true',FEED_V2:'true',FEED_RESERVATIONS:'true'});
  const replay=await (await post('/api/v2/feed',request)).json() as typeof feed;
  assert.equal(replay.serve_id,feed.serve_id);
  assert.deepEqual(replay.items.map(item=>[item.exposure_id,item.generation_id,item.repo_id,item.position]),feed.items.map(item=>[item.exposure_id,item.generation_id,item.repo_id,item.position]),'retention preserves immutable serve attribution while current product overlays can update');
  await maintenance.supervisor.stop();maintenance=undefined;await api.supervisor.stop();
  const connections=await admin`SELECT usename FROM pg_stat_activity WHERE usename=ANY(${[exporterRole,retentionRole]}::text[])`;
  assert.equal(connections.length,0,'shutdown closes both separate private pools');
 }finally{
  await maintenance?.supervisor.stop();await api?.supervisor.stop();
  if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
  if(redis){const keys=await redis.keys(`*${user}*`);if(keys.length)await redis.del(...keys);redis.disconnect();}
  await productSql?.end({timeout:1});
  if(seeded){await admin`DELETE FROM telemetry.interaction_events WHERE user_id=${user}::uuid`;await admin`DELETE FROM telemetry.feed_item_provenance WHERE user_id=${user}::uuid`;await admin`DELETE FROM telemetry.feed_serve_items WHERE serve_id IN (SELECT serve_id FROM telemetry.feed_serves WHERE user_id=${user}::uuid)`;await admin`DELETE FROM telemetry.feed_serves WHERE user_id=${user}::uuid`;await admin`DELETE FROM auth.users WHERE id=${user}::uuid`;await admin`DELETE FROM app.repos WHERE repo_id=${repo}::uuid`;}
  if(roles)await admin.unsafe(`DROP ROLE ${exporterRole}; DROP ROLE ${retentionRole}`);await admin.end({timeout:1});
 }
});
