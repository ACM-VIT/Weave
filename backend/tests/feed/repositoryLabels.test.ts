import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotMetrics } from '../../observability/metrics.js';
import { REPOSITORY_LABEL_POLICY as policy, RepositoryLabelService, selectRepositoryLabel, withRepositoryLabels,
  type RepositoryLabelEvidence } from '../../services/repositoryLabelService.js';

const now = Date.parse('2026-10-24T12:00:00Z');
const stamp = (age = 0) => new Date(now - age).toISOString();
const evidence: RepositoryLabelEvidence = { repo_id: 'repo', trending_rank: 3, trending_observed_at: stamp(),
  star_count: 1_000, stats_observed_at: stamp() };

function degradationCounters(): Record<string, number> {
  const counters = snapshotMetrics().counters as Record<string, number>;
  return Object.fromEntries(Object.entries(counters).filter(([key]) => key.startsWith('repository_label_degradation_total:')));
}
function reasonCount(reason: string): number {
  return degradationCounters()[`repository_label_degradation_total:${JSON.stringify([['reason', reason]])}`] ?? 0;
}

test('evidence rules select one label in priority order, with exact rank/count bounds', () => {
  const likes = { repo_id: 'repo', count: 20, rank: 10 };
  assert.equal(selectRepositoryLabel(evidence, now, likes)?.kind, 'trending');
  assert.equal(selectRepositoryLabel({ ...evidence, trending_rank: 10 }, now)?.kind, 'trending');
  for (const rank of [0, -1, 11, 1.5, NaN, Infinity]) {
    assert.equal(selectRepositoryLabel({ ...evidence, trending_rank: rank }, now, likes)?.kind, 'recent_likes');
  }
  assert.equal(selectRepositoryLabel({ ...evidence, trending_rank: 11 }, now, { ...likes, count: 19 })?.kind, 'popular');
  assert.equal(selectRepositoryLabel({ ...evidence, trending_rank: 11 }, now, { ...likes, rank: 11 })?.kind, 'popular');
  assert.equal(selectRepositoryLabel({ repo_id: 'repo' }, now), null, 'retrieval source or all-time likes cannot create evidence');
  assert.equal(selectRepositoryLabel({ ...evidence, trending_rank: null, star_count: 999 }, now), null);
});

test('stale, future and malformed evidence expires, with strict expiry boundaries', () => {
  assert.equal(selectRepositoryLabel({ ...evidence, trending_observed_at: stamp(policy.trendingFreshnessMs - 1) }, now)?.kind, 'trending');
  for (const value of [stamp(policy.trendingFreshnessMs), stamp(-1), 'invalid']) {
    assert.equal(selectRepositoryLabel({ ...evidence, trending_observed_at: value }, now)?.kind, 'popular');
  }
  assert.equal(selectRepositoryLabel({ repo_id: 'repo', star_count: 1_000, stats_observed_at: stamp(policy.starsFreshnessMs) }, now), null);
  const likes = { repo_id: 'repo', count: 20, rank: 1 };
  assert.equal(selectRepositoryLabel({ repo_id: 'repo' }, now, likes, now - policy.recentLikesCacheMs), null);
  const label = selectRepositoryLabel(evidence, now)!;
  assert.equal(label.expires_at, stamp(-policy.trendingFreshnessMs));
});

test('batched service coalesces global likes, reuses bounded cache, refreshes after expiry', async () => {
  let time = now, globalCalls = 0;
  const batches: string[][] = [];
  const service = new RepositoryLabelService({
    async repositories(ids) { batches.push(ids); return ids.map(repo_id => ({ repo_id })); },
    async recentLikes() { globalCalls++; return [{ repo_id: 'repo', count: 25, rank: 2 }]; },
  }, () => time);
  const [first] = await Promise.all([service.load(['repo', 'repo']), service.load(['other'])]);
  assert.equal(first.get('repo')?.kind, 'recent_likes');
  assert.equal(globalCalls, 1);
  assert.deepEqual(batches[0], ['repo']);
  await service.load(['repo']);
  assert.equal(globalCalls, 1);
  time += policy.recentLikesCacheMs;
  await service.load(['repo']);
  assert.equal(globalCalls, 2);
});

test('optional timeout retains physical admission until stalled queries finish', async () => {
  const timeoutsBefore = reasonCount('request_timeout');
  const admissionBefore = reasonCount('admission_rejected');
  let finish!: (value: RepositoryLabelEvidence[]) => void;
  const stalled = new Promise<RepositoryLabelEvidence[]>(resolve => { finish = resolve; });
  let queries = 0;
  const service = new RepositoryLabelService({
    repositories() { queries++; return stalled; }, async recentLikes() { return []; },
  }, () => now);
  const pages = await Promise.all(Array.from({ length: policy.concurrentLoads }, () => service.load(['repo'])));
  assert.ok(pages.every(page => page.size === 0));
  assert.equal((await service.load(['repo'])).size, 0);
  assert.equal(queries, policy.concurrentLoads, 'HTTP timeout must not reopen physical query admission');
  assert.equal(reasonCount('request_timeout') - timeoutsBefore, policy.concurrentLoads);
  assert.equal(reasonCount('admission_rejected') - admissionBefore, 1);
  finish([evidence]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await service.load(['repo'])).get('repo')?.kind, 'trending');
  assert.equal(reasonCount('request_timeout') - timeoutsBefore, policy.concurrentLoads,
    'successful completion after physical release must clear the observer timeout');
});

test('diagnostics distinguish successful empty evidence from source failures without retaining exception details', async () => {
  const healthy = new RepositoryLabelService({ async repositories() { return []; }, async recentLikes() { return []; } }, () => now);
  const beforeHealthy = degradationCounters();
  assert.equal((await healthy.load(['repo'])).size, 0);
  assert.deepEqual(degradationCounters(), beforeHealthy, 'no qualifying data is a healthy result, not an outage');

  const repositoryBefore = reasonCount('repository_source_failure');
  const likesBefore = reasonCount('recent_likes_source_failure');
  const timeoutBefore = reasonCount('request_timeout');
  const failed = new RepositoryLabelService({
    async repositories() { throw new Error('private-repo-secret'); },
    async recentLikes() { throw new Error('private-database-secret'); },
  }, () => now);
  assert.equal((await failed.load(['private-repo-secret'])).size, 0);
  assert.equal(reasonCount('repository_source_failure') - repositoryBefore, 1);
  assert.equal(reasonCount('recent_likes_source_failure') - likesBefore, 1);
  assert.equal(reasonCount('request_timeout'), timeoutBefore, 'source rejection is not an observer timeout');
  assert.equal((await failed.load(['private-repo-secret'])).size, 0);
  assert.equal(reasonCount('repository_source_failure') - repositoryBefore, 2);
  assert.equal(reasonCount('recent_likes_source_failure') - likesBefore, 1, 'aggregate retry backoff avoids duplicate source-failure counts');
  const serialized = JSON.stringify(degradationCounters());
  assert.equal(serialized.includes('private-repo-secret'), false);
  assert.equal(serialized.includes('private-database-secret'), false);
});

test('optional source failure preserves available evidence; enrichment copies and fails open', async () => {
  const service = new RepositoryLabelService({ async repositories() { return [evidence]; },
    async recentLikes() { throw new Error('optional aggregate unavailable'); } }, () => now);
  assert.equal((await service.load(['repo'])).get('repo')?.kind, 'trending');
  const rows = [{ repo_id: 'repo', likes_count: 3 }];
  assert.deepEqual(await withRepositoryLabels(rows, async () => { throw new Error('unavailable'); }),
    [{ repo_id: 'repo', likes_count: 3, label: null }]);
  assert.deepEqual(rows, [{ repo_id: 'repo', likes_count: 3 }]);
});
