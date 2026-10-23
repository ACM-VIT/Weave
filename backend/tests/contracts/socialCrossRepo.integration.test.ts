import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { stopFixtureProcess } from './fixtureProcess.js';
import { MlV2Client } from '../../services/mlService.js';

const mlRoot = process.env.WEAVE_ML_CONTRACT_ROOT;
test('pinned Python HTTP accepts canonical social evidence and returns source scores to the real Node client', {
  skip: !mlRoot, timeout: 45000,
}, async t => {
  assert.ok(mlRoot && path.isAbsolute(mlRoot));
  const release = JSON.parse(await readFile(new URL('../../contracts/ml-contract-release.json', import.meta.url), 'utf8'));
  assert.equal(execFileSync('git', ['rev-parse','HEAD'], { cwd: mlRoot, encoding: 'utf8' }).trim(), release.revision);
  assert.equal(await readFile(path.join(mlRoot,'contracts/ml-v2.openapi.json'),'utf8'),
    await readFile(new URL('../../contracts/ml-v2.openapi.json',import.meta.url),'utf8'));
  const fixture = fileURLToPath(new URL('./socialContractServer.py',import.meta.url));
  const child = spawn(path.join(mlRoot,'.venv/bin/python'), ['-c',
    `import runpy; runpy.run_path(${JSON.stringify(fixture)}, run_name='__main__')`], {
    cwd: mlRoot, env: { ...process.env, APP_ENV: 'development', MIN_ELIGIBLE_REPOSITORIES: '0',
      QDRANT_URL: 'http://127.0.0.1:9', REDIS_URL: 'redis://127.0.0.1:9', INTERNAL_API_SECRET: 'local-social-contract-secret' },
    stdio: ['ignore','pipe','inherit'],
  });
  t.after(() => stopFixtureProcess(child));
  const port = await new Promise<string>((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('Social contract fixture did not bind.')),15000);
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); const match = /SOCIAL_CONTRACT_PORT=(\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]!); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Social fixture exited before readiness.')); });
  });
  const origin = `http://127.0.0.1:${port}`;
  const client = new MlV2Client({ baseUrl: origin, internalSecret: 'local-social-contract-secret',
    timeoutMs: 5000, maxResponseBytes: 100000 });
  const request = { schema_version: 2 as const, generation_id: '00000000-0000-4000-8000-000000000007',
    user_id: '00000000-0000-4000-8000-000000000002', feed_version: 1, limit: 10, context: { cold_start: false }, exclude_repo_ids: [],
    social_candidates: [{ repo_id: '00000000-0000-4000-8000-000000000003', owner_github_id: '123',
      source: 'followed_owner' as const, support: 1, source_score: 0.25 }] };
  const result = await client.generate(request);
  assert.deepEqual(result.items.map(item => [item.repo_id,item.source,item.retrieval_scores]),
    [[request.social_candidates[0]!.repo_id,'social',{ followed_owner: 0.25 }]]);
  assert.equal(result.served_ranker,'heavy');
  for (const source of ['followed_like','co_like','board_topic','adjacent_interest'] as const) {
    const candidate={...request.social_candidates[0]!,source,support:source==='adjacent_interest'?1:2};
    const response=await client.generate({...request,social_candidates:[candidate]});
    assert.deepEqual(response.items[0]!.retrieval_scores,{[source]:0.25});
  }
  const post = (body: unknown, secret = 'local-social-contract-secret') => fetch(`${origin}/api/v2/recommendations/generate`, {
    method: 'POST', headers: { 'content-type':'application/json','x-internal-secret':secret }, body: JSON.stringify(body),
  });
  assert.equal((await post(request,'wrong-secret')).status,401);
  for (const candidate of [
    { ...request.social_candidates[0],owner_github_id:'mutable-handle' },
    { ...request.social_candidates[0],source:'private_board' },
    { ...request.social_candidates[0],support:0 },
    { ...request.social_candidates[0],actor_key:'private-actor' },
  ]) assert.equal((await post({ ...request,social_candidates:[candidate] })).status,422);
  assert.equal((await post({ ...request,social_candidates:Array(101).fill(request.social_candidates[0]) })).status,422);
});
