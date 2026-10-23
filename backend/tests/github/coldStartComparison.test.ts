import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compareColdStartRuns } from '../../services/coldStartComparison.js';
import { exportColdStartContexts } from '../../services/coldStartContextExport.js';
import { coldStartComparisonInput as input } from '../fixtures/coldStartComparisonInput.js';
const hash = '1'.repeat(64), otherHash = '2'.repeat(64), repo = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Contract fixtures test report binding/arithmetic, not model execution/quality.
function evidence() {
  return { schema_version: 1, corpus_repo_ids: [repo(10), repo(11), repo(12)], corpus_sha256: hash,
    encoder: { model: 'all-MiniLM-L6-v2', revision: 'c9745ed1d9f207416be6d2e6f8de32d1f16199bf', dimension: 384 },
    conditions: exportColdStartContexts(input).variants.map((context, index) => ({ variant: context.variant, context_sha256: context.context_sha256,
      corpus_sha256: hash, synthesized_context_sha256: hash, profile_vector_sha256: hash, execution: {
        format: 'frozen-model-stages-v1', bundle_sha256: hash, snapshot_sha256: hash, artifacts: { model_sha256: hash, scaler_sha256: hash, manifest_sha256: hash },
        source_sha256: { 'actual.py': hash }, code_commit: 'a'.repeat(40), source_tree_dirty: false, as_of: input.cutoff, seed: 'fixed-source-fixture',
        configuration: { limit: 3, runtime: { retrieval_executor: { workers: 2, capacity: 4, running: 0, stages: {} }, shape_calls_by_profile: { fixture: 1 } } }, libraries: { qdrant_client: 'fixture' }, execution_scope: 'offline-local-qdrant-exact-cpu',
        run: { model_sha256: hash, scaler_sha256: hash, manifest_sha256: hash, code_commit: 'a'.repeat(40), timing_kind: 'measured', outputs: [{
              profile_id: input.profile_id, latency_ms: { retrieval: 1, ranking: 2, assembly: 3 }, stages: Object.fromEntries(['retrieval', 'ranking', 'assembly'].map(stage => [stage,
                [10 + index, 10 + (index + 1) % 3].map((id, position) => ({ repo_id: repo(id), score: 0.8 - position / 10, source: 'semantic' }))]))
            }] }
      } })), };
}
test('three actual-input conditions retain canonical context/provenance and compare measured ranking overlap', () => {
  const report = compareColdStartRuns(input, evidence(), 2);
  assert.equal(report.results.length, 3);
  assert.equal(report.production_qualified, false);
  assert.equal(report.source_kind, 'controlled_fixture');
  assert.deepEqual(report.results.map(row => row.variant), ['onboarding_only', 'github_only', 'combined']);
  assert.equal(report.pairwise[0].stages.assembly.shared_top_k, 1);
  assert.equal(report.pairwise[0].stages.assembly.jaccard, 1 / 3);
  assert.equal(report.pairwise[0].stages.assembly.same_rank_positions, 0);
  assert.equal(report.results[0].provenance.github_sources, null);
  assert.match(report.evidence_limit, /not real-user/);
});
for (const mutation of ['context', 'corpus', 'artifact', 'source', 'time', 'seed', 'duplicate-condition', 'unknown-repo', 'duplicate-repo', 'nonfinite', 'timing', 'executor-capacity'] as const) {
  test(`comparison rejects incompatible ${mutation} evidence rather than manufacturing a comparison`, () => {
    const value = evidence(), row = value.conditions[1];
    switch (mutation) {
      case 'context':
        row.context_sha256 = otherHash;
        break;
      case 'corpus':
        row.corpus_sha256 = otherHash;
        break;
      case 'artifact':
        row.execution.artifacts.model_sha256 = otherHash;
        break;
      case 'source':
        row.execution.source_sha256['actual.py'] = otherHash;
        break;
      case 'time':
        row.execution.as_of = '2026-10-24T00:00:00Z';
        break;
      case 'seed':
        row.execution.seed = 'different';
        break;
      case 'duplicate-condition':
        row.variant = 'onboarding_only';
        break;
      case 'unknown-repo':
        row.execution.run.outputs[0].stages.assembly[0].repo_id = repo(99);
        break;
      case 'duplicate-repo':
        row.execution.run.outputs[0].stages.assembly[1].repo_id = row.execution.run.outputs[0].stages.assembly[0].repo_id;
        break;
      case 'nonfinite':
        row.execution.run.outputs[0].stages.assembly[0].score = NaN;
        break;
      case 'timing':
        row.execution.run.timing_kind = 'estimated';
        break;
      case 'executor-capacity':
        row.execution.configuration.runtime.retrieval_executor.capacity = 5;
        break;
    }
    assert.throws(() => compareColdStartRuns(input, value), /incomparable/);
  });
}
test('measured executor counters vary without changing fixed worker/capacity settings', () => {
  const value = evidence();
  value.conditions[1].execution.configuration.runtime.retrieval_executor.running = 1;
  value.conditions[1].execution.configuration.runtime.shape_calls_by_profile.fixture = 2;
  assert.equal(compareColdStartRuns(input, value).results.length, 3);
});
test('maintained CLI writes a private comparison without database/network or overwriting an artifact', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'weave-cold-start-'));
  try {
    const source = path.join(directory, 'input.json'), runs = path.join(directory, 'runs.json'), output = path.join(directory, 'report.json');
    await writeFile(source, JSON.stringify(input));
    await writeFile(runs, JSON.stringify(evidence()));
    const args = ['--import', path.resolve('node_modules/tsx/dist/loader.mjs'), path.resolve('scripts/compare-cold-start-profiles.ts'),
      '--input', source, '--runs', runs, '--output', output];
    const options = { cwd: directory, env: { ...process.env, DATABASE_URL: '' }, encoding: 'utf8' as const, stdio: 'pipe' as const };
    assert.match(execFileSync(process.execPath, args, options), /production_qualified=false/);
    assert.equal(JSON.parse(await readFile(output, 'utf8')).results.length, 3);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.throws(() => execFileSync(process.execPath, args, options), /EEXIST/);
  }
  finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('actual ML-owned cached-encoder/stage fixture satisfies the maintained comparison contract', {
  skip: process.env.RUN_COLD_START_COMPARISON !== '1',
}, async () => {
  const runs = JSON.parse(await readFile(process.env.COLD_START_RUNS!, 'utf8'));
  const result = compareColdStartRuns(input, runs);
  assert.equal(result.results.length, 3);
  assert.ok(result.results.every(row => row.ranked.assembly.length > 0));
});
