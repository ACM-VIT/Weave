import assert from 'node:assert/strict';
import test from 'node:test';
import type { Sql } from 'postgres';
import { ReadmeSummaryService, type ReadmeSummaryJob } from '../../services/readmeSummaryService.js';
import { isTransientReadmeStorageError } from '../../services/readmeStorageErrors.js';
import { ReadmeSummaryError } from '../../services/readmeSummaryGenerator.js';
import { digestFixture } from '../fixtures/readmeDigest.js';
import { runReadmeSummaryWorker } from '../../workers/readmeSummaryWorker.js';

const job:ReadmeSummaryJob={job_id:'job',generation_id:'generation',repo_id:'repo',content_version:1,content_hash:'hash',claim_token:'claim',attempts:1};
test('temporary PostgreSQL/socket errors are distinguished from permanent failures',()=>{
  for(const code of ['40001','40P01','08006','ECONNRESET','ETIMEDOUT','CONNECTION_CLOSED'])assert.equal(isTransientReadmeStorageError({cause:{code}}),true);
  for(const code of ['23505','23503','42601'])assert.equal(isTransientReadmeStorageError({code}),false);
  const cycle:any={};cycle.cause=cycle;assert.equal(isTransientReadmeStorageError(cycle),false);
});
for(const phase of ['source','completion'] as const) test(`temporary ${phase} failure reschedules the leased digest job`,async()=>{
  let update:unknown[]=[];
  const db=(async(strings:TemplateStringsArray,...values:unknown[])=>{
    if(strings.join('').includes('SELECT repo.full_name')){
      if(phase==='source')throw Object.assign(new Error('reset'),{code:'ECONNRESET'});
      return [{full_name:'team/project',description:'Task tooling',readme:'Source',content_version:1,content_hash:'hash'}];
    }
    update=values;return [];
  }) as unknown as Sql;
  class Worker extends ReadmeSummaryService {
    override async claim(){return job;}
    override async complete():Promise<boolean>{throw Object.assign(new Error('deadlock'),{code:'40P01'});}
  }
  const result=await new Worker({modelVersion:'test',generate:async()=>digestFixture},db).processOne();
  assert.equal(result.status,'retry_scheduled');assert.equal(update[0],'pending');
});
test('permanent provider errors remain terminal and storage recovery remains bounded',async()=>{
  for(const [error,attempts] of [[new ReadmeSummaryError('provider_policy',false),1],[Object.assign(new Error('reset'),{code:'ECONNRESET'}),4]] as const){
    const db=(async(strings:TemplateStringsArray)=>{if(strings.join('').includes('SELECT repo.full_name'))throw error;return [];}) as unknown as Sql;
    class Worker extends ReadmeSummaryService {override async claim(){return {...job,attempts};}}
    const result=await new Worker({modelVersion:'test',generate:async()=>digestFixture},db).processOne();assert.equal(result.status,'failed');
  }
});

test('bounded once processing lets ready jobs pass a stalled peer and preserves the total limit',async()=>{
  let release!:()=>void;const stalled=new Promise<void>(resolve=>{release=resolve;});
  let calls=0,active=0,maximum=0,finished=false;const delivered:string[]=[];
  const repoIds=['scoped-repo'];
  const running=runReadmeSummaryWorker({processOne:async ids=>{
    assert.equal(ids,repoIds);const index=calls++;active++;maximum=Math.max(maximum,active);
    if(index===0)await stalled;else await new Promise(resolve=>setImmediate(resolve));
    active--;return {status:'completed',repo_id:String(index)};
  }},{limit:5,concurrency:2,once:true,repoIds,onResult:result=>{delivered.push(result.repo_id!);}}).then(result=>{finished=true;return result;});
  try {
    for(let turn=0;delivered.length<4&&turn<100;turn++)await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(delivered,['1','2','3','4']);assert.equal(maximum,2);assert.equal(calls,5);assert.equal(finished,false);
  } finally {release();}
  assert.deepEqual(await running,{processed:5,failures:0});assert.equal(active,0);
});

test('daemon drains beyond its turn limit while a peer stalls and backs off only on an empty queue',async()=>{
  let release!:()=>void;const stalled=new Promise<void>(resolve=>{release=resolve;});
  const stop=new AbortController();let calls=0,sleeps=0,finished=false;
  const delivered:string[]=[];
  const running=runReadmeSummaryWorker({processOne:async()=>{
    const index=calls++;
    if(index===0)await stalled;
    if(index===9)return {status:'idle'};
    return {status:'completed',repo_id:String(index)};
  }},{limit:1,concurrency:2,once:false,signal:stop.signal,onResult:result=>{delivered.push(result.repo_id!);},
    sleep:async milliseconds=>{assert.equal(milliseconds,3000);sleeps++;stop.abort();},
  }).then(result=>{finished=true;return result;});
  try {
    for(let turn=0;!sleeps&&turn<100;turn++)await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(delivered,['1','2','3','4','5','6','7','8']);
    assert.equal(sleeps,1);assert.equal(finished,false,'stop still owns the stalled processing slot');
  } finally {release();stop.abort();}
  assert.deepEqual(await running,{processed:9,failures:0});
});

for(const failure of ['summary_provider_daily_quota_exhausted','claim-error']) test(`worker stops new claims and drains peers after ${failure}`,async()=>{
  let release!:()=>void;const stalled=new Promise<void>(resolve=>{release=resolve;});let calls=0,settled=false;
  const running=runReadmeSummaryWorker({processOne:async()=>{
    if(calls++===0){if(failure==='claim-error')throw new Error(failure);return {status:'failed',error:failure};}
    await stalled;return {status:'completed'};
  }},{limit:10,concurrency:2,once:false,onResult:()=>{}});
  const observed=running.then(result=>({result}),error=>({error})).then(result=>{settled=true;return result;});
  try {
    await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);assert.equal(settled,false);
  } finally {release();}
  const outcome=await observed;assert.equal(calls,2);
  if(failure==='claim-error'){assert.ok('error' in outcome);assert.equal(outcome.error.message,'claim-error');}
  else {assert.ok('result' in outcome);assert.deepEqual(outcome.result,{processed:2,failures:1});}
});

test('stop wakes idle workers without waiting for their next poll or claiming more work',async()=>{
  const stop=new AbortController();let calls=0,finished=false;
  const running=runReadmeSummaryWorker({processOne:async()=>{calls++;return {status:'idle'};}},
    {limit:10,concurrency:2,once:false,signal:stop.signal,onResult:()=>{}}).then(()=>{finished=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);assert.equal(finished,false);
  stop.abort();await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,true);assert.equal(calls,2);await running;
});
