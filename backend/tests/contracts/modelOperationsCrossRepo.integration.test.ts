import type {FeedResponseV2} from '../../contracts/feed.v2.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import test from 'node:test';
import jwt from 'jsonwebtoken';
const enabled=process.env.RUN_MODEL_OPERATION_CROSS_REPO==='1';
const integration=enabled?test:test.skip;
integration('registered product SQL/HTTP reaches actual ordered ML, captured ranking and scoped durable serving', {timeout:180000},async()=>{
 const {assertDisposableDatabase}=await import('../database/disposableDatabase.js');assertDisposableDatabase();
 const receipt=JSON.parse(await readFile(process.env.MODEL_PAIR_RECEIPT!,'utf8')) as {
  api_url:string;internal_secret:string;scoring_capture_capability:string;policy_sha256:string;corpus_repo_ids:string[];source_commit:string;
 };
 const registration=JSON.parse(await readFile(process.env.MODEL_PAIR_POLICY!,'utf8')) as {limits:Record<string,number|string>};
 assert.ok(receipt.api_url.startsWith('http://127.0.0.1:'));assert.ok(receipt.corpus_repo_ids.length>=10);
 const owners=[crypto.randomUUID(),crypto.randomUUID()];const writerRole='model_capture_'+crypto.randomBytes(5).toString('hex');
 const writerUrl=new URL(process.env.DATABASE_URL!);writerUrl.username=writerRole;writerUrl.password='model35_fixture';
 Object.assign(process.env,{ML_SERVICE_URL:receipt.api_url,INTERNAL_API_SECRET:receipt.internal_secret,
  ML_GENERATION_TIMEOUT_MS:'30000',ML_DELIVERY_TIMEOUT_MS:'30000',FEED_FOREGROUND_WAIT_MS:'30000',FEED_REFILL_INDEX_READY:'true',
  REDIS_URL:process.env.REDIS_TEST_URL!,TRENDING_INGESTION:'false',SCORING_CAPTURE_ENABLED:'true',SCORING_CAPTURE_POLICY_ID:'model35-paired',
  SCORING_CAPTURE_POLICY_VERSION:'fixture-v1',SCORING_CAPTURE_RETENTION_DAYS:'1',SCORING_CAPTURE_USER_IDS:owners.join(','),
  SCORING_CAPTURE_DATABASE_URL:writerUrl.toString(),SCORING_CAPTURE_CAPABILITY:receipt.scoring_capture_capability,
  JWT_SECRET:'model35-owned-fixture-jwt-secret'});
 const {sqlClient:sql}=await import('../../db/index.js');
 await sql.unsafe(`CREATE ROLE ${writerRole} LOGIN PASSWORD 'model35_fixture' IN ROLE ghsocial_scoring_writer`);
 const [{default:app},{getApplicationRuntime,ApplicationRuntime},{default:redis},{OutboxWorker}]=await Promise.all([
  import('../../app.js'),import('../../runtime/applicationRuntime.js'),import('../../config/redis.js'),import('../../workers/outboxWorker.js')]);
 const runtime=getApplicationRuntime();assert.ok(runtime.ml&&runtime.orderedProfiles);
 const worker=new OutboxWorker(runtime.outbox,runtime.ml);
 let providerReads=0;
 const readAuthority=runtime.ml.modelAuthority.bind(runtime.ml),readStatus=runtime.ml.modelOperationStatus.bind(runtime.ml);
 runtime.ml.modelAuthority=async input=>{providerReads++;return readAuthority(input);};
 runtime.ml.modelOperationStatus=async input=>{providerReads++;return readStatus(input);};
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 const address=server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
 const tokens=owners.map(userId=>jwt.sign({userId,email:'fixture@example.test'},process.env.JWT_SECRET!,{expiresIn:'10m'}));
 async function call<T=Record<string,unknown>>(owner:number,path:string,body?:object){
  const response=await fetch(origin+'/api/v2'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+tokens[owner],'content-type':'application/json'},
   ...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json() as T};
 }
 async function until<T>(operation:()=>Promise<T>,accept:(result:T)=>boolean):Promise<T>{
  const deadline=Date.now()+75000;let latest:T;
  do{latest=await operation();if(accept(latest))return latest;await new Promise(resolve=>setTimeout(resolve,150));}while(Date.now()<deadline);
  throw new Error('Owned paired operation did not reach required applied state.');
 }
 async function deliver(){for(let i=0;i<50;i++){const [row]=await runtime.outbox.claim(1,undefined,{jobTypes:['model_operation']});if(!row)return;const result=await worker.deliverClaimed(row);assert.equal(result.accepted,true,'actual ML must durably accept exact SQL source');}}
 const sessions=owners.map(()=>[crypto.randomUUID(),crypto.randomUUID()]);
 try{
  await sql`INSERT INTO auth.users(id) SELECT unnest(${owners}::uuid[])`;
  await sql`INSERT INTO app.users(user_id,username,full_name,date_of_birth,bio,interests,skills,tech_stack,onboarding_completed,status)
   SELECT id,'paired_'||replace(id::text,'-',''),'Tarun','2000-01-01','Rust and backend systems','["systems"]'::jsonb,'["rust"]'::jsonb,'["rust"]'::jsonb,true,'active' FROM unnest(${owners}::uuid[]) AS id`;
  await sql`INSERT INTO app.user_stats(user_id) SELECT unnest(${owners}::uuid[])`;
  await sql`INSERT INTO app.user_feed_state(user_id,model_policy_sha256,model_policy_limits)
   SELECT id,${receipt.policy_sha256},${JSON.stringify(registration.limits)}::jsonb FROM unnest(${owners}::uuid[]) AS id`;
  await sql`INSERT INTO app.repos(repo_id,github_id,full_name,owner,name,url,status)
   SELECT id,${Date.now()*100}::bigint+position,'fixture/'||id,'fixture',id::text,'https://github.com/fixture/'||id,'active'
   FROM unnest(${receipt.corpus_repo_ids}::uuid[]) WITH ORDINALITY AS source(id,position) ON CONFLICT(repo_id) DO NOTHING`;
  const preinit={event_id:crypto.randomUUID(),schema_version:2,session_id:crypto.randomUUID(),serve_id:null,repo_id:receipt.corpus_repo_ids[0],position:null,
   event_type:'like',dwell_ms:null,client_occurred_at:'2026-10-20T12:00:00.000Z',context:{}};
  assert.equal((await call(0,'/interactions/batch',{schema_version:2,events:[preinit]})).status,202);
  assert.equal((await sql`SELECT 1 FROM telemetry.pending_model_feedback WHERE user_id=${owners[0]}::uuid AND operation_id IS NULL`).length,1);
  // Begin enqueues the real current profile but must not infer application from acceptance.
  for(let owner=0;owner<2;owner++)assert.equal((await call(owner,'/feed-sessions',{kind:'begin',request_id:crypto.randomUUID(),session_id:sessions[owner][0]})).status,409);
  await deliver();
  for(let owner=0;owner<2;owner++)await until(()=>runtime.orderedProfiles!.ensureProfileReady(owners[owner]).then(()=>true).catch(()=>false),value=>value);
  for(let owner=0;owner<2;owner++)for(const session of sessions[owner]){
   assert.equal((await call(owner,'/feed-sessions',{kind:'begin',request_id:crypto.randomUUID(),session_id:session})).status,200);
  }
  await deliver();
  const request={feed_request_id:crypto.randomUUID(),session_id:sessions[0][0],limit:2,cursor:null};
  const first=await until(()=>call<FeedResponseV2>(0,'/feed',request),response=>response.status===200);
  assert.equal(first.body.items.length,2);assert.ok(first.body.next_cursor);
  const replica=new ApplicationRuntime();
  let replicaPage:FeedResponseV2;
  try{replicaPage=await replica.feed.getFeed(owners[0],{...request,feed_request_id:crypto.randomUUID(),cursor:first.body.next_cursor});}
  finally{await replica.supervisor.stop();}
  const second={status:200,body:replicaPage!};
  assert.equal(second.status,200);assert.equal(new Set([...first.body.items,...second.body.items].map(item=>item.repo_id)).size,4);
  const parts=first.body.next_cursor!.split('.');
  const badSignature=parts[0]+'.'+(parts[1][0]==='a'?'b':'a')+parts[1].slice(1);
  for(const [owner,session,cursor] of [[owners[0],sessions[0][0],badSignature],[owners[0],sessions[0][1],first.body.next_cursor!],[owners[1],sessions[1][0],first.body.next_cursor!]] as const){
   const before=providerReads;
   await assert.rejects(runtime.feed.getFeed(owner,{...request,feed_request_id:crypto.randomUUID(),session_id:session,cursor}),/cursor/i);
   assert.equal(providerReads,before,'invalid MAC/foreign scope must fail before provider reads');
  }
  await sql`UPDATE telemetry.feed_model_generations SET valid_until_ms=1 WHERE generation_id=ANY(${[...new Set(first.body.items.map(item=>item.generation_id!))]}::uuid[])`;
  const beforeExpiry=providerReads;
  await assert.rejects(runtime.feed.getFeed(owners[0],{...request,feed_request_id:crypto.randomUUID(),cursor:first.body.next_cursor}),/cursor/i);
  assert.equal(providerReads,beforeExpiry,'expired generation must fail before provider reads');
  const otherDevice=await call<FeedResponseV2>(0,'/feed',{...request,feed_request_id:crypto.randomUUID(),session_id:sessions[0][1]});assert.equal(otherDevice.status,200);
  const otherUser=await until(()=>call<FeedResponseV2>(1,'/feed',{...request,feed_request_id:crypto.randomUUID(),session_id:sessions[1][0]}),response=>response.status===200);assert.equal(otherUser.body.session_id,sessions[1][0]);
  const dwell={...preinit,event_id:crypto.randomUUID(),serve_id:otherDevice.body.serve_id,repo_id:otherDevice.body.items[0].repo_id,
    position:otherDevice.body.items[0].position,event_type:'dwell',dwell_ms:4000};
  assert.equal((await call(0,'/interactions/batch',{schema_version:2,events:[dwell]})).status,202);
  const [unchangedFeed]=await sql`SELECT feed_version FROM app.user_feed_state WHERE user_id=${owners[0]}::uuid`;
  assert.equal(String(unchangedFeed.feed_version),otherDevice.body.feed_version,'dwell changes model order without changing feed version');
  const beforeDwellCursor=providerReads;
  await assert.rejects(runtime.feed.getFeed(owners[0],{...request,session_id:sessions[0][1],feed_request_id:crypto.randomUUID(),cursor:otherDevice.body.next_cursor}),/cursor/i);
  assert.equal(providerReads,beforeDwellCursor,'changed model frontier must restart the old cursor before provider reads');
  await deliver();
  const [captured]=await sql`SELECT count(*)::int AS count FROM private_scoring.scoring_inputs WHERE user_id=${owners[0]}::uuid AND octet_length(input_bytes)=3112`;
  assert.ok(captured.count>=4,'actual trained 778-value inputs must persist before serve');
  const [stamp]=await sql`SELECT intent_epoch,intent_epoch_witness_sha256 FROM telemetry.feed_serves WHERE serve_id=${first.body.serve_id}::uuid`;
  assert.equal(String(stamp.intent_epoch),'1');assert.match(stamp.intent_epoch_witness_sha256,/^[a-f0-9]{64}$/);
  const reset=await call(0,'/feed-sessions',{kind:'reset',request_id:crypto.randomUUID(),session_id:sessions[0][0],expected_epoch:'1'});assert.equal(reset.status,200);
  const beforeResetCursor=providerReads;
  await assert.rejects(runtime.feed.getFeed(owners[0],{...request,feed_request_id:crypto.randomUUID(),cursor:first.body.next_cursor}),/cursor/i);
  assert.equal(providerReads,beforeResetCursor,'changed epoch/frontier must fail before provider reads');
  const replay=await call<FeedResponseV2>(0,'/feed',request);assert.equal(replay.status,200);assert.equal(replay.body.serve_id,first.body.serve_id);
  const identity=(body:FeedResponseV2)=>body.items.map(item=>[item.repo_id,item.position,item.generation_id,item.exposure_id]);
  assert.deepEqual(identity(replay.body),identity(first.body));
  const late={...preinit,event_id:crypto.randomUUID(),session_id:crypto.randomUUID(),serve_id:first.body.serve_id,repo_id:first.body.items[0].repo_id,position:first.body.items[0].position,event_type:'dislike'};
  assert.equal((await call(0,'/interactions/batch',{schema_version:2,events:[late]})).status,202);
  const [lateSource]=await sql`SELECT operation_json FROM telemetry.ml_outbox WHERE idempotency_key=${`model:${owners[0]}:feedback:${late.event_id}`}`;
  const attribution=JSON.parse(lateSource.operation_json).operation.canonical_attribution;
  assert.equal(attribution.session_id,sessions[0][0]);assert.equal(attribution.epoch,'1');assert.equal(attribution.active_at_acceptance,false);assert.equal(attribution.witness_sha256,stamp.intent_epoch_witness_sha256);
  await deliver();
  const after=await until(()=>call<FeedResponseV2>(0,'/feed',{...request,feed_request_id:crypto.randomUUID()}),response=>response.status===200);
  assert.ok(after.body.items.every(item=>item.repo_id!==late.repo_id));
  const ended=await call(0,'/feed-sessions',{kind:'end',request_id:crypto.randomUUID(),session_id:sessions[0][0],expected_epoch:'2'});assert.equal(ended.status,200);
  const beforeEndCursor=providerReads;
  const retiredCursor=await call(0,'/feed',{...request,feed_request_id:crypto.randomUUID(),cursor:after.body.next_cursor});
  assert.equal(retiredCursor.status,400);assert.equal(retiredCursor.body.code,'FEED_CURSOR_STALE');assert.equal(providerReads,beforeEndCursor);
  assert.equal((await call<FeedResponseV2>(0,'/feed',request)).body.serve_id,first.body.serve_id);
  assert.equal((await call(0,'/feed-sessions',{kind:'begin',request_id:crypto.randomUUID(),session_id:sessions[0][0]})).status,409);
  if(process.env.MODEL_PAIR_OUTPUT)await writeFile(process.env.MODEL_PAIR_OUTPUT,JSON.stringify({owners,tokens,writerUrl:writerUrl.toString(),
    provider:receipt.source_commit,ml:receipt.api_url,secret:receipt.internal_secret,capability:receipt.scoring_capture_capability},null,2),{mode:0o600});
  console.log(JSON.stringify({provider:receipt.source_commit,users:2,canonicalSessions:4,productPreinitFeedback:true,
   actualCaptured778:true,scopedPages:4,replicaContinuation:true,cursorAdmissionBeforeProvider:true,dwellSameVersionRestart:true,retiredCursorRestart:true,lateEpochInactive:true,resetEndReplay:true}));
 }finally{
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await runtime.supervisor.stop();redis.disconnect();
  // Frozen capture/provenance stays inside this explicitly owned disposable target.
  await sql.end({timeout:1});
 }
});
