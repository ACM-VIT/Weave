import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type {Server} from 'node:http';
import test from 'node:test';
import postgres from 'postgres';
import jwt from 'jsonwebtoken';
import {PostgresScoringExport} from '../../adapters/postgresScoringExport.js';
import {scoringExportPolicyDigest} from '../../config/scoringExport.js';
import type {ScoringExportPolicy,ScoringExportManifest,ScoringExportPage} from '../../contracts/scoringExport.js';
import {assertDisposableDatabase} from '../database/disposableDatabase.js';
const enabled=process.env.RUN_DATABASE_INTEGRATION==='1'&&process.env.RUN_IMPRESSION_LINKAGE_INTEGRATION==='1';
if(enabled)assertDisposableDatabase();
const integration=enabled?test:test.skip;

integration('actual HTTP keeps original impression references immutable without requiring target arrival or exposing foreign ownership',async()=>{
 const redisTarget=new URL(process.env.REDIS_TEST_URL??'');assert.ok(['127.0.0.1','localhost'].includes(redisTarget.hostname)&&redisTarget.pathname==='/15');
 const admin=postgres(process.env.DATABASE_URL!,{max:2,prepare:false});
 const user=crypto.randomUUID(),foreign=crypto.randomUUID(),repo=crypto.randomUUID(),session=crypto.randomUUID();
 const serve=crypto.randomUUID(),foreignServe=crypto.randomUUID(),otherServe=crypto.randomUUID(),original=crypto.randomUUID();
 const exportRole='impression_export_'+user.replaceAll('-','');
 const policy:ScoringExportPolicy={policyId:'fixture',policyVersion:'1',snapshotTtlSeconds:600,labelHorizonSeconds:10,lateArrivalSeconds:5,clockSkewSeconds:0,labelerVersion:'scoring-labels-v2'};
 let exporter:ReturnType<typeof postgres>|undefined,roleCreated=false;
 let seeded=false,server:Server|undefined,closeRuntime:(()=>Promise<void>)|undefined,disconnect:(()=>void)|undefined,closeSql:(()=>Promise<void>)|undefined;
 try{
  Object.assign(process.env,{NODE_ENV:'test',REDIS_URL:redisTarget.toString(),JWT_SECRET:'impression-fixture-signing-only',SUPABASE_URL:'http://127.0.0.1:9',SUPABASE_KEY:'fixture',ML_V2_RECOMMENDATIONS:'false',ML_FEEDBACK_OUTBOX:'false',TRENDING_INGESTION:'false',SCORING_CAPTURE_ENABLED:'false',SCORING_EXPORT_ENABLED:'true',SCORING_EXPORT_POLICY_ID:'fixture',SCORING_EXPORT_POLICY_VERSION:'1',SCORING_EXPORT_SNAPSHOT_TTL_SECONDS:'600',SCORING_EXPORT_LABEL_HORIZON_SECONDS:'10',SCORING_EXPORT_LATE_ARRIVAL_SECONDS:'5',SCORING_EXPORT_CLOCK_SKEW_SECONDS:'0',SCORING_EXPORT_LABELER_VERSION:'scoring-labels-v2',SCORING_EXPORT_STATEMENT_TIMEOUT_MS:'2000',SCORING_RETENTION_ENABLED:'false'});
  for(const owner of[user,foreign]){
   await admin`INSERT INTO auth.users(id) VALUES(${owner}::uuid)`;
   await admin`INSERT INTO app.users(user_id,username,status) VALUES(${owner}::uuid,${'impression_'+owner.replaceAll('-','')},'active')`;
  }seeded=true;
  await admin`INSERT INTO app.repos(repo_id,github_id,owner,name,full_name,url) VALUES(${repo}::uuid,${String(crypto.randomInt(1000000000,2000000000))}::bigint,'fixture',${repo},${'fixture/'+repo},${'https://github.com/fixture/'+repo})`;
  for(const [id,owner]of [[serve,user],[otherServe,user],[foreignServe,foreign]]){
   await admin`INSERT INTO telemetry.feed_serves(serve_id,feed_request_id,user_id,session_id,feed_version,source,created_at)
    VALUES(${id}::uuid,${crypto.randomUUID()}::uuid,${owner}::uuid,${session}::uuid,1,'fixture',now()-interval '1 minute')`;
   await admin`INSERT INTO telemetry.feed_serve_items(serve_id,position,repo_id,score,source) VALUES(${id}::uuid,0,${repo}::uuid,0.3,'semantic')`;
  }
  await admin.unsafe(`CREATE ROLE ${exportRole} LOGIN IN ROLE ghsocial_scoring_exporter`);roleCreated=true;
  const exportUrl=new URL(process.env.DATABASE_URL!);exportUrl.username=exportRole;exportUrl.password='';process.env.SCORING_EXPORT_DATABASE_URL=exportUrl.toString();exporter=postgres(exportUrl.toString(),{max:1,prepare:false});
  for(const version of ['scoring-labels-v1','scoring-labels-v2']as const)await admin`INSERT INTO private_scoring.export_authorizations(principal_id,policy_digest,scope,subject_ids,expires_at)
   VALUES(${user}::uuid,${scoringExportPolicyDigest({...policy,labelerVersion:version})},'owner',ARRAY[${user}::uuid],now()+interval '1 hour')`;
  const [{default:app},{getApplicationRuntime},{default:redis},{sqlClient}]=await Promise.all([import('../../app.js'),import('../../runtime/applicationRuntime.js'),import('../../config/redis.js'),import('../../db/index.js')]);
  closeRuntime=()=>getApplicationRuntime().supervisor.stop();disconnect=()=>redis.disconnect();closeSql=()=>sqlClient.end({timeout:1});
  server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server!.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
  const post=(owner:string,events:unknown[])=>fetch(origin+'/api/v2/interactions/batch',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+jwt.sign({userId:owner,email:'fixture@example.invalid'},process.env.JWT_SECRET!)},body:JSON.stringify({events}),signal:AbortSignal.timeout(5000)});
  const event=(event_type:string,fields:Record<string,unknown>={})=>({event_id:crypto.randomUUID(),schema_version:2,session_id:session,serve_id:serve,repo_id:repo,position:0,event_type,dwell_ms:null,client_occurred_at:new Date(Date.now()-1000).toISOString(),context:{},...fields});
  const authHeaders={authorization:'Bearer '+jwt.sign({userId:user,email:'fixture@example.invalid'},process.env.JWT_SECRET!),'content-type':'application/json'};
  const selection=()=>({subject_user_id:user,served_from:new Date(Date.now()-3600000).toISOString(),served_to:new Date().toISOString()});
  const createExport=async()=>{const response=await fetch(origin+'/api/v2/scoring-exports',{method:'POST',headers:authHeaders,body:JSON.stringify(selection())});assert.equal(response.status,201,await response.clone().text());return await response.json()as ScoringExportManifest;};
  const readExport=async(job:string)=>{const response=await fetch(origin+'/api/v2/scoring-exports/'+job,{headers:authHeaders});assert.equal(response.status,200,await response.clone().text());return await response.json()as ScoringExportPage;};
  const actionTime=Date.now()-1000;
  const action=event('share',{impression_event_id:original,client_occurred_at:new Date(actionTime).toISOString()});
  const accepted=await post(user,[action]);assert.equal(accepted.status,202,await accepted.clone().text());
  assert.equal((await admin`SELECT impression_event_id FROM telemetry.interaction_events WHERE event_id=${action.event_id}::uuid`)[0].impression_event_id,original);
  const retry=await post(user,[action]);assert.equal(retry.status,202);assert.equal((await retry.json()as{duplicates:number}).duplicates,1);
  assert.equal((await post(user,[{...action,impression_event_id:crypto.randomUUID()}])).status,409);
  assert.equal(Number((await admin`SELECT shares FROM telemetry.user_repo_engagement WHERE user_id=${user}::uuid AND repo_id=${repo}::uuid`)[0].shares),1);
  const pendingJob=await createExport(),pendingPage=await readExport(pendingJob.job_id);
  const pendingRow=pendingPage.rows.find(row=>row.exposure.serve_id===serve)!;
  assert.equal(pendingRow.labels.impression_links!.find(link=>link.event_id===action.event_id)!.status,'unresolved_at_cutoff');
  const v1=new PostgresScoringExport(exporter!,{...policy,labelerVersion:'scoring-labels-v1'});
  const v1Job=await v1.create(user,{subjectUserId:user,servedFrom:selection().served_from,servedTo:selection().served_to}),v1Page=await v1.page(user,v1Job.job_id,0,50);
  const impression=event('impression',{event_id:original,client_occurred_at:new Date(actionTime-1000).toISOString()});
  assert.equal((await post(user,[impression])).status,202,'a late genuinely qualified impression is accepted independently');
  assert.deepEqual(await readExport(pendingJob.job_id),pendingPage,'late target arrival cannot relabel an old v2 snapshot');
  const resolvedJob=await createExport(),resolvedPage=await readExport(resolvedJob.job_id);
  assert.equal(resolvedPage.rows.find(row=>row.exposure.serve_id===serve)!.labels.impression_links!.find(link=>link.event_id===action.event_id)!.status,'resolved_exact');
  assert.deepEqual(await readExport(v1Job.job_id),v1Page,'the same approved v1 policy remains readable without a digest or metadata rewrite');
  const linkedLike=event('like',{impression_event_id:original});assert.equal((await post(user,[linkedLike])).status,202);
  assert.equal((await post(user,[linkedLike])).status,202);
  const foreignImpression=event('impression',{serve_id:foreignServe});assert.equal((await post(foreign,[foreignImpression])).status,202);
  const unknown=event('github_open',{impression_event_id:crypto.randomUUID()}),foreignReference=event('github_open',{impression_event_id:foreignImpression.event_id});
  assert.equal((await post(user,[unknown])).status,202);assert.equal((await post(user,[foreignReference])).status,202,'acceptance does not disclose target ownership');
  const wrongTuple=event('impression',{serve_id:otherServe});assert.equal((await post(user,[wrongTuple])).status,202);
  assert.equal((await post(user,[event('readme_open',{impression_event_id:wrongTuple.event_id})])).status,202);
  const sameBatchImpression=event('impression'),sameBatchAction=event('share',{impression_event_id:sameBatchImpression.event_id});
  assert.equal((await post(user,[sameBatchAction,sameBatchImpression])).status,202,'UUID insert order does not require its target first');
  const mixedJob=await createExport(),mixed=await readExport(mixedJob.job_id);
  const links=mixed.rows.find(row=>row.exposure.serve_id===serve)!.labels.impression_links!;
  assert.equal(links.find(link=>link.event_id===unknown.event_id)!.status,'unresolved_at_cutoff');
  assert.equal(links.find(link=>link.event_id===foreignReference.event_id)!.status,'unresolved_at_cutoff','foreign ownership is indistinguishable from missing at the cutoff');
  assert.ok(links.some(link=>link.status==='invalid_attribution'),'a known own wrong tuple is retained as invalid instead of a guessed match');
  const legacy=event('share');assert.equal((await post(user,[legacy])).status,202);const legacyRetry=await post(user,[legacy]);assert.equal(legacyRetry.status,202);assert.equal((await legacyRetry.json()as{duplicates:number}).duplicates,1);
  assert.equal((await admin`SELECT impression_event_id FROM telemetry.interaction_events WHERE event_id=${legacy.event_id}::uuid`)[0].impression_event_id,null);
 }finally{
  if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
  await closeRuntime?.();disconnect?.();await closeSql?.();await exporter?.end({timeout:1});
  if(seeded){await admin`DELETE FROM telemetry.interaction_events WHERE user_id=ANY(${[user,foreign]}::uuid[])`;await admin`DELETE FROM auth.users WHERE id=ANY(${[user,foreign]}::uuid[])`;await admin`DELETE FROM app.repos WHERE repo_id=${repo}::uuid`;}
  if(roleCreated)await admin.unsafe(`DROP ROLE ${exportRole}`);await admin.end({timeout:1});
 }
});
