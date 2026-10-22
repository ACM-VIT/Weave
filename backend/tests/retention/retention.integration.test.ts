import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {sqlClient} from '../../db/index.js';
import {RetentionWorker} from '../../workers/retentionWorker.js';
import {OutboxService} from '../../services/outboxService.js';
import {PostgresRepositoryPersistence} from '../../adapters/postgresRepositoryPersistence.js';
import {runReindex} from '../../scripts/reindex-active-repositories.js';

const integration=process.env.RUN_RETENTION_INTEGRATION==='1'?test:test.skip;
test.after(async()=>{if(process.env.RUN_RETENTION_INTEGRATION==='1')await sqlClient.end({timeout:1});});
integration('retention preserves the last delivered repository index so future refreshes remain claimable',async()=>{
  const target=new URL(process.env.DATABASE_URL!);
  assert.ok(['127.0.0.1','localhost'].includes(target.hostname)&&target.pathname==='/weave_review');
  const aggregate=crypto.randomUUID();const [older,checkpoint,feedback,refresh]=Array.from({length:4},()=>crypto.randomUUID());
  try{
    for(const [id,kind,days] of [[older,'repo_index',50],[checkpoint,'repo_index',40],[feedback,'feedback',40]] as const){
      const payload=kind==='repo_index'?{content_version:id===checkpoint?2:1}:{};
      await sqlClient`INSERT INTO telemetry.ml_outbox(outbox_id,job_type,aggregate_id,idempotency_key,payload,status,created_at,delivered_at)
        VALUES(${id}::uuid,${kind},${aggregate}::uuid,${id},${JSON.stringify(payload)}::text::jsonb,'delivered',now()-${days}*interval '1 day',now()-${days}*interval '1 day')`;
    }
    await sqlClient`INSERT INTO telemetry.ml_outbox(outbox_id,job_type,aggregate_id,idempotency_key,payload)
      VALUES(${refresh}::uuid,'repo_refresh',${aggregate}::uuid,${refresh},'{"required_content_version":2}'::jsonb)`;
    // The highest content version must survive an adverse UUID order at one
    // transaction timestamp, even when a later malformed/legacy row exists.
    const numericAggregate=crypto.randomUUID();
    const [highest,lower]=[crypto.randomUUID(),crypto.randomUUID()].sort();
    const malformed=crypto.randomUUID();
    try {
      await sqlClient`INSERT INTO telemetry.ml_outbox(outbox_id,job_type,aggregate_id,idempotency_key,payload,status,created_at,delivered_at)
        VALUES
        (${highest}::uuid,'repo_index',${numericAggregate}::uuid,${highest},'{"content_version":10}','delivered',now()-interval '50 days',now()-interval '50 days'),
        (${lower}::uuid,'repo_index',${numericAggregate}::uuid,${lower},'{"content_version":9}','delivered',now()-interval '50 days',now()-interval '50 days'),
        (${malformed}::uuid,'repo_index',${numericAggregate}::uuid,${malformed},'{"content_version":"999999999999999999999999999999"}','delivered',now()-interval '40 days',now()-interval '40 days')`;
      for (let pass=0;pass<2;pass++) {
        await new RetentionWorker().runOnce(30,30);
        const witnesses=await sqlClient`SELECT outbox_id FROM telemetry.ml_outbox WHERE aggregate_id=${numericAggregate}::uuid`;
        assert.deepEqual(new Set(witnesses.map(row=>String(row.outbox_id))),new Set([highest,malformed]));
      }
    } finally { await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${numericAggregate}::uuid`; }
    await new RetentionWorker().runOnce(30,30);
    const remaining=await sqlClient`SELECT outbox_id FROM telemetry.ml_outbox WHERE aggregate_id=${aggregate}::uuid`;
    assert.deepEqual(new Set(remaining.map(row=>String(row.outbox_id))),new Set([checkpoint,refresh]));
    assert.ok((await new OutboxService().claim(10)).some(row=>row.outbox_id===refresh));
    await new RetentionWorker().runOnce(30,30);
    assert.equal((await sqlClient`SELECT count(*)::int AS n FROM telemetry.ml_outbox WHERE outbox_id=${checkpoint}::uuid`)[0].n,1);
  }finally{await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${aggregate}::uuid`;}
});


integration('a scoped fresh index campaign restores a purged retention checkpoint and unblocks refresh delivery',async()=>{
  const target=new URL(process.env.DATABASE_URL!);
  assert.ok(['127.0.0.1','localhost'].includes(target.hostname)&&target.pathname==='/weave_review');
  const suffix=crypto.randomUUID().replaceAll('-','').slice(0,10);
  const githubId=BigInt('0x'+suffix).toString();
  const ownerGithubId=(BigInt(githubId)+10000000000000n).toString();
  const name=`checkpoint-${suffix}`;
  let repoId:string|undefined;
  try{
    const record={github_id:githubId,owner_github_id:ownerGithubId,full_name:`${name}/project`,owner:name,name:'project',
      url:`https://github.com/${name}/project`,description:'Reliable repository processing.',
      readme:'# Source\n\nCanonical repository documentation stays separate from card summaries.',
      languages:['TypeScript'],topics:['processing'],star_count:1,fork_count:0,open_issues_count:0,observed_at:new Date().toISOString()};
    const persistence=new PostgresRepositoryPersistence();
    const [mapped]=await persistence.bulkUpsert([record]);repoId=mapped.repo_id;
    await sqlClient`UPDATE telemetry.ml_outbox SET status='delivered',delivered_at=now()-interval '40 days'
      WHERE aggregate_id=${repoId}::uuid AND job_type='repo_index'`;
    // Reproduce an older retention version that already purged the checkpoint.
    await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${repoId}::uuid AND job_type='repo_index'`;
    const secondObservation={...record,star_count:2,observed_at:new Date(Date.parse(record.observed_at)+1000).toISOString()};
    await persistence.bulkUpsert([secondObservation]);
    const outbox=new OutboxService();
    assert.deepEqual(await outbox.claim(10),[],'A refresh cannot run without a delivered index checkpoint');
    const options={campaignId:`checkpoint-${suffix}`,execute:false,batchSize:10,summaryBackfill:false,repositoryIds:[repoId]};
    const dry=await runReindex(options,process.env.DATABASE_URL!);
    assert.equal(dry.would_queue,1);
    assert.equal(Number((await sqlClient`SELECT count(*)::int AS n FROM telemetry.ml_outbox WHERE aggregate_id=${repoId}::uuid AND job_type='repo_index'`)[0].n),0);
    await runReindex({...options,execute:true},process.env.DATABASE_URL!);
    const [claimed]=await outbox.claim(10);
    assert.equal(claimed.job_type,'repo_index');assert.equal(claimed.aggregate_id,repoId);
    const payload=claimed.payload as {job_id:string;content_version:number};
    assert.equal(await outbox.completeRepositoryIndex(claimed,{
      schema_version:2,accepted:true,status:'applied',job_id:payload.job_id,repo_id:repoId,
      content_version:payload.content_version,embedding_version:'fixture-embedding-v2',
      card_summary:{summary:'This toolkit coordinates background tasks across application services. Teams can inspect progress and recover work after temporary failures.',
        highlights:['Task coordination'],prompt_version:'repo-card-summary-v1',model_version:'fixture-summary-v1',format_version:'repo-card-summary-json-v1',source:'generated'},
    }),true);
    const replay=await runReindex({...options,execute:true},process.env.DATABASE_URL!);
    assert.equal(replay.already_queued,1,'The recovery campaign must be idempotent');
    const next=await outbox.claim(10);
    assert.equal(next.length,2,'Recovery must preserve both independent feature observations');
    assert.ok(next.every(row=>row.job_type==='repo_refresh'&&row.aggregate_id===repoId));
    assert.deepEqual(next.map(row=>Number(row.payload.required_content_version)),[mapped.content_version,mapped.content_version]);
    assert.deepEqual(next.map(row=>Number(row.payload.feature_version)).sort((a,b)=>a-b),
      [Date.parse(record.observed_at),Date.parse(secondObservation.observed_at)]);
    assert.ok(next.every(row=>Number(row.payload.required_content_version)===payload.content_version));
    assert.equal(Number((await sqlClient`SELECT count(*)::int AS n FROM telemetry.ml_outbox WHERE aggregate_id=${repoId}::uuid AND job_type='repo_index' AND status='delivered'`)[0].n),1);
  }finally{
    if(repoId){await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${repoId}::uuid`;await sqlClient`DELETE FROM app.repos WHERE repo_id=${repoId}::uuid`;}
    await sqlClient`DELETE FROM app.social_profiles WHERE provider='github' AND provider_subject=${ownerGithubId}`;
  }
});
