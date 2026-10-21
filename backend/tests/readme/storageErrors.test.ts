import assert from 'node:assert/strict';
import test from 'node:test';
import type { Sql } from 'postgres';
import { ReadmeSummaryService, type ReadmeSummaryJob } from '../../services/readmeSummaryService.js';
import { isTransientReadmeStorageError } from '../../services/readmeStorageErrors.js';
import { ReadmeSummaryError } from '../../services/readmeSummaryGenerator.js';
import { digestFixture } from '../fixtures/readmeDigest.js';

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
