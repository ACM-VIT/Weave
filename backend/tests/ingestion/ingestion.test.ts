import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';

import type { RepositoryUpsert, RepositoryUpsertResult, TrendingSnapshotInput } from '../../contracts/ingestion.v2.js';
import type { RepositoryPersistencePort } from '../../ports/repositoryPersistencePort.js';
import { IngestionService } from '../../services/ingestionService.js';
import { isRepositoryUpsert } from '../../utils/ingestionValidation.js';
import { planRepositoryObservationBatches } from '../../services/repositoryIngestionBatch.js';
import { assertDisposableDatabase } from '../database/disposableDatabase.js';

class FakeRepoPersistence implements RepositoryPersistencePort {
  async bulkUpsert(input: RepositoryUpsert[]): Promise<RepositoryUpsertResult[]> {
    return input.map((repo) => ({ github_id: repo.github_id, repo_id: '00000000-0000-4000-8000-000000000001', content_version: 1, changed: true }));
  }
  async recordTrendingSnapshot(input: TrendingSnapshotInput) {
    return { snapshot_id: input.snapshot_id, repository_count: input.repositories.length, activated_at: new Date(0).toISOString() };
  }
}

test('ingestion returns canonical mappings keyed by GitHub numeric ID', async () => {
  const service = new IngestionService(new FakeRepoPersistence());
  const results = await service.bulkUpsert([{ github_id: '123', owner_github_id: '456', full_name: 'old/name', owner: 'old', name: 'name',
    url: 'https://github.com/old/name', observed_at: new Date(0).toISOString() }]);
  assert.equal(results[0].github_id, '123');
  assert.match(results[0].repo_id, /^[0-9a-f-]{36}$/);
});

test('ingestion rejects optional values that would deterministically fail DB or strict ML validation', () => {
  const valid = {
    github_id: '123', owner_github_id: '456', full_name: 'owner/name', owner: 'owner', name: 'name',
    url: 'https://github.com/owner/name', observed_at: '2026-07-21T00:00:00.000Z',
    description: null, readme: null, primary_language: null,
    readme_source_path: 'docs/README.md', readme_default_branch: 'main',
    readme_base_url: 'https://raw.githubusercontent.com/owner/name/refs/heads/main/docs/',
    languages: ['TypeScript'], topics: ['recommendations'],
    star_count: 1, fork_count: 0, open_issues_count: 0,
    pushed_at: '2026-07-20T00:00:00+05:30', recent_commits: ['2026-07-19T00:00:00Z'],
  };
  assert.equal(isRepositoryUpsert(valid), true);
  assert.equal(isRepositoryUpsert({ ...valid, owner_github_id: undefined }), false);
  assert.equal(isRepositoryUpsert({ ...valid, owner_github_id: '0' }), false);
  assert.equal(isRepositoryUpsert({ ...valid, owner_github_id: 'owner' }), false);
  assert.equal(isRepositoryUpsert({ ...valid, star_count: -1 }), false);
  assert.equal(isRepositoryUpsert({ ...valid, topics: [''] }), false);
  assert.equal(isRepositoryUpsert({ ...valid, pushed_at: 'not-a-date' }), false);
  assert.equal(isRepositoryUpsert({ ...valid, description: 42 }), false);
  assert.equal(isRepositoryUpsert({ ...valid, readme: 'x'.repeat(1_000_001) }), false);
  assert.equal(isRepositoryUpsert({ ...valid, readme_base_url: 'http://example.com/docs/' }), false);
  assert.equal(isRepositoryUpsert({ ...valid, readme_base_url: 'https://example.com/docs/file' }), false);
  assert.equal(isRepositoryUpsert({
    ...valid,
    readme_base_url: 'https://raw.githubusercontent.com.evil.example/owner/name/refs/heads/main/docs/',
  }), false);
  assert.equal(isRepositoryUpsert({
    ...valid,
    readme_base_url: 'https://user:secret@raw.githubusercontent.com/owner/name/refs/heads/main/docs/',
  }), false);
  assert.equal(isRepositoryUpsert({
    ...valid,
    readme_base_url: 'https://raw.githubusercontent.com/owner/name/refs/heads/main/docs/?token=secret',
  }), false);
  assert.equal(isRepositoryUpsert({ ...valid, readme_source_path: '/README.md' }), false);
  assert.equal(isRepositoryUpsert({ ...valid, readme_source_path: 'docs\\README.md' }), false);
  assert.equal(isRepositoryUpsert({ ...valid, readme_source_path: 'docs/../README.md' }), false);
  assert.equal(isRepositoryUpsert({ ...valid, readme_default_branch: 'release\\v2' }), false);
  assert.equal(isRepositoryUpsert({ ...valid, readme_default_branch: 'release/../main' }), false);
  const sourcePathAtLimit = `docs/${'a'.repeat(1_016)}.md`;
  const branchAtLimit = `release/${'a'.repeat(248)}`;
  const basePrefix = 'https://raw.githubusercontent.com/o/r/refs/heads/main/';
  const baseUrlAtLimit = `${basePrefix}${'a'.repeat(2_048 - basePrefix.length - 1)}/`;
  assert.equal(sourcePathAtLimit.length, 1_024);
  assert.equal(branchAtLimit.length, 256);
  assert.equal(baseUrlAtLimit.length, 2_048);
  assert.equal(isRepositoryUpsert({ ...valid, readme_source_path: sourcePathAtLimit }), true);
  assert.equal(isRepositoryUpsert({ ...valid, readme_default_branch: branchAtLimit }), true);
  assert.equal(isRepositoryUpsert({ ...valid, readme_base_url: baseUrlAtLimit }), true);
  assert.equal(isRepositoryUpsert({ ...valid, readme_source_path: `${sourcePathAtLimit}x` }), false);
  assert.equal(isRepositoryUpsert({ ...valid, readme_default_branch: `${branchAtLimit}x` }), false);
  assert.equal(isRepositoryUpsert({
    ...valid,
    readme_base_url: `${basePrefix}${'a'.repeat(2_048 - basePrefix.length)}/`,
  }), false);
  assert.equal(isRepositoryUpsert({ ...valid, readme_source_path: '' }), false);
  assert.equal(isRepositoryUpsert({ ...valid, full_name: 'owner /name' }), false);
  assert.equal(isRepositoryUpsert({ ...valid, readme_source_path: 'docs/README.md',
    readme_default_branch: 'release/stable',
    readme_base_url: 'https://raw.githubusercontent.com/owner/name/refs/heads/release/stable/docs/' }), true);
  for (const path of ['/README.md', '../README.md', 'docs//README.md', 'docs\\README.md']) {
    assert.equal(isRepositoryUpsert({ ...valid, readme_source_path: path }), false);
  }
  for (const url of [
    'https://example.com/owner/name/refs/heads/main/',
    'https://raw.githubusercontent.com/owner/name/refs/heads/main/?token=secret',
    'https://user:secret@raw.githubusercontent.com/owner/name/refs/heads/main/',
  ]) assert.equal(isRepositoryUpsert({ ...valid, readme_base_url: url }), false);
});

function batchRepository(githubId: string): RepositoryUpsert {
  return { github_id: githubId, owner_github_id: '77200', full_name: `batch-fixture/repo-${githubId}`,
    owner: 'batch-fixture', name: `repo-${githubId}`, url: `https://github.com/batch-fixture/repo-${githubId}`,
    observed_at: '2026-10-21T00:00:00Z', description: 'Initial content.', topics: [' Systems ', 'SYSTEMS'] };
}

function ownedRepository(githubId: string, ownerId: string, owner: string): RepositoryUpsert {
  const repository = batchRepository(githubId);
  const fullName = `${owner}/${repository.name}`;
  return { ...repository, owner_github_id: ownerId, owner, full_name: fullName,
    url: `https://github.com/${fullName}` };
}

test('ingestion planning bounds stages without losing ordered duplicate observations', () => {
  const initial = batchRepository('77201');
  const changed = { ...initial, description: 'Changed content.', observed_at: '2026-10-21T01:00:00Z' };
  const batches = planRepositoryObservationBatches([batchRepository('77202'), initial, changed,
    { ...changed, github_id: '077201', observed_at: '2026-10-21T02:00:00Z' }]);
  assert.equal(batches.flat().length, 4);
  for (const batch of batches) {
    const keys = batch.map(({ repository }) => BigInt(repository.github_id).toString());
    assert.equal(new Set(keys).size, keys.length, 'a set-based INSERT must not touch one conflict key twice');
  }
  assert.deepEqual(batches.flat().map(({ order }) => order), [0, 1, 2, 3],
    'bounded stages must preserve the complete sequential order, not only each ID subsequence');
  const repeated = batches.flat().filter(({ repository }) => BigInt(repository.github_id) === 77201n);
  assert.deepEqual(repeated.map(({ repository }) => repository.description), ['Initial content.', 'Changed content.', 'Changed content.']);
  assert.deepEqual(repeated.map(({ order }) => order), [0, 1, 2]);
  const maximum = planRepositoryObservationBatches(Array.from({ length: 100 }, (_, index) => batchRepository(String(index + 1))));
  assert.equal(maximum.flat().length, 100);
  assert.ok(maximum.every(batch => batch.length <= 25));
  assert.throws(() => planRepositoryObservationBatches([]), /1-100/);
  assert.throws(() => planRepositoryObservationBatches(Array.from({ length: 101 }, () => initial)), /1-100/);
});

test('ingestion stages keep a repeated rename before a later unique-name reuse', () => {
  const initial = batchRepository('101');
  const renamed = { ...initial, full_name: 'batch-fixture/renamed', name: 'renamed' };
  const reuse = { ...initial, github_id: '102' };
  const batches = planRepositoryObservationBatches([initial, renamed, reuse]);
  assert.deepEqual(batches.map(batch => batch.map(({ repository }) => [repository.github_id, repository.full_name])), [
    [['101', initial.full_name]], [['101', renamed.full_name], ['102', initial.full_name]],
  ], 'a later ID must not use a name in an earlier wave than the observation releasing it');
});

test('ingestion staging also bounds README bytes rather than only repository count', () => {
  const batches = planRepositoryObservationBatches(Array.from({ length: 5 }, (_, index) => ({
    ...batchRepository(String(index + 1)), readme: 'x'.repeat(1_000_000),
  })));
  assert.ok(batches.length > 1);
  assert.ok(batches.every(batch => Buffer.byteLength(JSON.stringify(batch.map(value => value.repository))) <= 4 * 1024 * 1024));
  assert.throws(() => planRepositoryObservationBatches([{
    ...batchRepository('1'), readme: 'x'.repeat(4 * 1024 * 1024),
  }]), /byte limit/);
});

test('set-based ingestion preserves versions, owner reconciliation, rollback and snapshot replay', {
  skip: process.env.RUN_DATABASE_INTEGRATION !== '1',
}, async () => {
  assertDisposableDatabase();
  const { sqlClient } = await import('../../db/index.js');
  const { PostgresRepositoryPersistence } = await import('../../adapters/postgresRepositoryPersistence.js');
  const { PostgresFeedPersistence } = await import('../../adapters/postgresFeedPersistence.js');
  const { claimVerifiedGithubProfile } = await import('../../services/socialProfileService.js');
  const persistence = new PostgresRepositoryPersistence();
  const profileId = crypto.randomUUID();
  const followerId = crypto.randomUUID(), claimantId = crypto.randomUUID(), otherClaimantId = crypto.randomUUID();
  const aliasProfileId = crypto.randomUUID();
  const first = batchRepository('77201'), second = batchRepository('77202');
  const changed = { ...first, description: 'Changed content.', observed_at: '2026-10-21T01:00:00Z' };
  const final = { ...changed, star_count: 5, observed_at: '2026-10-21T02:00:00Z' };
  const period = 'batch-fixture';
  try {
    await sqlClient`INSERT INTO app.social_profiles(profile_id,provider,handle,profile_kind)
      VALUES (${profileId}::uuid,'github','batch-fixture','unknown')`;
    const mappings = await persistence.bulkUpsert([second, first, changed, final]);
    assert.deepEqual(mappings.map(row => [row.github_id,row.content_version,row.changed]), [
      ['77201',1,true], ['77201',2,true], ['77201',2,false], ['77202',1,true],
    ]);
    assert.equal((await sqlClient`SELECT provider_subject FROM app.social_profiles
      WHERE profile_id=${profileId}::uuid`)[0].provider_subject, first.owner_github_id);
    const repoId = mappings[0].repo_id;
    assert.equal(Number((await sqlClient`SELECT count(*) AS n FROM app.repo_stat_snapshots
      WHERE repo_id=${repoId}::uuid`)[0].n), 3);
    assert.equal(Number((await sqlClient`SELECT count(*) AS n FROM telemetry.ml_outbox
      WHERE aggregate_id=${repoId}::uuid AND job_type='repo_index'`)[0].n), 2);
    assert.equal((await sqlClient`SELECT description FROM app.repo_content WHERE repo_id=${repoId}::uuid`)[0].description, final.description);

    // Upgrade a historical padded subject in place, not by deleting the followed
    // profile. Canonical ingestion and verified claims must share its identity.
    await sqlClient`INSERT INTO auth.users(id,raw_user_meta_data) VALUES
      (${followerId}::uuid,'{}'::jsonb),(${claimantId}::uuid,'{}'::jsonb),(${otherClaimantId}::uuid,'{}'::jsonb)`;
    await sqlClient`INSERT INTO app.users(user_id,username,status) VALUES
      (${followerId}::uuid,${`batch-follower-${followerId.slice(0,8)}`},'active'),
      (${claimantId}::uuid,${`batch-claimant-${claimantId.slice(0,8)}`},'active'),
      (${otherClaimantId}::uuid,${`batch-other-${otherClaimantId.slice(0,8)}`},'active')`;
    await sqlClient`INSERT INTO app.user_stats(user_id,following_count) VALUES
      (${followerId}::uuid,1),(${claimantId}::uuid,0),(${otherClaimantId}::uuid,0)`;
    await sqlClient`INSERT INTO app.user_feed_state(user_id) VALUES (${followerId}::uuid)`;
    await sqlClient`INSERT INTO app.social_profile_follows(follower_id,profile_id)
      VALUES (${followerId}::uuid,${profileId}::uuid)`;
    await sqlClient`UPDATE app.social_profiles SET provider_subject='077200' WHERE profile_id=${profileId}::uuid`;
    const followerVersion = BigInt((await sqlClient`SELECT feed_version FROM app.user_feed_state
      WHERE user_id=${followerId}::uuid`)[0].feed_version);
    await persistence.bulkUpsert([{ ...final, owner_github_id: '077200' }]);
    const upgraded = (await sqlClient`SELECT profile_id,provider_subject,claimed_by_user_id,status FROM app.social_profiles
      WHERE provider='github' AND ltrim(provider_subject,'0')='77200'`)[0];
    assert.equal(String(upgraded.profile_id),profileId);
    assert.equal(upgraded.provider_subject,'77200');
    assert.equal(upgraded.claimed_by_user_id,null);
    assert.equal(upgraded.status,'active');
    assert.equal(Number((await sqlClient`SELECT count(*) AS n FROM app.social_profile_follows
      WHERE follower_id=${followerId}::uuid AND profile_id=${profileId}::uuid`)[0].n),1);
    assert.ok(BigInt((await sqlClient`SELECT feed_version FROM app.user_feed_state
      WHERE user_id=${followerId}::uuid`)[0].feed_version)>followerVersion);
    assert.deepEqual(new Set(await new PostgresFeedPersistence().listFollowedRepositoryIds(followerId,10)),
      new Set([repoId,mappings[3].repo_id]),'The retained follow must still resolve the numeric owner repositories');

    // The same upgrade through verified claiming keeps the original profile and
    // migrates its follow through the existing, ownership-checked claim path.
    await sqlClient`UPDATE app.social_profiles SET provider_subject='077200',handle='batch-former-fixture'
      WHERE profile_id=${profileId}::uuid`;
    assert.equal(await sqlClient.begin(tx=>claimVerifiedGithubProfile(tx,{
      userId:claimantId,githubId:'77200',githubHandle:'batch-fixture',
    })),profileId);
    assert.equal(Number((await sqlClient`SELECT count(*) AS n FROM app.follows
      WHERE follower_id=${followerId}::uuid AND following_id=${claimantId}::uuid`)[0].n),1);
    await sqlClient`UPDATE app.social_profiles SET provider_subject='077200' WHERE profile_id=${profileId}::uuid`;
    await assert.rejects(sqlClient.begin(tx=>claimVerifiedGithubProfile(tx,{
      userId:otherClaimantId,githubId:'77200',githubHandle:'other-owner-fixture',
    })),/already claimed by another account/);
    await persistence.bulkUpsert([final]);
    const claimed = (await sqlClient`SELECT profile_id,provider_subject,claimed_by_user_id FROM app.social_profiles
      WHERE provider='github' AND ltrim(provider_subject,'0')='77200'`)[0];
    assert.deepEqual([String(claimed.profile_id),claimed.provider_subject,String(claimed.claimed_by_user_id)],
      [profileId,'77200',claimantId]);
    assert.equal(Number((await sqlClient`SELECT count(*) AS n FROM app.follows
      WHERE follower_id=${followerId}::uuid AND following_id=${claimantId}::uuid`)[0].n),1);

    // Ambiguous identified rows must not be merged or transfer either claim.
    await sqlClient`INSERT INTO app.social_profiles(profile_id,provider,provider_subject,handle,claimed_by_user_id)
      VALUES (${aliasProfileId}::uuid,'github','077200','batch-alias-fixture',${otherClaimantId}::uuid)`;
    await assert.rejects(persistence.bulkUpsert([final]),/multiple existing profiles/);
    await assert.rejects(sqlClient.begin(tx=>claimVerifiedGithubProfile(tx,{
      userId:claimantId,githubId:'77200',githubHandle:'batch-fixture',
    })),/multiple existing profiles/);
    const ambiguous = await sqlClient`SELECT profile_id,provider_subject,claimed_by_user_id,status FROM app.social_profiles
      WHERE profile_id IN (${profileId}::uuid,${aliasProfileId}::uuid) ORDER BY provider_subject`;
    assert.deepEqual(ambiguous.map(row=>[String(row.profile_id),row.provider_subject,String(row.claimed_by_user_id),row.status]),
      [[aliasProfileId,'077200',otherClaimantId,'active'],[profileId,'77200',claimantId,'active']]);
    await sqlClient`DELETE FROM app.social_profiles WHERE profile_id=${aliasProfileId}::uuid`;

    const observed4 = '2026-10-21T03:00:00Z', observed5 = '2026-10-21T04:00:00Z';
    await Promise.all([
      persistence.bulkUpsert([{ ...final, observed_at: observed4, star_count: 6 }, { ...second, observed_at: observed4 }]),
      persistence.bulkUpsert([{ ...second, observed_at: observed5 }, { ...final, observed_at: observed5, star_count: 7 }]),
    ]);
    assert.equal(Number((await sqlClient`SELECT content_version FROM app.repo_content WHERE repo_id=${repoId}::uuid`)[0].content_version), 2);
    assert.equal(Number((await sqlClient`SELECT count(*) AS n FROM app.repo_stat_snapshots WHERE repo_id=${repoId}::uuid`)[0].n), 5);

    const snapshot = { snapshot_id: crypto.randomUUID(), period, source: 'fixture', computed_at: final.observed_at,
      repositories: [{ ...final, rank: 0 }, { ...second, rank: 1 }] };
    await persistence.recordTrendingSnapshot(snapshot);
    const jobCount = Number((await sqlClient`SELECT count(*) AS n FROM telemetry.ml_outbox
      WHERE aggregate_id IN (${mappings[0].repo_id}::uuid,${mappings[3].repo_id}::uuid)`)[0].n);
    await persistence.recordTrendingSnapshot(snapshot);
    assert.equal(Number((await sqlClient`SELECT count(*) AS n FROM telemetry.ml_outbox
      WHERE aggregate_id IN (${mappings[0].repo_id}::uuid,${mappings[3].repo_id}::uuid)`)[0].n), jobCount);
    assert.equal(Number((await sqlClient`SELECT count(*) AS n FROM app.trending_snapshot_items
      WHERE snapshot_id=${snapshot.snapshot_id}::uuid`)[0].n), 2);
    await assert.rejects(persistence.recordTrendingSnapshot({ ...snapshot, period: 'other-period' }), /cannot change its period/);
    await assert.rejects(persistence.recordTrendingSnapshot({ ...snapshot, snapshot_id: crypto.randomUUID(),
      repositories: [{ ...final, rank: 0 }, { ...second, rank: 0 }] }), /unique repositories/);
    await assert.rejects(persistence.recordTrendingSnapshot({ ...snapshot, snapshot_id: crypto.randomUUID(),
      repositories: [{ ...final, rank: 0 }, { ...final, github_id: '077201', rank: 1 }] }), /unique repositories/);

    const rolledBack = { ...batchRepository('77203'), rank: 0, score: 'not-a-number' as unknown as number };
    await assert.rejects(persistence.recordTrendingSnapshot({ ...snapshot, snapshot_id: crypto.randomUUID(),
      repositories: [rolledBack] }));
    assert.equal(Number((await sqlClient`SELECT count(*) AS n FROM app.repos WHERE github_id=77203`)[0].n), 0,
      'a failure after repository writes must roll back repository, observation and outbox state');
    assert.deepEqual((await sqlClient`SELECT snapshot_id FROM app.trending_snapshots WHERE period=${period} AND active`)
      .map(row => String(row.snapshot_id)), [snapshot.snapshot_id]);

    // Same handle, different identities, then the original identity again. Every
    // observation must reconcile: caching the first A/H leaves A deleted by B/H.
    await persistence.bulkUpsert([
      ownedRepository('77204', '77210', 'owner-reuse-fixture'),
      ownedRepository('77205', '77211', 'owner-reuse-fixture'),
      ownedRepository('77206', '77210', 'owner-reuse-fixture'),
    ]);
    const ownerStates = await sqlClient`SELECT provider_subject,status FROM app.social_profiles
      WHERE provider='github' AND provider_subject IN ('77210','77211') ORDER BY provider_subject`;
    assert.deepEqual(ownerStates.map(row => [row.provider_subject,row.status]), [['77210','active'],['77211','deleted']]);

    const renamed = { ...final, full_name: 'batch-fixture/renamed', name: 'renamed',
      url: 'https://github.com/batch-fixture/renamed' };
    await persistence.bulkUpsert([final, renamed, { ...final, github_id: '77207' }]);
    assert.deepEqual((await sqlClient`SELECT github_id::text,full_name FROM app.repos
      WHERE github_id IN (77201,77207) ORDER BY github_id`).map(row => [row.github_id,row.full_name]),
    [['77201','batch-fixture/renamed'],['77207',final.full_name]]);

    const caseSnapshotId = 'abcdefab-' + crypto.randomUUID().slice(9);
    const caseResults = await Promise.allSettled([
      persistence.recordTrendingSnapshot({ ...snapshot, snapshot_id: caseSnapshotId.toUpperCase(), period: 'case-upper-fixture',
        repositories: [{ ...ownedRepository('77208', '77212', 'upper-snapshot-fixture'), topics: [], rank: 0 }] }),
      persistence.recordTrendingSnapshot({ ...snapshot, snapshot_id: caseSnapshotId, period: 'case-lower-fixture',
        repositories: [{ ...ownedRepository('77209', '77213', 'lower-snapshot-fixture'), topics: [], rank: 0 }] }),
    ]);
    assert.equal(caseResults.filter(result => result.status === 'fulfilled').length, 1,
      'case aliases must share a snapshot lock and cannot both overwrite different periods');
    const rejected = caseResults.find(result => result.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected');
    assert.match(String(rejected.reason), /cannot change its period/);
    const storedCase = (await sqlClient`SELECT period FROM app.trending_snapshots
      WHERE snapshot_id=${caseSnapshotId}::uuid`)[0].period;
    const winningId = storedCase === 'case-upper-fixture' ? '77208' : '77209';
    assert.deepEqual((await sqlClient`SELECT repo.github_id::text FROM app.trending_snapshot_items item
      JOIN app.repos repo USING(repo_id) WHERE item.snapshot_id=${caseSnapshotId}::uuid`)
      .map(row => row.github_id), [winningId]);
  } finally {
    await sqlClient`DELETE FROM app.trending_snapshots WHERE period IN (${period},'case-upper-fixture','case-lower-fixture')`;
    await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id IN
      (SELECT repo_id FROM app.repos WHERE github_id BETWEEN 77201 AND 77209)`;
    await sqlClient`DELETE FROM app.repos WHERE github_id BETWEEN 77201 AND 77209`;
    await sqlClient`DELETE FROM app.social_profiles WHERE profile_id IN (${profileId}::uuid,${aliasProfileId}::uuid)
      OR (provider='github' AND provider_subject IN ('77200','077200','77210','77211','77212','77213'))`;
    await sqlClient`DELETE FROM app.users WHERE user_id IN (${followerId}::uuid,${claimantId}::uuid,${otherClaimantId}::uuid)`;
    await sqlClient`DELETE FROM auth.users WHERE id IN (${followerId}::uuid,${claimantId}::uuid,${otherClaimantId}::uuid)`;
    await sqlClient.end({ timeout: 1 });
  }
});

test('internal ingestion rejects ambiguous or invented lineage provenance',()=>{
  const repository=batchRepository('77299');
  const observed={...repository,is_fork:true,fork_parent_github_id:'2',fork_family_github_id:'3',
    lineage_source:'github-graphql-repository',lineage_observed_at:'2026-10-21T00:00:00.000001Z'};
  assert.equal(isRepositoryUpsert(observed),true);
  for(const invalid of [{...observed,is_fork:'false'},{...observed,lineage_source:'owner/name'},
    {...observed,lineage_observed_at:undefined},{...observed,lineage_observed_at:'2026-10-21T00:00:00'},
    {...observed,fork_family_github_id:'77299'},{...observed,fork_parent_github_id:'02'},
    {...observed,is_fork:null},{...observed,is_fork:false}])assert.equal(isRepositoryUpsert(invalid),false);
});
