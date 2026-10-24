import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import test from 'node:test';
import postgres from 'postgres';
import express from 'express';
import jwt from 'jsonwebtoken';
import {PostgresScoringExport,ScoringExportError} from '../../adapters/postgresScoringExport.js';
import {scoringExportPolicyDigest,scoringExportPolicyJson} from '../../config/scoringExport.js';
import type {ScoringExportPolicy} from '../../contracts/scoringExport.js';
import {PostgresScoringRetention} from '../../workers/scoringRetentionWorker.js';
import {createScoringExportRouter} from '../../routes/scoringExportRoutes.js';

const run=promisify(execFile);
const enabled=process.env.RUN_SCORING_EXPORT_OWNED==='1';
const integration=enabled?test:test.skip;
const policy:ScoringExportPolicy={policyId:'owned-fixture-only',policyVersion:'1',snapshotTtlSeconds:600,labelHorizonSeconds:10,lateArrivalSeconds:5,clockSkewSeconds:0,labelerVersion:'scoring-labels-v1'};
const image='postgres@sha256:fe0737ba566a2c5b2a28f34433c0a423261900ec17b9bf7ad115e1aae7e57f1b';
const hash=(value:crypto.BinaryLike)=>crypto.createHash('sha256').update(value).digest('hex');
const canonical=(value:Record<string,unknown>)=>JSON.stringify(value,Object.keys(value).sort());

integration('owned real PostgreSQL export: roles, frozen cutoff, exact inputs, HTTP, fencing and retention', {timeout:120_000},async()=>{
  const suffix=crypto.randomBytes(8).toString('hex'),name=`weave-export26-${suffix}`;
  const dockerEnvironment={...process.env};
  if(dockerEnvironment.DOCKER_HOST&&!dockerEnvironment.DOCKER_HOST.startsWith('unix://'))throw new Error('OWNED_FIXTURE_REQUIRES_LOCAL_DOCKER');
  for(const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete dockerEnvironment[key];
  const socket=process.env.SCORING_EXPORT_DOCKER_SOCKET??'/var/run/docker.sock';
  if(!socket.startsWith('/')||socket.includes('\0'))throw new Error('OWNED_FIXTURE_REQUIRES_LOCAL_DOCKER');
  const docker=(...args:string[])=>run('docker',['--host',`unix://${socket}`,...args],{env:dockerEnvironment,timeout:15_000,maxBuffer:2_000_000});
  let admin:ReturnType<typeof postgres>|undefined,exporter:ReturnType<typeof postgres>|undefined,retention:ReturnType<typeof postgres>|undefined,product:ReturnType<typeof postgres>|undefined;
  let created=false,server:ReturnType<express.Application['listen']>|undefined;
  let releasePending:(()=>void)|undefined,releaseReadLock:(()=>void)|undefined;
  const password=crypto.randomBytes(24).toString('hex');
  try {
    // No pull, arbitrary target URL, persisted volume, host network or shared DB.
    await docker('image','inspect',image);
    await docker('run','--detach','--pull=never','--name',name,'--label',`weave.export26.owner=${suffix}`,
      '--memory','512m','--cpus','1','--pids-limit','128','--publish','127.0.0.1::5432',
      '--env',`POSTGRES_PASSWORD=${password}`,'--env','POSTGRES_DB=weave_export_owned',image);
    created=true;
    const inspected=JSON.parse((await docker('inspect',name)).stdout)[0];
    assert.equal(inspected.Config.Labels['weave.export26.owner'],suffix);
    const port=Number(inspected.NetworkSettings.Ports['5432/tcp'][0].HostPort);assert.notEqual(port,55448);
    const base=new URL(`postgres://postgres:${password}@127.0.0.1:${port}/weave_export_owned`);
    for(let attempt=0;;attempt++) {
      try{await docker('exec',name,'pg_isready','-h','127.0.0.1','-U','postgres','-d','weave_export_owned');break;}
      catch(error){if(attempt>=150)throw error;await new Promise(resolve=>setTimeout(resolve,100));}
    }
    admin=postgres(base.toString(),{max:4,prepare:false,connection:{statement_timeout:5000,lock_timeout:1000}});
    // Minimal product fixture schema; FULL actual 0042/0043/0044 run unchanged.
    // This is not a full production migration-chain or main-app integration claim.
    await admin.unsafe(`CREATE ROLE ghsocial_backend NOLOGIN; CREATE SCHEMA app; CREATE SCHEMA telemetry;
      CREATE TABLE app.users(user_id uuid PRIMARY KEY); CREATE TABLE app.repos(repo_id uuid PRIMARY KEY);
      CREATE TABLE telemetry.feed_serves(serve_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES app.users,
        session_id uuid NOT NULL,feed_version bigint NOT NULL,generation_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE TABLE telemetry.feed_serve_items(serve_id uuid REFERENCES telemetry.feed_serves,position smallint,repo_id uuid REFERENCES app.repos,
        score double precision,source text,model_version text,PRIMARY KEY(serve_id,position));
      CREATE TABLE telemetry.interaction_events(event_id uuid PRIMARY KEY,user_id uuid REFERENCES app.users,session_id uuid,serve_id uuid REFERENCES telemetry.feed_serves,
        repo_id uuid REFERENCES app.repos,position smallint,event_type text,dwell_ms integer,feedback_version bigint,
        client_occurred_at timestamptz,server_received_at timestamptz DEFAULT clock_timestamp(),context jsonb DEFAULT '{}');
      CREATE INDEX event_tuple_idx ON telemetry.interaction_events(user_id,serve_id,repo_id,position);
      GRANT USAGE ON SCHEMA app,telemetry TO ghsocial_backend; GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA app,telemetry TO ghsocial_backend;`);
    const dependencies=process.env.SCORING_EXPORT_FIXTURE_DEPENDENCIES
      ?pathToFileURL(process.env.SCORING_EXPORT_FIXTURE_DEPENDENCIES.replace(/\/$/,'')+'/')
      :new URL('../../../database/migrations/',import.meta.url);
    for(const filename of ['0042_private_scoring_provenance.sql','0043_feed_item_provenance.sql'])await admin.unsafe(await readFile(new URL(filename,dependencies),'utf8'));
    await admin.unsafe(await readFile(new URL('../../../database/migrations/0044_private_scoring_exports.sql',import.meta.url),'utf8'));
    await admin.unsafe(`CREATE ROLE export_fixture LOGIN PASSWORD '${password}' IN ROLE ghsocial_scoring_exporter;
      CREATE ROLE retention_fixture LOGIN PASSWORD '${password}' IN ROLE ghsocial_scoring_retention;
      CREATE ROLE product_fixture LOGIN PASSWORD '${password}' IN ROLE ghsocial_backend;`);
    const connection=(username:string)=>{const value=new URL(base);value.username=username;return postgres(value.toString(),{max:3,prepare:false,connection:{statement_timeout:5000,lock_timeout:4000}});};
    exporter=connection('export_fixture');retention=connection('retention_fixture');product=connection('product_fixture');
    const principal=crypto.randomUUID(),peer=crypto.randomUUID(),repo=crypto.randomUUID();
    await admin`INSERT INTO app.users(user_id) VALUES(${principal}::uuid),(${peer}::uuid)`;
    await admin`INSERT INTO app.repos(repo_id) VALUES(${repo}::uuid)`;
    const portAdapter=new PostgresScoringExport(exporter,policy);
    const from=new Date(Date.now()-3600_000).toISOString(),to=new Date(Date.now()-1000).toISOString();
    const selection={subjectUserId:principal,servedFrom:from,servedTo:to};
    for(const sql of [exporter,retention,product]) {
      await assert.rejects(sql`SELECT input_bytes FROM private_scoring.scoring_inputs`,{code:'42501'});
      await assert.rejects(sql`SELECT * FROM private_scoring.export_authorizations`,{code:'42501'});
    }
    await assert.rejects(new PostgresScoringExport(admin,policy).create(principal,selection),(error:unknown)=>error instanceof ScoringExportError&&error.reason==='permission');
    await assert.rejects(new PostgresScoringExport(retention,policy).create(principal,selection),(error:unknown)=>error instanceof ScoringExportError&&error.reason==='permission');
    await assert.rejects(new PostgresScoringRetention(exporter,1).purgeOnce(),/SCORING_RETENTION_UNAVAILABLE/);
    await assert.rejects(portAdapter.create(principal,selection),(error:unknown)=>error instanceof ScoringExportError&&error.reason==='forbidden');
    await admin`INSERT INTO private_scoring.export_authorizations(principal_id,policy_digest,scope,subject_ids,expires_at)
      VALUES(${principal}::uuid,${scoringExportPolicyDigest(policy)},'owner',ARRAY[${principal}::uuid],clock_timestamp()+interval '1 hour')`;
    await assert.rejects(exporter`INSERT INTO private_scoring.export_authorizations VALUES(${peer}::uuid,${scoringExportPolicyDigest(policy)},'admin',ARRAY[${principal}::uuid],now()+interval '1 hour',false)`,{code:'42501'});
    await assert.rejects(portAdapter.create(principal,{...selection,subjectUserId:peer}),(error:unknown)=>error instanceof ScoringExportError&&error.reason==='forbidden');
    await admin`GRANT SELECT ON private_scoring.scoring_inputs TO export_fixture`;
    await assert.rejects(portAdapter.create(principal,selection),(error:unknown)=>error instanceof ScoringExportError&&error.reason==='permission');
    await admin`REVOKE SELECT ON private_scoring.scoring_inputs FROM export_fixture`;
    const goldenPath=process.env.SCORING_EXPORT_FIXTURE_GOLDEN??fileURLToPath(new URL('../fixtures/scoring-capture-v1.json',import.meta.url));
    const artifact=JSON.parse(await readFile(goldenPath,'utf8'));
    const golden=artifact.scoring_context?{context:artifact.scoring_context,packet:artifact.items[0].scored_input}:artifact;
    function payload(generation:string){
      const context={...golden.context,user_id:principal,generation_id:generation};
      const snapshot={...golden.packet.snapshot,repo_id:repo};
      const contextJson=canonical(context),snapshotJson=canonical(snapshot),bytes=Buffer.from(golden.packet.input_base64,'base64');
      const stageJson=canonical({provider_position:0,raw_heavy_score:0.25,final_score:0.3,source:'semantic',retrieval_scores:{}});
      return JSON.stringify({schema_version:1,context_json:contextJson,context_digest:hash(contextJson),policy_id:'fixture',policy_version:'1',retention_days:30,
        items:[{snapshot_json:snapshotJson,input_base64:bytes.toString('base64'),binding_sha256:hash(Buffer.concat([Buffer.from('{"context":'+contextJson+',"snapshot":'+snapshotJson+'}'),bytes])),
          stage_json:stageJson,record_digest:hash(Buffer.concat([Buffer.from(contextJson),Buffer.from(snapshotJson),bytes,Buffer.from(stageJson)]))}]});
    }
    const generations=[crypto.randomUUID(),crypto.randomUUID()];
    const persisted=[];for(const generation of generations)persisted.push((await admin`SELECT private_scoring.persist_generation(${payload(generation)}) AS result`)[0].result);
    const servedAt=new Date(Date.now()-60_000).toISOString(),session=crypto.randomUUID();
    const [header]=await admin`INSERT INTO telemetry.feed_serves(user_id,session_id,feed_version,created_at)
      VALUES(${principal}::uuid,${session}::uuid,${golden.context.feed_version}::bigint,${servedAt}) RETURNING serve_id`;
    for(let index=0;index<4;index++) {
      await admin`INSERT INTO telemetry.feed_serve_items VALUES(${header.serve_id}::uuid,${index},${repo}::uuid,0.3,'semantic',${golden.context.model_version})`;
      if(index<2)await product`INSERT INTO telemetry.feed_item_provenance(serve_id,position,user_id,repo_id,generation_id,record_digest,capture_status)
        VALUES(${header.serve_id}::uuid,${index},${principal}::uuid,${repo}::uuid,${generations[index]}::uuid,${persisted[index].references[0].record_digest},'captured')`;
      else if(index===2)await product`INSERT INTO telemetry.feed_item_provenance(serve_id,position,user_id,repo_id,capture_status)
        VALUES(${header.serve_id}::uuid,${index},${principal}::uuid,${repo}::uuid,'not_captured')`;
    }
    await admin`UPDATE telemetry.feed_serves SET generation_id=${generations[0]}::uuid WHERE serve_id=${header.serve_id}::uuid`;
    const impression=crypto.randomUUID(),like=crypto.randomUUID();
    const addEvent=async(eventId:string,type:string,position=0,eventSession=session)=>admin!`INSERT INTO telemetry.interaction_events(event_id,user_id,session_id,serve_id,repo_id,position,event_type,client_occurred_at,server_received_at)
      VALUES(${eventId}::uuid,${principal}::uuid,${eventSession}::uuid,${header.serve_id}::uuid,${repo}::uuid,${position},${type},${new Date(Date.parse(servedAt)+1000).toISOString()},clock_timestamp())`;
    await addEvent(impression,'impression');
    const mismatchedSession=crypto.randomUUID();await addEvent(crypto.randomUUID(),'like',2,mismatchedSession);
    let pendingReady!:()=>void;const pendingStarted=new Promise<void>(resolve=>pendingReady=resolve);
    const pendingContinue=new Promise<void>(resolve=>releasePending=resolve);
    const pendingLike=admin.begin(async tx=>{
      await tx`INSERT INTO telemetry.interaction_events(event_id,user_id,session_id,serve_id,repo_id,position,event_type,client_occurred_at,server_received_at)
        VALUES(${like}::uuid,${principal}::uuid,${session}::uuid,${header.serve_id}::uuid,${repo}::uuid,0,'like',${new Date(Date.parse(servedAt)+1000).toISOString()},clock_timestamp())`;
      pendingReady();await pendingContinue;
    });
    await pendingStarted;
    const first=await portAdapter.create(principal,selection),initial=await portAdapter.page(principal,first.job_id,0,100);
    await assert.rejects(admin`UPDATE private_scoring.export_snapshot_labels SET labels=labels WHERE job_id=${first.job_id}::uuid`,{message:'SCORING_IMMUTABLE'});
    await assert.rejects(exporter.begin('isolation level repeatable read',tx=>tx`SELECT private_scoring.seal_export_labels(${principal}::uuid,
      ${first.job_id}::uuid,${scoringExportPolicyDigest(policy)},'[]')`),{message:'SCORING_EXPORT_INVALID'},'only the creating RR xid8 may seal labels');
    assert.equal(initial.rows.length,4);assert.deepEqual(initial.rows.map(row=>row.exposure.source_status),['captured','captured','not_captured','legacy_unknown']);
    assert.equal(initial.rows[0].labels.outcome_status,'no_action_observed_by_cutoff');assert.equal(initial.rows[1].labels.outcome_status,'unobserved');
    assert.equal(initial.rows[0].input!.input_base64,golden.packet.input_base64);
    assert.notEqual(initial.rows[0].exposure.generation_id,initial.rows[1].exposure.generation_id);
    assert.equal(initial.rows[0].labels.original_client_impression_linkage,'not_recorded');
    assert.equal(initial.rows[2].exposure.events[0].raw_session_id,mismatchedSession);
    assert.equal(initial.rows[2].exposure.events[0].session_attribution,'differs_from_serve');
    assert.equal(initial.rows[2].labels.outcome_status,'attribution_uncertain');assert.equal(initial.rows[2].labels.action_counts.like,0);
    assert.equal(initial.rows[3].exposure.generation_id,null);
    assert.equal(initial.rows[3].exposure.legacy_generation_hint,generations[0]);
    assert.equal(initial.rows[1].exposure.legacy_generation_hint,null,'a legacy page hint cannot replace a captured item generation');
    releasePending!();await pendingLike;
    assert.deepEqual(await portAdapter.page(principal,first.job_id,0,100),initial,'later commits do not mutate a frozen snapshot');
    const fresh=await portAdapter.create(principal,selection),freshPage=await portAdapter.page(principal,fresh.job_id,0,1);
    assert.equal(freshPage.rows[0].labels.outcome_status,'positive_observed');assert.equal(freshPage.next_after,1);
    assert.equal((await portAdapter.page(principal,fresh.job_id,1,1)).rows[0].exposure.generation_id,generations[1]);
    await assert.rejects(portAdapter.page(peer,first.job_id,0,1),(error:unknown)=>error instanceof ScoringExportError&&error.reason==='forbidden');
    // Real requireAuth from the existing application, injected at its normal seam.
    const authPath=process.env.SCORING_EXPORT_AUTH_MODULE??fileURLToPath(new URL('../../middlewares/authMiddleware.js',import.meta.url));
    process.env.JWT_SECRET='owned-fixture-signing-key-not-a-real-credential';
    const {requireAuth}=await import(pathToFileURL(authPath).href);
    const app=express();app.use(createScoringExportRouter(portAdapter,requireAuth));
    server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server!.once('listening',resolve));
    const address=server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
    const token=jwt.sign({userId:principal,email:'fixture@example.invalid'},process.env.JWT_SECRET,{expiresIn:60});
    const headers={authorization:`Bearer ${token}`};
    assert.equal((await fetch(origin+'/scoring-exports/'+first.job_id,{headers:{'x-internal-secret':'fixture-only'}})).status,401);
    const response=await fetch(origin+'/scoring-exports/'+first.job_id,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(((await response.json()) as {rows:Array<{input:{input_base64:string}}>}).rows[0].input.input_base64,golden.packet.input_base64);
    const bad=await fetch(origin+'/scoring-exports',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({subject_user_id:principal,served_from:from,served_to:to,role:'admin',private:'DO_NOT_LOG'})});
    assert.equal(bad.status,400);assert.equal((await bad.text()).includes('DO_NOT_LOG'),false);
    // A disconnected caller still occupies admission until its real SQL exits.
    let lockReady!:()=>void;const locked=new Promise<void>(resolve=>lockReady=resolve);
    const unlock=new Promise<void>(resolve=>releaseReadLock=resolve);
    const holding=admin.begin(async tx=>{await tx`SELECT private_scoring.lock_subject(${principal}::uuid)`;lockReady();await unlock;});
    await locked;
    const controller=new AbortController();
    const abandoned=fetch(origin+'/scoring-exports/'+first.job_id,{headers,signal:controller.signal});
    const waiting=fetch(origin+'/scoring-exports/'+first.job_id,{headers});
    for(let attempt=0;;attempt++) {
      const count=Number((await admin`SELECT count(*) FROM pg_stat_activity WHERE usename='export_fixture' AND wait_event='advisory'`)[0].count);
      if(count>=2)break;
      if(attempt>100)throw new Error('OWNED_EXPORT_READS_DID_NOT_BLOCK');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    controller.abort();await assert.rejects(abandoned);
    assert.equal((await fetch(origin+'/scoring-exports/'+first.job_id,{headers})).status,429);
    releaseReadLock!();await holding;
    assert.equal((await waiting).status,200);
    assert.equal((await fetch(origin+'/scoring-exports/'+first.job_id,{headers})).status,200);
    // Explicitly allowlisted admin scope is still bound to its own export job.
    await admin`INSERT INTO private_scoring.export_authorizations(principal_id,policy_digest,scope,subject_ids,expires_at)
      VALUES(${peer}::uuid,${scoringExportPolicyDigest(policy)},'admin',ARRAY[${principal}::uuid],clock_timestamp()+interval '1 hour')`;
    const adminManifest=await portAdapter.create(peer,selection);
    assert.equal((await portAdapter.page(peer,adminManifest.job_id,0,1)).rows[0].input!.input_base64,golden.packet.input_base64);
    await assert.rejects(portAdapter.page(peer,first.job_id,0,1),(error:unknown)=>error instanceof ScoringExportError&&error.reason==='forbidden');
    // Overflow is rejected atomically, not truncated to a misleading sample.
    const [overflow]=await admin`INSERT INTO telemetry.feed_serves(user_id,session_id,feed_version,created_at)
      VALUES(${peer}::uuid,${session}::uuid,1,${servedAt}) RETURNING serve_id`;
    await admin`INSERT INTO telemetry.feed_serve_items(serve_id,position,repo_id,score,source,model_version)
      SELECT ${overflow.serve_id}::uuid,number,${repo}::uuid,0.3,'semantic',${golden.context.model_version} FROM generate_series(0,500) AS number`;
    await admin`INSERT INTO private_scoring.export_authorizations(principal_id,policy_digest,scope,subject_ids,expires_at)
      VALUES(${peer}::uuid,${'0'.repeat(64)},'owner',ARRAY[${peer}::uuid],clock_timestamp()+interval '1 hour')`;
    await admin`UPDATE private_scoring.export_authorizations SET subject_ids=ARRAY[${principal}::uuid,${peer}::uuid] WHERE principal_id=${peer}::uuid AND scope='admin'`;
    const countBefore=Number((await admin`SELECT count(*) FROM private_scoring.export_snapshots`)[0].count);
    await assert.rejects(portAdapter.create(peer,{...selection,subjectUserId:peer}),(error:unknown)=>error instanceof ScoringExportError&&error.reason==='bounds');
    assert.equal(Number((await admin`SELECT count(*) FROM private_scoring.export_snapshots`)[0].count),countBefore);
    // Expiry and missing immutable bytes fail reads even before cleanup runs.
    const expiring=await portAdapter.create(principal,selection);
    await admin.begin(async tx=>{await tx`SET LOCAL session_replication_role='replica'`;
      await tx`UPDATE private_scoring.export_snapshots SET expires_at=clock_timestamp()-interval '1 second' WHERE job_id=${expiring.job_id}::uuid`;});
    await assert.rejects(portAdapter.page(principal,expiring.job_id,0,1),(error:unknown)=>error instanceof ScoringExportError&&error.reason==='expired');
    await admin`DELETE FROM private_scoring.scoring_generations WHERE generation_id=${generations[0]}::uuid`;
    await assert.rejects(portAdapter.page(principal,first.job_id,1,1),(error:unknown)=>error instanceof ScoringExportError&&error.reason==='expired',
      'missing feature on another page invalidates the entire frozen snapshot');
    const afterDeletion=await portAdapter.create(principal,selection);
    assert.equal((await portAdapter.page(principal,afterDeletion.job_id,0,1)).rows[0].exposure.source_status,'provenance_unavailable');
    // An RR view predating a concurrent revocation must fail, not export stale data.
    let rrReady!:()=>void,continueRr!:()=>void;
    const ready=new Promise<void>(resolve=>rrReady=resolve),proceed=new Promise<void>(resolve=>continueRr=resolve);
    const stale=exporter.begin('isolation level repeatable read',async tx=>{
      await tx`SELECT count(*) FROM pg_roles`;rrReady();await proceed;
      await tx`SELECT private_scoring.create_export_snapshot(${principal}::uuid,${principal}::uuid,${from}::timestamptz,${to}::timestamptz,${scoringExportPolicyJson(policy)}::text)`;
    });
    await ready;assert.deepEqual(await portAdapter.revoke(principal,principal),{revoked:true,purge_pending:true});continueRr();
    await assert.rejects(stale,{code:'40001'});
    await assert.rejects(portAdapter.page(principal,first.job_id,0,1),(error:unknown)=>error instanceof ScoringExportError&&error.reason==='expired');
    await assert.rejects(admin`SELECT private_scoring.persist_generation(${payload(generations[0])})`,{message:'SCORING_CAPTURE_EXPIRED'});
    await assert.rejects(product`INSERT INTO telemetry.feed_item_provenance(serve_id,position,user_id,repo_id,generation_id,record_digest,capture_status)
      VALUES(${header.serve_id}::uuid,3,${principal}::uuid,${repo}::uuid,${generations[0]}::uuid,${persisted[0].references[0].record_digest},'captured')`,{message:'SCORING_CAPTURE_EXPIRED'});
    const purger=new PostgresScoringRetention(retention,1);
    const result=await purger.purgeOnce();assert.equal(result.generationsDeleted,1);assert.equal(result.snapshotsDeleted,1);
    for(let count=0;count<10;count++){const result=await purger.purgeOnce();if(!result.generationsDeleted&&!result.snapshotsDeleted)break;}
    assert.equal(Number((await admin`SELECT count(*) FROM private_scoring.scoring_inputs`)[0].count),0);
    assert.equal(Number((await admin`SELECT count(*) FROM private_scoring.export_snapshots`)[0].count),0);
    assert.equal(Number((await product`SELECT count(*) FROM telemetry.feed_item_provenance`)[0].count),3,'durable exposure identity survives private deletion');
    await assert.rejects(admin`SELECT private_scoring.persist_generation(${payload(crypto.randomUUID())})`,{message:'SCORING_CAPTURE_EXPIRED'});
    // Private job/authorization/fence identity cascades on actual account delete.
    const deleting=crypto.randomUUID();await admin`INSERT INTO app.users VALUES(${deleting}::uuid)`;
    await admin`INSERT INTO private_scoring.export_authorizations(principal_id,policy_digest,scope,subject_ids,expires_at)
      VALUES(${deleting}::uuid,${scoringExportPolicyDigest(policy)},'owner',ARRAY[${deleting}::uuid],clock_timestamp()+interval '1 hour')`;
    const deletedManifest=await portAdapter.create(deleting,{...selection,subjectUserId:deleting});
    await admin`DELETE FROM app.users WHERE user_id=${deleting}::uuid`;
    assert.equal(Number((await admin`SELECT count(*) FROM private_scoring.export_authorizations WHERE principal_id=${deleting}::uuid`)[0].count),0);
    assert.equal(Number((await admin`SELECT count(*) FROM private_scoring.subject_export_fences WHERE user_id=${deleting}::uuid`)[0].count),0);
    await assert.rejects(portAdapter.page(deleting,deletedManifest.job_id,0,1),(error:unknown)=>error instanceof ScoringExportError&&error.reason==='forbidden');
  } finally {
    releasePending?.();releaseReadLock?.();
    if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
    await Promise.allSettled([exporter?.end({timeout:1}),retention?.end({timeout:1}),product?.end({timeout:1}),admin?.end({timeout:1})]);
    if(created) {
      const inspected=JSON.parse((await docker('inspect',name)).stdout)[0];assert.equal(inspected.Config.Labels['weave.export26.owner'],suffix);
      await docker('rm','--force',name);
    }
  }
});
