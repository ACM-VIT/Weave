/** Opt-in live acceptance run: public GitHub sources -> V2 ingestion -> durable digest jobs. */
import 'dotenv/config';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sqlClient } from '../db/index.js';
import type { RepositoryUpsert } from '../contracts/ingestion.v2.js';
import { isRepositoryUpsert } from '../utils/ingestionValidation.js';
import { OpenRouterReadmeSummaryGenerator } from '../services/readmeSummaryGenerator.js';
import { ReadmeSummaryService } from '../services/readmeSummaryService.js';

const execute=process.argv.includes('--execute');
const count=Number(process.argv.find((arg)=>arg.startsWith('--count='))?.slice(8)??10);
if (!Number.isInteger(count)||count<1||count>10) throw new Error('--count must be 1–10');
const target=new URL(process.env.WEAVE_TEST_BACKEND_URL||'http://127.0.0.1:5001');
if (!['127.0.0.1','localhost','[::1]'].includes(target.hostname)) throw new Error('The acceptance runner requires a loopback backend URL');
const reportPath=process.argv.find((arg)=>arg.startsWith('--report='))?.slice(9);
const githubHeaders:Record<string,string>={Accept:'application/vnd.github+json','User-Agent':'Weave-README-acceptance',
  ...(process.env.GITHUB_TOKEN?{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`}:{})};
const execFileAsync=promisify(execFile);
async function github(path:string):Promise<any>{
  if(process.argv.includes('--github-cli')){
    const cliEnv={...process.env,GITHUB_TOKEN:''};
    const result=await execFileAsync('gh',['api',path],{env:cliEnv,maxBuffer:4*1024*1024,timeout:30000});
    return JSON.parse(result.stdout);
  }
  let response=await fetch(`https://api.github.com${path}`,{headers:githubHeaders,signal:AbortSignal.timeout(20000)});
  if(response.status===401 && githubHeaders.Authorization){
    await response.body?.cancel();delete githubHeaders.Authorization;
    console.log(JSON.stringify({status:'github_public_read',reason:'configured_token_rejected'}));
    response=await fetch(`https://api.github.com${path}`,{headers:githubHeaders,signal:AbortSignal.timeout(20000)});
  }
  if(!response.ok){await response.body?.cancel();throw new Error(`github_http_${response.status}`);}
  return response.json();
}

try {
  const originalCount=Number((await sqlClient`SELECT count(*) AS n FROM app.repos`)[0].n);
  const selected:RepositoryUpsert[]=[];
  for(let page=1;page<=3&&selected.length<count;page++){
    const found=await github(`/search/repositories?q=${encodeURIComponent('topic:developer-tools stars:>5000 archived:false fork:false')}&sort=stars&order=desc&per_page=50&page=${page}`);
    const candidateIds=(found.items??[]).map((repo:any)=>String(repo.id));
    const existingIds=new Set((await sqlClient`SELECT github_id::text AS id FROM app.repos WHERE github_id=ANY(${candidateIds}::bigint[])`).map((row)=>String(row.id)));
    for(const repo of found.items??[]){
      if(selected.length===count)break;
      if(existingIds.has(String(repo.id)))continue;
      let document:any;
      try{document=await github(`/repos/${repo.full_name}/readme`);}catch{continue;}
      if(document.encoding!=='base64'||typeof document.content!=='string')continue;
      const readme=Buffer.from(document.content,'base64').toString('utf8');
      if(readme.length<1000||readme.length>150000)continue;
      const languages=await github(`/repos/${repo.full_name}/languages`);
      const directory=String(document.path).split('/').slice(0,-1).map(encodeURIComponent).join('/');
      const record:RepositoryUpsert={
        github_id:String(repo.id),github_node_id:repo.node_id,owner_github_id:String(repo.owner.id),
        full_name:repo.full_name,owner:repo.owner.login,name:repo.name,url:repo.html_url,
        description:repo.description,readme,readme_source_path:document.path,readme_default_branch:repo.default_branch,
        readme_base_url:`https://raw.githubusercontent.com/${repo.full_name}/refs/heads/${repo.default_branch}/${directory?directory+'/':''}`,
        primary_language:repo.language,languages:Object.keys(languages),topics:repo.topics??[],
        star_count:repo.stargazers_count,fork_count:repo.forks_count,open_issues_count:repo.open_issues_count,
        created_at:repo.created_at,updated_at:repo.updated_at,pushed_at:repo.pushed_at,observed_at:new Date().toISOString(),
      };
      if(!isRepositoryUpsert(record))throw new Error(`Invalid canonical source for ${repo.full_name}`);
      selected.push(record);console.log(JSON.stringify({status:'selected_new_repository',full_name:record.full_name,readme_characters:readme.length}));
    }
  }
  if(selected.length!==count)throw new Error('Not enough new public repositories with useful README source');
  if(!execute){console.log(JSON.stringify({dry_run:true,original_repository_count:originalCount,selected:selected.map((repo)=>repo.full_name)}));}
  else{
    if(!process.env.INTERNAL_API_SECRET)throw new Error('INTERNAL_API_SECRET is required for the V2 ingestion endpoint');
    const ids:string[]=[];
    for(const record of selected){
      const response=await fetch(new URL('/api/internal/v2/ingestion/repositories/upsert',target),{
        method:'POST',headers:{'Content-Type':'application/json','X-Internal-Secret':process.env.INTERNAL_API_SECRET},
        body:JSON.stringify({repositories:[record]}),signal:AbortSignal.timeout(45000),
      });
      if(!response.ok){await response.body?.cancel();throw new Error(`ingestion_http_${response.status}`);}
      const result=await response.json() as {data?:{mappings?:Array<{repo_id:string}>};mappings?:Array<{repo_id:string}>};
      const repoId=(result.data?.mappings??result.mappings)?.[0]?.repo_id;
      if(!repoId)throw new Error('V2 ingestion returned no canonical mapping');
      ids.push(repoId);console.log(JSON.stringify({status:'ingested',full_name:record.full_name,repo_id:repoId}));
    }
    const service=new ReadmeSummaryService(new OpenRouterReadmeSummaryGenerator());
    for(let index=0;index<ids.length;index++)console.log(JSON.stringify(await service.processOne(ids)));
    const rows=await sqlClient`SELECT repo.repo_id,repo.full_name,digest.summary_id,digest.content_version,digest.model_version,digest.artifact,
      digest.content_hash=content.content_hash AND digest.content_version=content.content_version AS current_source
      FROM app.repos repo JOIN app.repo_content content USING(repo_id)
      LEFT JOIN app.repo_readme_summaries digest ON digest.repo_id=repo.repo_id AND digest.active
      WHERE repo.repo_id=ANY(${ids}::uuid[]) ORDER BY repo.full_name`;
    const after=Number((await sqlClient`SELECT count(*) AS n FROM app.repos`)[0].n);
    const report={generated_at:new Date().toISOString(),original_repository_count:originalCount,final_repository_count:after,
      newly_ingested:ids.length,persisted_current_summaries:rows.filter((row)=>row.summary_id&&row.current_source).length,
      source:'Public GitHub repository metadata and complete README via REST API',legacy_table_used:false,
      recommendation_ml_called:false,provider:'OpenRouter',repositories:rows};
    if(reportPath)await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({status:'acceptance_report',new_repositories:ids.length,current_summaries:report.persisted_current_summaries,repository_count:after}));
    if(report.persisted_current_summaries!==count)throw new Error('Some summary jobs did not complete; inspect scoped job statuses and retry after backoff');
  }
} finally {await sqlClient.end({timeout:5});}
