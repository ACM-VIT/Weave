import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import express, { type ErrorRequestHandler } from 'express';

const mlRoot = process.env.WEAVE_ML_INGESTION_ROOT;

test('Python ingestion batches satisfy the registered HTTP UTF-8 byte/count contract', {
  skip: !mlRoot, timeout: 60_000,
}, async () => {
  assert.ok(mlRoot && path.isAbsolute(mlRoot), 'Select an explicit ML checkout.');
  const previous = { ...process.env };
  // The router imports the lazy SQL adapter. No real database is needed or allowed:
  // replace only its persistence boundary, keeping parser/auth/controller validation.
  process.env.DATABASE_URL = 'postgresql://wire:wire@127.0.0.1:9/weave_wire_contract';
  process.env.INTERNAL_API_SECRET = 'ingestion-wire-contract-secret';
  delete process.env.INTERNAL_API_SECRET_PREVIOUS;
  process.env.DB_SCHEMA_V2_WRITES = 'true';
  const { PostgresRepositoryPersistence } = await import('../../adapters/postgresRepositoryPersistence.js');
  const { sqlClient } = await import('../../db/index.js');
  const { default: router } = await import('../../routes/ingestionRoutes.js');
  const { scopedJsonBodyParser, jsonBodyLimitLabel } = await import('../../middlewares/scopedJsonBodyMiddleware.js');
  const original = PostgresRepositoryPersistence.prototype.bulkUpsert;
  const accepted: unknown[] = [];
  let requests = 0;
  PostgresRepositoryPersistence.prototype.bulkUpsert = async function (repositories) {
    accepted.push(repositories.map(item => ({
      github_id: item.github_id,
      languages:item.languages,primary_language:item.primary_language,language_breakdown:item.language_breakdown,language_total_size:item.language_total_size,language_breakdown_complete:item.language_breakdown_complete,
      readme_hash: createHash('sha256').update(item.readme ?? '').digest('hex'),
      readme_source_path: item.readme_source_path,
      readme_default_branch: item.readme_default_branch,
      readme_base_url: item.readme_base_url,
    })));
    return repositories.map(item => ({ github_id: item.github_id, repo_id: randomUUID(),
      content_version: 1, changed: true }));
  };
  const app = express();
  app.use((req, _res, next) => { if (req.method === 'POST') requests++; next(); });
  app.use(scopedJsonBodyParser);
  app.use('/api/internal/v2/ingestion', router);
  app.post('/api/v2/wire-test', (_req, res) => res.status(204).end());
  app.get('/wire-test-stats', (_req, res) => res.json({ requests, accepted }));
  const errors: ErrorRequestHandler = (error, req, res, next) => {
    if (error.type !== 'entity.too.large') { next(error); return; }
    res.status(413).json({ error: `Request payload exceeds ${jsonBodyLimitLabel(req)}.` });
  };
  app.use(errors);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { stdout } = await promisify(execFile)(path.join(mlRoot, '.venv/bin/python'), [
      path.resolve('tests/fixtures/ingestionWireClient.py'), origin, mlRoot,
    ], { timeout: 45_000, killSignal: 'SIGKILL', maxBuffer: 1_000_000,
      env: { ...process.env, PYTHONNOUSERSITE: '1' } });
    const result = JSON.parse(stdout);
    assert.deepEqual(result.byte_boundaries, [8_388_607, 8_388_608, 8_388_609]);
    assert.deepEqual(result.record_boundaries, [100, 101]);
    assert.equal(result.non_retryable_413_attempts, 1);
    assert.equal(result.oversized_record_isolated, true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    PostgresRepositoryPersistence.prototype.bulkUpsert = original;
    await sqlClient.end({ timeout: 0 });
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test('canonical language input retains sourced composition and treats legacy names as unknown weights',async()=>{
  const {normalizeRepositoryLanguages}=await import('../../services/repositoryLanguages.js');
  const rich=[{name:' Python ',color:'#3572A5',size:300,percentage:30},{name:'Rust',color:null,size:200,percentage:20}];
  assert.deepEqual(normalizeRepositoryLanguages(rich),{languages:['Python','Rust'],language_breakdown:[{...rich[0],name:'Python'},rich[1]],language_total_size:null,language_breakdown_complete:null});
  assert.deepEqual(normalizeRepositoryLanguages({Python:300,Rust:200}).language_breakdown,
    [{name:'Python',color:null,size:300,percentage:null},{name:'Rust',color:null,size:200,percentage:null}]);
  for(const value of [null,[],undefined])assert.deepEqual(normalizeRepositoryLanguages(value),{languages:[]});
  assert.deepEqual(normalizeRepositoryLanguages([' Python ','Rust','Python']),{languages:['Python','Rust']});
  const observed=normalizeRepositoryLanguages(['Python','Rust'],{language_breakdown:rich,language_total_size:1000,language_breakdown_complete:false});
  assert.equal(observed.language_total_size,1000);assert.equal(observed.language_breakdown_complete,false);
  assert.throws(()=>normalizeRepositoryLanguages(['0','1']),/language/i);
});

test('rich language validation fences totals and supplied percentage rounding without inventing absent evidence',async()=>{
  const {normalizeRepositoryLanguages}=await import('../../services/repositoryLanguages.js');
  const rounded=Array.from({length:6},(_,i)=>({name:`Lang${i}`,color:null,size:1,percentage:16.67}));
  assert.equal(normalizeRepositoryLanguages([], {language_breakdown:rounded,language_total_size:6,language_breakdown_complete:true}).language_breakdown?.length,6);
  const unknown=Array.from({length:98},(_,i)=>({name:`Unknown${i}`,color:null,size:null,percentage:null}));
  assert.throws(()=>normalizeRepositoryLanguages([],{language_breakdown:[{name:'A',percentage:50.4},{name:'B',percentage:50.4},...unknown]}),/percentage/i);
  assert.throws(()=>normalizeRepositoryLanguages([],{language_breakdown:[{name:'A',size:10,percentage:70}],language_total_size:100}),/percentage/i);
  assert.throws(()=>normalizeRepositoryLanguages([],{language_breakdown:[{name:'A',size:101}],language_total_size:100}),/size|total/i);
  assert.deepEqual(normalizeRepositoryLanguages(['Python'],{language_breakdown:null,language_total_size:null,language_breakdown_complete:null}),{languages:['Python']});
  assert.deepEqual(normalizeRepositoryLanguages([],{language_breakdown:[],language_total_size:0,language_breakdown_complete:true}),
    {languages:[],language_breakdown:[],language_total_size:0,language_breakdown_complete:true});
});


test('reindex dry-run job normalization retains historical language names without invented percentages', async () => {
  const {buildCampaignRepositoryJob} = await import('../../scripts/reindex-active-repositories.js');
  const base = {repo_id:randomUUID(),github_id:'123',owner_github_id:'456',full_name:'fixture/languages',
    url:'https://github.com/fixture/languages',description:'A language fixture.',readme:null,readme_source_path:null,
    readme_default_branch:null,readme_base_url:null,primary_language:'Rust',topics:[],content_hash:'a'.repeat(64),
    content_version:1,source_updated_at:null,star_count:0,fork_count:0,open_issues_count:0,observed_at:'2026-10-27T00:00:00Z'};
  for (const languages of [{Python:300,Rust:200},[{name:'Python',size:300},{name:'Rust',size:200}]]) {
    const job = buildCampaignRepositoryJob({...base,languages});
    assert.ok(job);assert.deepEqual(job.repository.languages,['Python','Rust']);
    assert.equal(job.repository.primary_language,'Rust');
    assert.equal(job.repository.language_total_size,null);
    assert.deepEqual(job.repository.language_breakdown?.map(row=>row.percentage),[null,null]);
  }
  assert.equal(buildCampaignRepositoryJob({...base,languages:['0','1']}),null);
});
