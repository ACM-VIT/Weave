import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {stopFixtureProcess} from './fixtureProcess.js';
import {MlV2Client} from '../../services/mlService.js';
import {buildMlRepositorySource} from '../../services/mlRepositoryPayloadService.js';
const mlRoot=process.env.WEAVE_ML_CONTRACT_ROOT;

test('pinned real Python HTTP preserves observed lineage from canonical Node index projection', {skip:!mlRoot,timeout:45000},async t=>{
  assert.ok(mlRoot&&path.isAbsolute(mlRoot));
  const release=JSON.parse(await readFile(new URL('../../contracts/ml-contract-release.json',import.meta.url),'utf8'));
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:mlRoot,encoding:'utf8'}).trim(),release.revision);
  assert.equal(await readFile(path.join(mlRoot,'contracts/ml-v2.openapi.json'),'utf8'),
    await readFile(new URL('../../contracts/ml-v2.openapi.json',import.meta.url),'utf8'));
  const fixture=fileURLToPath(new URL('./lineageContractServer.py',import.meta.url));
  const child=spawn(path.join(mlRoot,'.venv/bin/python'),['-c',`import runpy;runpy.run_path(${JSON.stringify(fixture)},run_name='__main__')`],{
    cwd:mlRoot,env:{...process.env,APP_ENV:'development',MIN_ELIGIBLE_REPOSITORIES:'0',
      QDRANT_URL:'http://127.0.0.1:9',REDIS_URL:'redis://127.0.0.1:9',INTERNAL_API_SECRET:'local-lineage-contract-secret'},
    stdio:['ignore','pipe','inherit'],
  });
  t.after(()=>stopFixtureProcess(child));
  const port=await new Promise<string>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Lineage fixture did not bind.')),15000);let output='';
    child.stdout.on('data',chunk=>{output+=String(chunk);const match=/LINEAGE_CONTRACT_PORT=(\d+)/.exec(output);
      if(match){clearTimeout(timer);resolve(match[1]!);}});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Lineage fixture exited before readiness.'));});
  });
  const origin=`http://127.0.0.1:${port}`;
  const observed={github_id:'123',owner_github_id:'9223372036854775807',
    owner:'fixture',name:'lineage',full_name:'fixture/lineage',url:'https://github.com/fixture/lineage',
    description:'This isolated library validates repository lineage and canonical owner identity. It preserves source metadata across a bounded transport contract.',observed_at:'2026-10-23T00:00:01Z',
    lineage_source:'github-graphql-repository',lineage_observed_at:'2026-10-23T00:00:00.000001Z'} as const;
  const repository=buildMlRepositorySource({...observed,is_fork:true,fork_parent_github_id:'222',fork_family_github_id:'333'},'b'.repeat(64));
  const job={job_id:'00000000-0000-4000-8000-000000000005',repo_id:'00000000-0000-4000-8000-000000000003',
    content_version:1,repository};
  const client=new MlV2Client({baseUrl:origin,internalSecret:'local-lineage-contract-secret',timeoutMs:5000,
    repositoryIndexTimeoutMs:5000,maxResponseBytes:1_000_000});
  const variants=[
    ['fork',repository],
    ['unknown',buildMlRepositorySource({...observed,is_fork:null},'b'.repeat(64))],
    ['nonfork',buildMlRepositorySource({...observed,is_fork:false,fork_family_github_id:'123'},'b'.repeat(64))],
  ] as const;
  for(const[index,[variant,source]]of variants.entries()){
    const result=await client.deliverRepositoryIndex({...job,job_id:`00000000-0000-4000-8000-${String(index+5).padStart(12,'0')}`,
      content_version:index+1,repository:source});
    assert.equal(result.accepted,true,`${variant}: ${result.detail}`);
    assert.equal((result.response_body as {embedding_version:string}).embedding_version,`contract-embedding-v2-${variant}`,
      'each valid variant must traverse the real registered route and payload builder');
  }
  const post=(source:unknown,secret='local-lineage-contract-secret')=>fetch(`${origin}/api/v2/repositories/embed`,{
    method:'POST',headers:{'content-type':'application/json','x-internal-secret':secret},
    body:JSON.stringify({schema_version:2,...job,repository:source}),
  });
  assert.equal((await post(repository,'wrong-secret')).status,401);
  for(const invalid of [{...repository,is_fork:false},{...repository,is_fork:null},
    {...repository,fork_family_github_id:'123'},{...repository,lineage_source:null},
    {...repository,lineage_observed_at:'2026-10-23T00:00:00'},
    {...repository,owner_github_id:'9223372036854775808'},
    {...repository,fork_parent_github_id:'0222'},{...repository,private_actor_id:'forbidden'}]){
    assert.equal((await post(invalid)).status,422);
  }
});
