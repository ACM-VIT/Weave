import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PostgresRepositoryPersistence } from '../../adapters/postgresRepositoryPersistence.js';
import type { ReadmeSummaryContent } from '../../contracts/readmeSummary.v2.js';
import { ReadmeSummaryService, enqueueReadmeSummary, readmeSummaryProjection, getReadmeSummaryStatus } from '../../services/readmeSummaryService.js';
import { ReadmeSummaryError, type ReadmeSummaryGenerator } from '../../services/readmeSummaryGenerator.js';

const integration=process.env.RUN_README_SUMMARY_INTEGRATION==='1'?test:test.skip;
const content:ReadmeSummaryContent={
  overview:'This project helps developers coordinate background processing through a common task model and a set of reusable execution adapters. Application teams can separate scheduling from execution while keeping progress, completion, and recovery visible to the interface, reducing the need for several competing representations of task state.',
  capabilities:[
    'A shared task model records explicit state transitions so application components and background processes can track the same work consistently.',
    'Execution adapters connect different processing implementations while preserving predictable retry handling and a common way to report completion and progress.',
    'Progress events give interfaces useful updates while asynchronous jobs run, allowing users to understand what is happening without continually restarting their request.',
  ],use_cases:['Teams can build visible document processing, data import, or maintenance workflows that need to recover from temporary service failures without losing the current task.'],considerations:[],
};

integration('V2 jobs are idempotent, fenced, regenerable, and retried without touching legacy storage', async()=>{
  const url=new URL(process.env.README_SUMMARY_TEST_DATABASE_URL??'');
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Use an isolated loopback V2 database');
  const db=postgres(url.toString(),{max:4,prepare:false});
  const repoId=crypto.randomUUID();
  const provider:ReadmeSummaryGenerator={modelVersion:'test-model',async generate(){return content;}};
  const service=new ReadmeSummaryService(provider,db);
  try {
    await db`INSERT INTO app.repos(repo_id,github_id,full_name,owner,name,url)
      VALUES(${repoId}::uuid,${String(Date.now())}::bigint,'test/readme-pipeline','test','readme-pipeline','https://github.com/test/readme-pipeline')`;
    await db`INSERT INTO app.repo_content(repo_id,content_hash,content_version,readme)
      VALUES(${repoId}::uuid,'hash-v1',1,${'Real source material. '.repeat(60)})`;
    await db.begin(async(tx)=>{await enqueueReadmeSummary(tx,repoId,1,'hash-v1');await enqueueReadmeSummary(tx,repoId,1,'hash-v1');});
    assert.equal(Number((await db`SELECT count(*) AS n FROM telemetry.readme_summary_jobs WHERE repo_id=${repoId}::uuid`)[0].n),1);
    await db`INSERT INTO telemetry.readme_summary_jobs(repo_id,content_version,content_hash,prompt_version,created_at)
      VALUES(${repoId}::uuid,1,'hash-v1','retired-prompt',now()-interval '1 day')`;
    const claims=await Promise.all([service.claim([repoId]),service.claim([repoId])]);
    assert.equal(claims.filter(Boolean).length,1,'Only one worker may own the current-prompt job');
    assert.equal((await db`SELECT status FROM telemetry.readme_summary_jobs WHERE repo_id=${repoId}::uuid AND prompt_version='retired-prompt'`)[0].status,'pending',
      'A worker must not claim a job created for a different prompt version');
    const first=claims.find(Boolean)!;
    const wrong={...first,claim_token:crypto.randomUUID()};
    assert.equal(await service.complete(wrong,content),false,'A stale worker cannot complete');
    assert.equal(await service.complete(first,content),true);
    assert.equal(await service.complete(first,content),false,'Completion replay is idempotent');
    const read=()=>db.unsafe(`SELECT ${readmeSummaryProjection('repo','content')} FROM app.repos repo JOIN app.repo_content content USING(repo_id) WHERE repo.repo_id=$1::uuid`,[repoId]);
    const initial=(await read())[0].readme_digest;
    assert.equal(initial.overview,content.overview);
    assert.equal(initial.source,'generated');
    assert.equal((await getReadmeSummaryStatus(repoId,db))?.status,'ready');
    assert.equal(await getReadmeSummaryStatus(crypto.randomUUID(),db),null);
    // Production shares the client with Drizzle, which overrides JSON serializers.
    drizzle(db);
    await service.enqueueMissing([repoId],true);
    assert.equal((await service.processOne([repoId])).status,'completed');
    assert.notEqual((await read())[0].readme_digest.summary_id,initial.summary_id,'Explicit regeneration creates a new versioned artifact');
    await db`UPDATE app.repo_content SET content_version=2,content_hash='hash-v2' WHERE repo_id=${repoId}::uuid`;
    assert.equal((await read())[0].readme_digest,null,'Read projections never return stale content');
    assert.equal((await getReadmeSummaryStatus(repoId,db))?.status,'unavailable');
    await service.enqueueMissing([repoId]);
    assert.equal((await getReadmeSummaryStatus(repoId,db))?.status,'pending');
    const stale=await service.claim([repoId]); assert.ok(stale);
    await db`UPDATE app.repo_content SET content_version=3,content_hash='hash-v3' WHERE repo_id=${repoId}::uuid`;
    assert.equal(await service.complete(stale,content),false,'Older generation cannot activate after a README edit');
    await service.enqueueMissing([repoId]);
    const failing=new ReadmeSummaryService({modelVersion:'test-model',async generate(){throw new ReadmeSummaryError('summary_provider_http_429',true);}},db);
    assert.equal((await failing.processOne([repoId])).status,'retry_scheduled');
    const pending=(await db`SELECT status,claim_token,last_error FROM telemetry.readme_summary_jobs WHERE repo_id=${repoId}::uuid AND content_version=3`)[0];
    assert.equal(pending.status,'pending');assert.equal(pending.claim_token,null);assert.equal(pending.last_error,'summary_provider_http_429');
    const existing=(await db`SELECT github_id FROM app.repos WHERE repo_id=${repoId}::uuid`)[0];
    const upserts=new PostgresRepositoryPersistence(db);
    const record={github_id:String(existing.github_id),owner_github_id:'990000000001',full_name:'test/readme-pipeline',
      owner:'test',name:'readme-pipeline',url:'https://github.com/test/readme-pipeline',
      description:'V2 ingestion test.',readme:'Canonical source document. '.repeat(80),languages:['TypeScript'],topics:['test'],observed_at:new Date().toISOString()};
    const mapping=(await upserts.bulkUpsert([record]))[0];
    assert.equal(mapping.repo_id,repoId);
    const stored=(await db`SELECT languages FROM app.repo_content WHERE repo_id=${repoId}::uuid`)[0];
    assert.deepEqual(stored.languages,['TypeScript'],'JSON must be an array, not a doubly encoded string');
    const payload=(await db`SELECT payload FROM telemetry.ml_outbox WHERE aggregate_id=${repoId}::uuid AND job_type='repo_index' ORDER BY created_at DESC LIMIT 1`)[0].payload;
    assert.equal(typeof payload,'object');assert.equal(payload.repository.readme,record.readme);
    const count=Number((await db`SELECT count(*) AS n FROM telemetry.readme_summary_jobs WHERE repo_id=${repoId}::uuid`)[0].n);
    await upserts.bulkUpsert([record]);
    assert.equal(Number((await db`SELECT count(*) AS n FROM telemetry.readme_summary_jobs WHERE repo_id=${repoId}::uuid`)[0].n),count,'Unchanged ingestion does not duplicate summary jobs');
    const legacy=await db`SELECT count(*) AS n FROM public.repo WHERE repo_id=${repoId}::uuid`;
    assert.equal(Number(legacy[0].n),0);
  } finally {await db`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${repoId}::uuid`;await db`DELETE FROM app.repos WHERE repo_id=${repoId}::uuid`;await db.end({timeout:1});}
});
