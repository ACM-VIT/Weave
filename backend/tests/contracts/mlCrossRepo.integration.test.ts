import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { stopFixtureProcess } from './fixtureProcess.js';
import { MlV2Client } from '../../services/mlService.js';
import type { MlFeedbackBatch, MlRepositoryIndexJob, MlRequest } from '../../contracts/ml.v2.js';

const mlRoot = process.env.WEAVE_ML_CONTRACT_ROOT;

test('real Node client and Python HTTP routes share the pinned V2 contract', { skip: !mlRoot, timeout: 45_000 }, async t => {
  assert.ok(mlRoot && path.isAbsolute(mlRoot), 'Select an explicit provider checkout.');
  assert.equal(await readFile(path.join(mlRoot, 'contracts/ml-v2.openapi.json'), 'utf8'),
    await readFile(new URL('../../contracts/ml-v2.openapi.json', import.meta.url), 'utf8'));
  const release = JSON.parse(await readFile(new URL('../../contracts/ml-contract-release.json', import.meta.url), 'utf8'));
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: mlRoot, encoding: 'utf8' }).trim(), release.revision,
    'Contract fixture must run the pinned provider release.');
  const child = spawn(path.join(mlRoot, '.venv/bin/python'), ['-c',
    "import runpy; runpy.run_path('tests/fixtures/ml_contract_server.py', run_name='__main__')"], {
    cwd: mlRoot, env: { ...process.env, APP_ENV: 'development',
      QDRANT_URL: 'http://127.0.0.1:9', REDIS_URL: 'redis://127.0.0.1:9', INTERNAL_API_SECRET: 'local-contract-secret' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => stopFixtureProcess(child));
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Contract fixture did not bind in time.')), 15_000);
    let output = '';
    child.stdout.on('data', chunk => {
      output += String(chunk);
      const match = /CONTRACT_PORT=(\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]!); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Contract fixture exited before readiness.')); });
  });
  const origin = `http://127.0.0.1:${port}`;
  const client = new MlV2Client({ baseUrl: origin, internalSecret: 'local-contract-secret',
    timeoutMs: 5000, deliveryTimeoutMs: 5000, repositoryIndexTimeoutMs: 5000, maxResponseBytes: 1_000_000 });
  const user = '00000000-0000-4000-8000-000000000002';
  const repo = '00000000-0000-4000-8000-000000000003';
  assert.equal((await client.deliverOnboarding({ job_id: '00000000-0000-4000-8000-000000000004',
    user_id: user, profile_version: 1, profile: { topics: ['typescript'] } })).accepted, true);
  const job: MlRepositoryIndexJob = { job_id: '00000000-0000-4000-8000-000000000005', repo_id: repo, content_version: 1,
    repository: { full_name: 'fixture/typescript', description: 'A TypeScript library for repository discovery. It supports filtering public repositories by topic.',
      content_hash: 'contract-fixture-v1', topics: ['typescript'], languages: ['TypeScript'],
      url: 'https://github.com/fixture/typescript' } };
  const embedded = await client.deliverRepositoryIndex(job);
  assert.equal(embedded.accepted, true, embedded.detail);
  assert.equal(embedded.response_body?.repo_id, repo);
  assert.equal((await client.deliverRepositoryRefresh({ job_id: '00000000-0000-4000-8000-000000000006',
    repo_id: repo, feature_version: 1, features: { star_count: 3 } })).accepted, true);
  const recommendations = await client.generate({ schema_version: 2, generation_id: '00000000-0000-4000-8000-000000000007',
    user_id: user, feed_version: 1, limit: 10, exclude_repo_ids: [], context: { cold_start: false } });
  assert.deepEqual(recommendations.items.map(item => item.repo_id), [repo]);
  assert.equal(recommendations.served_ranker, 'heavy');
  const batch: MlFeedbackBatch = { schema_version: 2, events: [{ event_id: '00000000-0000-4000-8000-000000000008',
    user_id: user, repo_id: repo, feedback_version: '9223372036854775807', event_type: 'like',
    dwell_ms: null, occurred_at: '2026-10-23T00:00:00Z' }] };
  const acknowledged_event_ids = batch.events.map(event => event.event_id);
  assert.deepEqual((await client.deliverFeedback(batch)).response_body, { accepted: 1, duplicates: 0, durable: true, acknowledged_event_ids });
  assert.deepEqual((await client.deliverFeedback(batch)).response_body, { accepted: 0, duplicates: 1, durable: true, acknowledged_event_ids });
  // Impressions are backend telemetry and must never enter online learning.
  const impression = await fetch(`${origin}/api/v2/feedback/batch`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': 'local-contract-secret' },
    body: JSON.stringify({ ...batch, events: [{ ...batch.events[0], event_type: 'impression' }] }) });
  assert.equal(impression.status, 422);
  assert.equal((await new MlV2Client({ baseUrl: origin, internalSecret: 'wrong-secret', timeoutMs: 5000,
    maxResponseBytes: 1_000_000 }).deliverFeedback(batch)).status_code, 401);
});

// Checked during backend test typecheck: path/payload drift cannot compile.
const recommendationPath = '/api/v2/recommendations/generate';
// @ts-expect-error feedback bodies cannot be submitted to the recommendation operation
const incompatible: MlRequest<typeof recommendationPath> = { schema_version: 2, events: [] };
void incompatible;


test('lifecycle refresh crosses real Node/Python routes and local Qdrant without erasing stable projects', {
  skip: !mlRoot, timeout: 45_000,
}, async t => {
  assert.ok(mlRoot && path.isAbsolute(mlRoot));
  const child = spawn(path.join(mlRoot, '.venv/bin/python'), ['-c',
    "import runpy; runpy.run_path('tests/fixtures/lifecycle_contract_server.py', run_name='__main__')"], {
    cwd: mlRoot, env: { ...process.env, APP_ENV: 'development',
      QDRANT_URL: 'http://127.0.0.1:9', REDIS_URL: 'redis://127.0.0.1:9' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => stopFixtureProcess(child));
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Lifecycle fixture did not bind.')), 15_000);
    let output = '';
    child.stdout.on('data', chunk => {
      output += String(chunk);
      const match = /CONTRACT_PORT=(\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]!); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Lifecycle fixture exited.')); });
  });
  const client = new MlV2Client({ baseUrl: `http://127.0.0.1:${port}`, internalSecret: 'local-contract-secret',
    timeoutMs: 5000, deliveryTimeoutMs: 5000, repositoryIndexTimeoutMs: 5000, maxResponseBytes: 1_000_000 });
  const repo = '00000000-0000-4000-8000-000000000003';
  const jobId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const indexed = await client.deliverRepositoryIndex({ job_id: jobId(50), repo_id: repo, content_version: 1,
    repository: { full_name: 'fixture/stable', description: 'Stable repository with a useful mature developer tool.',
      content_hash: 'lifecycle-fixture', pushed_days_ago: 50_000 } });
  assert.equal(indexed.accepted, true, indexed.detail);
  const selected = async () => (await client.generate({ schema_version: 2, generation_id: jobId(99),
    user_id: jobId(2), feed_version: 1, limit: 10, exclude_repo_ids: [], context: { cold_start: true } })).items.map(item => item.repo_id);
  const status = (day: number, archived: boolean) => ({ status: 'verified' as const,
    source: 'github-graphql-repository' as const, observed_at: `2026-01-0${day}T00:00:00Z`, archived, disabled: false });
  assert.deepEqual(await selected(), [repo], 'unknown legacy status and old push age remain eligible');
  for (const [version, lifecycle, expected] of [
    [10, status(2, true), []],
    [11, { status: 'unavailable', source: 'github-graphql-repository', observed_at: '2026-01-04T00:00:00Z' }, []],
    [12, status(1, false), []], [13, status(3, false), [repo]],
  ] as const) {
    const refreshed = await client.deliverRepositoryRefresh({ job_id: jobId(50 + version), repo_id: repo,
      feature_version: version, features: { lifecycle } });
    assert.equal(refreshed.accepted, true, refreshed.detail);
    assert.deepEqual(await selected(), expected);
  }
  assert.equal((await client.deliverRepositoryRefresh({ job_id: jobId(90), repo_id: repo,
    feature_version: 100, features: { star_count: 500 } })).accepted, true);
  assert.equal((await client.deliverRepositoryRefresh({ job_id: jobId(91), repo_id: repo,
    feature_version: 14, features: { lifecycle: status(5, true) } })).accepted, true);
  assert.deepEqual(await selected(), []);
});

// Keep provider's strict capture/decimal pairing visible to the generated client.
const captureBase={schema_version:2 as const,generation_id:'00000000-0000-4000-8000-000000000007',
  user_id:'00000000-0000-4000-8000-000000000002',limit:10,exclude_repo_ids:[],context:{cold_start:false}};
const validCaptured:MlRequest<typeof recommendationPath>={...captureBase,feed_version:'9223372036854775807',
  scoring_capture:{schema_version:1,encoding:'float32-le-v1'}};
// @ts-expect-error captured requests require an exact decimal-string feed version
const invalidCaptureNumber:MlRequest<typeof recommendationPath>={...captureBase,feed_version:1,scoring_capture:{schema_version:1,encoding:'float32-le-v1'}};
// @ts-expect-error decimal feed versions require negotiated capture
const invalidCaptureAbsent:MlRequest<typeof recommendationPath>={...captureBase,feed_version:'1'};
void validCaptured;void invalidCaptureNumber;void invalidCaptureAbsent;
