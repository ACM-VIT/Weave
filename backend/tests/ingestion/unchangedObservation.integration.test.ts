import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import type { RepositoryUpsert } from '../../contracts/ingestion.v2.js';
import { assertDisposableDatabase } from '../database/disposableDatabase.js';

test('unchanged and stats-only observations preserve content/topic tuples and deduplicate equivalent jobs', {
  skip: process.env.RUN_DATABASE_INTEGRATION !== '1', timeout: 30_000,
}, async t => {
  assertDisposableDatabase();
  const [{ sqlClient }, { PostgresRepositoryPersistence }] = await Promise.all([
    import('../../db/index.js'), import('../../adapters/postgresRepositoryPersistence.js'),
  ]);
  const persistence = new PostgresRepositoryPersistence();
  const suffix = crypto.randomUUID().slice(0, 8);
  const numeric = BigInt(`0x${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`) + 900_000_000_000_000n;
  const owner = `noop-fixture-${suffix}`;
  const first: RepositoryUpsert = {
    github_id: String(numeric), owner_github_id: String(numeric + 1n),
    full_name: `${owner}/repository`, owner, name: 'repository',
    url: `https://github.com/${owner}/repository`, description: 'A repository for observation acceptance.',
    languages: ['TypeScript'], topics: [`${suffix}-systems`, `${suffix}-cache`], star_count: 1,
    observed_at: '2026-10-21T00:00:00Z',
  };
  let repoId: string | undefined;
  const snapshotId = crypto.randomUUID();
  t.after(async () => {
    try {
      await sqlClient`DELETE FROM app.trending_snapshots WHERE snapshot_id=${snapshotId}::uuid`;
      if (repoId) {
        await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${repoId}::uuid`;
        await sqlClient`DELETE FROM app.repos WHERE repo_id=${repoId}::uuid`;
      }
      await sqlClient`DELETE FROM app.topics topic
        WHERE topic.slug::text=ANY(${[...first.topics!, `${suffix}-new-topic`]}::text[])
          AND NOT EXISTS(SELECT 1 FROM app.repo_topics membership WHERE membership.topic_id=topic.topic_id)`;
      await sqlClient`DELETE FROM app.social_profiles WHERE provider='github'
        AND provider_subject=${first.owner_github_id} AND claimed_by_user_id IS NULL`;
    } finally { await sqlClient.end({ timeout: 1 }); }
  });
  const state = async () => {
    const content = (await sqlClient`SELECT content_version,xmin::text AS tuple,description
      FROM app.repo_content WHERE repo_id=${repoId!}::uuid`)[0];
    const topics = await sqlClient`SELECT topic.slug,membership.xmin::text AS tuple
      FROM app.repo_topics membership JOIN app.topics topic USING(topic_id)
      WHERE membership.repo_id=${repoId!}::uuid ORDER BY topic.slug`;
    const counts = (await sqlClient`SELECT
      count(*) FILTER (WHERE job_type='repo_index')::int AS indexes,
      count(*) FILTER (WHERE job_type='repo_refresh')::int AS refreshes
      FROM telemetry.ml_outbox WHERE aggregate_id=${repoId!}::uuid`)[0];
    const snapshots = Number((await sqlClient`SELECT count(*)::int AS count
      FROM app.repo_stat_snapshots WHERE repo_id=${repoId!}::uuid`)[0].count);
    const jobs = await sqlClient`SELECT idempotency_key,payload FROM telemetry.ml_outbox
      WHERE aggregate_id=${repoId!}::uuid ORDER BY idempotency_key`;
    return { content, topics: [...topics], counts, snapshots, jobs: [...jobs] };
  };
  const [created] = await persistence.bulkUpsert([first]); repoId = created.repo_id;
  assert.equal(created.changed, true);
  const original = await state();
  const [replay] = await persistence.bulkUpsert([first]);
  assert.equal(replay.changed, false);
  assert.deepEqual(await state(), original, 'an identical observation must perform no logical or tuple rewrite');
  await persistence.bulkUpsert([{ ...first, topics: [...first.topics!].reverse().concat(first.topics![0].toUpperCase()) }]);
  assert.deepEqual(await state(), original, 'canonical topic order/case/duplicates must not create a content change');

  const stats = { ...first, observed_at: '2026-10-21T01:00:00Z', star_count: 42 };
  const [statsOnly] = await persistence.bulkUpsert([stats]);
  assert.equal(statsOnly.changed, false);
  const observed = await state();
  assert.deepEqual(observed.content, original.content);
  assert.deepEqual(observed.topics, original.topics);
  assert.equal(observed.snapshots, original.snapshots + 1);
  const [savedStats] = await sqlClient`SELECT star_count FROM app.repo_stat_snapshots
    WHERE repo_id=${repoId!}::uuid AND observed_at=${stats.observed_at}::timestamptz`;
  assert.ok(savedStats, 'the exact observation timestamp must persist');
  assert.equal(Number(savedStats.star_count), stats.star_count);
  assert.equal(observed.counts.indexes, original.counts.indexes);
  assert.equal(observed.counts.refreshes, Number(original.counts.refreshes) + 1);
  await persistence.bulkUpsert([stats]);
  assert.deepEqual(await state(), observed, 'retrying stats must reuse the same observation and refresh key');
  const snapshot = { snapshot_id: snapshotId, period: `noop-fixture-${suffix}`, source: 'fixture',
    computed_at: stats.observed_at, repositories: [{ ...stats, rank: 0 }] };
  await persistence.recordTrendingSnapshot(snapshot);
  assert.deepEqual(await state(), observed, 'equivalent Trending ingestion must retain the same feature version, payload and refresh job');
  await persistence.recordTrendingSnapshot(snapshot);
  assert.deepEqual(await state(), observed, 'snapshot replay must not recreate equivalent refresh work');

  const topicChange = { ...stats, observed_at: '2026-10-21T02:00:00Z', topics: [`${suffix}-new-topic`] };
  const [changed] = await persistence.bulkUpsert([topicChange]);
  assert.equal(changed.changed, true, 'topic-only changes participate in canonical content hashing');
  const revised = await state();
  assert.equal(Number(revised.content.content_version), Number(original.content.content_version) + 1);
  assert.equal(revised.content.description, first.description);
  assert.deepEqual(revised.topics.map(row => row.slug), topicChange.topics);
  assert.equal(revised.counts.indexes, Number(original.counts.indexes) + 1);
  await persistence.bulkUpsert([topicChange]);
  assert.deepEqual(await state(), revised, 'a changed observation becomes a no-op on replay too');
  const previousLifecycleMode = process.env.ML_REPOSITORY_LIFECYCLE_OBSERVATIONS;
  t.after(() => {
    if (previousLifecycleMode === undefined) delete process.env.ML_REPOSITORY_LIFECYCLE_OBSERVATIONS;
    else process.env.ML_REPOSITORY_LIFECYCLE_OBSERVATIONS = previousLifecycleMode;
  });
  process.env.ML_REPOSITORY_LIFECYCLE_OBSERVATIONS = 'verified-status-v1';
  const lifecycle = { status: 'verified' as const, source: 'github-graphql-repository' as const,
    observed_at: '2026-10-21T03:00:00Z', archived: true, disabled: false };
  const [statusOnly] = await persistence.bulkUpsert([{ ...topicChange, observed_at: lifecycle.observed_at, lifecycle }]);
  assert.equal(statusOnly.changed, false, 'archive transitions are independent of content');
  const archived = await state();
  assert.deepEqual(archived.content, revised.content);
  assert.equal(archived.counts.indexes, revised.counts.indexes);
  assert.equal(archived.counts.refreshes, Number(revised.counts.refreshes) + 1);
  const lifecycleJobs = archived.jobs.filter(row => row.payload.features?.lifecycle);
  assert.equal(lifecycleJobs.length, 1);
  assert.deepEqual(lifecycleJobs[0].payload.features.lifecycle, lifecycle);
  assert.equal(lifecycleJobs[0].payload.required_content_version, Number(revised.content.content_version));
  t.diagnostic(JSON.stringify({ contentTuplePreservedOnNoopAndStats: true, topicTuplesPreservedOnNoopAndStats: true,
    statsSnapshotsAdded: observed.snapshots - original.snapshots, equivalentRefreshJobsOnReplay: 0,
    topicChangeVersionIncrement: Number(revised.content.content_version) - Number(original.content.content_version) }));
});
