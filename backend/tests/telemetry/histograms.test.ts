import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

test('independent process histograms aggregate cumulative buckets and preserve outcomes', () => {
  const fixture = (values: number[], outcome: string) => {
    const script = `import { observeStage, snapshotHistograms } from './observability/metrics.ts';
      for (const value of ${JSON.stringify(values)}) observeStage('search', 'ml_transport', '${outcome}', value);
      console.log(JSON.stringify(snapshotHistograms()));`;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
      { encoding: 'utf8', cwd: process.cwd() });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as Record<string, {count: number; sum: number; buckets: Record<string, number>}>;
  };
  const first = fixture([5, 100], 'success');
  const second = fixture([10, 300000], 'success');
  const rejected = fixture([1], 'rejected');
  const failed = fixture([2500], 'failure');
  const key = JSON.stringify({ operation: 'search', stage: 'ml_transport', outcome: 'success' });
  const buckets = Object.fromEntries(Object.keys(first[key].buckets).map(bound =>
    [bound, first[key].buckets[bound] + second[key].buckets[bound]]));
  assert.equal(first[key].count + second[key].count, 4);
  assert.equal(first[key].sum + second[key].sum, 300115);
  assert.equal(buckets['5'], 1);
  assert.equal(buckets['10'], 2);
  assert.equal(buckets['100'], 3);
  assert.equal(buckets['+Inf'], 4);
  assert.equal(Object.keys({...first, ...second, ...rejected, ...failed}).length, 3);
});
