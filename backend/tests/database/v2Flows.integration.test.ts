import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { Redis } from 'ioredis';

import { sqlClient } from '../../db/index.js';
import { processInteractionBatchV2 } from '../../services/activityV2Service.js';
import { OutboxService } from '../../services/outboxService.js';
import { DataReconciliationService } from '../../services/dataReconciliationService.js';
import { PostgresFeedPersistence } from '../../adapters/postgresFeedPersistence.js';
import { PostgresRepositoryPersistence } from '../../adapters/postgresRepositoryPersistence.js';
import { RedisFeedQueue } from '../../redis/feedQueue.js';
import { FeedV2Service } from '../../services/feedV2Service.js';
import { ensureIdentityProfile } from '../../services/identityService.js';
import type { InteractionEventV2 } from '../../contracts/interactions.v2.js';

const integration = process.env.RUN_DATABASE_INTEGRATION === '1' ? test : test.skip;
const userId = '00000000-0000-4000-8000-000000000101';
const repoId = '00000000-0000-4000-8000-000000000102';
const sessionId = '00000000-0000-4000-8000-000000000103';
const claimantId = '00000000-0000-4000-8000-000000000105';
const externalProfileId = '00000000-0000-4000-8000-000000000106';

test.after(async () => {
  if (process.env.RUN_DATABASE_INTEGRATION === '1') await sqlClient.end({ timeout: 1 });
});

function event(eventType: InteractionEventV2['event_type'], eventId = crypto.randomUUID()): InteractionEventV2 {
  return {
    event_id: eventId, schema_version: 2, session_id: sessionId, serve_id: null, repo_id: repoId,
    position: null, event_type: eventType, dwell_ms: eventType === 'dwell' ? 3_000 : null,
    client_occurred_at: new Date().toISOString(), context: { test: true },
  };
}

async function seed(): Promise<void> {
  await sqlClient`
    TRUNCATE app.social_profiles,app.users,app.repos,app.trending_snapshots,
      telemetry.ml_outbox,telemetry.generation_attempts CASCADE
  `;
  await sqlClient`
    INSERT INTO auth.users (id,raw_user_meta_data) VALUES
      (${userId}::uuid,${JSON.stringify({ user_name: 'v2_test', full_name: 'V2 Test' })}::jsonb),
      (${claimantId}::uuid,${JSON.stringify({ user_name: 'owner', full_name: 'Owner' })}::jsonb)
    ON CONFLICT (id) DO NOTHING
  `;
  await sqlClient`
    INSERT INTO app.users (user_id,username,status) VALUES
      (${userId}::uuid,'v2_test','active'),
      (${claimantId}::uuid,'owner_user','active')
  `;
  await sqlClient`
    INSERT INTO app.user_stats (user_id,following_count) VALUES
      (${userId}::uuid,1),
      (${claimantId}::uuid,0)
  `;
  await sqlClient`
    INSERT INTO app.user_feed_state (user_id) VALUES (${userId}::uuid),(${claimantId}::uuid)
  `;
  await sqlClient`
    INSERT INTO app.social_profiles(profile_id,provider,provider_subject,handle,profile_kind)
    VALUES (${externalProfileId}::uuid,'github','424242','owner','unknown')
  `;
  await sqlClient`
    INSERT INTO app.social_profile_follows(follower_id,profile_id)
    VALUES (${userId}::uuid,${externalProfileId}::uuid)
  `;
  await sqlClient`
    INSERT INTO app.repos (repo_id,github_id,owner_github_id,full_name,owner,name,url,status)
    VALUES (${repoId}::uuid,101,424242,'owner/repo','owner','repo','https://github.com/owner/repo','active')
  `;
  await sqlClient`
    INSERT INTO app.repo_content (repo_id,content_hash,description,languages)
    VALUES (${repoId}::uuid,'test','repo','[]'::jsonb)
  `;
  await sqlClient`INSERT INTO app.repo_engagement (repo_id) VALUES (${repoId}::uuid)`;
  await sqlClient`
    INSERT INTO app.repo_stat_snapshots (repo_id,observed_at,star_count,fork_count)
    VALUES (${repoId}::uuid,now(),10,1)
  `;
  const snapshotId = '00000000-0000-4000-8000-000000000104';
  await sqlClient`
    INSERT INTO app.trending_snapshots (snapshot_id,period,source,computed_at,complete,active,activated_at)
    VALUES (${snapshotId}::uuid,'test','integration',now(),true,true,now())
  `;
  await sqlClient`
    INSERT INTO app.trending_snapshot_items (snapshot_id,position,repo_id)
    VALUES (${snapshotId}::uuid,0,${repoId}::uuid)
  `;
}

integration('v2 database, outbox, and Redis feed flows preserve invariants', async () => {
  await seed();

  await ensureIdentityProfile({
    userId,
    username: 'v2_test',
    onboardingCompleted: true,
  });
  assert.equal(Boolean((await sqlClient`
    SELECT onboarding_completed FROM app.users WHERE user_id=${userId}::uuid
  `)[0].onboarding_completed), false);

  await sqlClient`
    UPDATE app.users SET onboarding_completed=true WHERE user_id=${userId}::uuid
  `;
  await ensureIdentityProfile({
    userId,
    username: 'v2_test',
    onboardingCompleted: false,
  });
  assert.equal(Boolean((await sqlClient`
    SELECT onboarding_completed FROM app.users WHERE user_id=${userId}::uuid
  `)[0].onboarding_completed), true);

  const feedPersistenceBeforeClaim = new PostgresFeedPersistence();
  assert.deepEqual(
    await feedPersistenceBeforeClaim.listFollowedRepositoryIds(userId, 10),
    [repoId],
    'repositories owned by followed external profiles participate in feed generation',
  );
  const feedVersionBeforeClaim = BigInt((await sqlClient`
    SELECT feed_version FROM app.user_feed_state WHERE user_id=${userId}::uuid
  `)[0].feed_version);

  await sqlClient`
    UPDATE app.social_profiles
    SET handle='former-owner',status='deleted'
    WHERE profile_id=${externalProfileId}::uuid
  `;
  await ensureIdentityProfile({
    userId: claimantId,
    username: 'owner_user',
    githubId: '424242',
    githubHandle: 'owner',
    githubIdentityVerified: true,
  });
  const claimedProfile = (await sqlClient`
    SELECT claimed_by_user_id,handle,status FROM app.social_profiles
    WHERE profile_id=${externalProfileId}::uuid
  `)[0];
  assert.equal(String(claimedProfile.claimed_by_user_id), claimantId);
  assert.equal(String(claimedProfile.handle), 'owner');
  assert.equal(String(claimedProfile.status), 'active');
  assert.equal(Number((await sqlClient`
    SELECT count(*) AS count FROM app.social_profile_follows
    WHERE profile_id=${externalProfileId}::uuid
  `)[0].count), 0);
  assert.equal(Number((await sqlClient`
    SELECT count(*) AS count FROM app.follows
    WHERE follower_id=${userId}::uuid AND following_id=${claimantId}::uuid
  `)[0].count), 1);
  assert.equal(Number((await sqlClient`
    SELECT following_count FROM app.user_stats WHERE user_id=${userId}::uuid
  `)[0].following_count), 1);
  assert.equal(Number((await sqlClient`
    SELECT followers_count FROM app.user_stats WHERE user_id=${claimantId}::uuid
  `)[0].followers_count), 1);
  const feedVersionAfterClaim = BigInt((await sqlClient`
    SELECT feed_version FROM app.user_feed_state WHERE user_id=${userId}::uuid
  `)[0].feed_version);
  assert.equal(
    feedVersionAfterClaim,
    feedVersionBeforeClaim + 1n,
    'claim conversion invalidates each affected follower feed',
  );

  // UUID ordering intentionally opposes client ordering. The latest action
  // must win, and feedback versions must follow the submitted sequence.
  const likeThenUnlike = [
    event('like', 'ffffffff-ffff-4fff-8fff-fffffffffff1'),
    event('unlike', '00000000-0000-4000-8000-000000000001'),
  ];
  const orderedResult = await processInteractionBatchV2(userId, likeThenUnlike);
  assert.deepEqual(orderedResult.results.map((result) => result.feedback_version), ['1', '2']);
  assert.equal(Number((await sqlClient`
    SELECT count(*) AS count FROM app.reactions WHERE user_id=${userId}::uuid AND repo_id=${repoId}::uuid
  `)[0].count), 0);
  const persistedVersions = await sqlClient`
    SELECT event_id,feedback_version FROM telemetry.interaction_events
    WHERE event_id IN (${likeThenUnlike[0].event_id}::uuid,${likeThenUnlike[1].event_id}::uuid)
  `;
  const versionByEvent = new Map(persistedVersions.map((row) => [String(row.event_id), String(row.feedback_version)]));
  assert.equal(versionByEvent.get(likeThenUnlike[0].event_id), '1');
  assert.equal(versionByEvent.get(likeThenUnlike[1].event_id), '2');

  const unlikeThenLike = [
    event('unlike', 'ffffffff-ffff-4fff-8fff-fffffffffff2'),
    event('like', '00000000-0000-4000-8000-000000000002'),
  ];
  const reverseResult = await processInteractionBatchV2(userId, unlikeThenLike);
  assert.deepEqual(reverseResult.results.map((result) => result.feedback_version), ['3', '4']);
  assert.equal(String((await sqlClient`
    SELECT reaction FROM app.reactions WHERE user_id=${userId}::uuid AND repo_id=${repoId}::uuid
  `)[0].reaction), 'like');

  const first = event('like');
  const accepted = await processInteractionBatchV2(userId, [first]);
  assert.equal(accepted.accepted, 1);
  assert.equal((await processInteractionBatchV2(userId, [first])).duplicates, 1);

  const impression = event('impression');
  await processInteractionBatchV2(userId, [impression]);
  await processInteractionBatchV2(userId, [impression]);
  assert.equal(Number((await sqlClient`
    SELECT views_count FROM app.repo_engagement WHERE repo_id=${repoId}::uuid
  `)[0].views_count), 1);

  await assert.rejects(processInteractionBatchV2(userId, [{ ...first, event_type: 'dislike' }]), /different content/);
  await Promise.all([
    processInteractionBatchV2(userId, [event('dislike')]),
    processInteractionBatchV2(userId, [event('like')]),
  ]);
  const reactionRows = await sqlClient`
    SELECT reaction FROM app.reactions WHERE user_id=${userId}::uuid AND repo_id=${repoId}::uuid
  `;
  assert.equal(reactionRows.length, 1);
  assert.ok(['like', 'dislike'].includes(String(reactionRows[0].reaction)));

  await new DataReconciliationService().reconcileCounters();
  const counters = await sqlClient`
    SELECT engagement.likes_count,engagement.dislikes_count
    FROM app.repo_engagement engagement WHERE repo_id=${repoId}::uuid
  `;
  assert.equal(Number(counters[0].likes_count) + Number(counters[0].dislikes_count), 1);

  // User-facing ML work must not wait behind an older bulk repository import.
  // Onboarding stays ahead of feedback so a new user's vector exists before
  // their first feedback event reaches the ordered ML consumer.
  await sqlClient`
    INSERT INTO telemetry.ml_outbox (
      job_type,aggregate_id,idempotency_key,payload,created_at
    ) VALUES
      ('repo_index',${repoId}::uuid,'integration:old-repo-index','{"content_version":1}'::jsonb,now()-interval '1 day'),
      ('onboard',${userId}::uuid,'integration:new-onboard','{}'::jsonb,now())
  `;
  const priorityWorker = new OutboxService();
  const [onboardingClaim] = await priorityWorker.claim(1);
  assert.equal(onboardingClaim.job_type, 'onboard');
  await priorityWorker.markDelivered(onboardingClaim);
  const [feedbackClaim] = await priorityWorker.claim(1);
  assert.equal(feedbackClaim.job_type, 'feedback');
  const failedFeedbackVersion = String(feedbackClaim.payload.feedback_version);
  await priorityWorker.markFailed(feedbackClaim, 'transient integration failure', true, 60_000);
  const claimsWhilePredecessorDelayed = await priorityWorker.claim(50);
  assert.equal(claimsWhilePredecessorDelayed.some((row) => row.job_type === 'feedback'
    && row.aggregate_id === userId), false);
  for (const claim of claimsWhilePredecessorDelayed) await priorityWorker.markDelivered(claim);
  await sqlClient`
    UPDATE telemetry.ml_outbox SET available_at=now()
    WHERE outbox_id=${feedbackClaim.outbox_id}::uuid
  `;
  const [retriedFeedback] = await priorityWorker.claim(1);
  assert.equal(retriedFeedback.outbox_id, feedbackClaim.outbox_id);
  assert.equal(String(retriedFeedback.payload.feedback_version), failedFeedbackVersion);
  await priorityWorker.markDelivered(retriedFeedback);
  const [nextFeedback] = await priorityWorker.claim(1);
  assert.equal(nextFeedback.job_type, 'feedback');
  assert.equal(
    BigInt(String(nextFeedback.payload.feedback_version)),
    BigInt(failedFeedbackVersion) + 1n,
  );
  await priorityWorker.markDelivered(nextFeedback);

  await sqlClient`
    INSERT INTO telemetry.ml_outbox(job_type,aggregate_id,idempotency_key,payload)
    VALUES
      ('repo_refresh',${repoId}::uuid,'integration:parallel-refresh:1','{}'::jsonb),
      ('repo_refresh',${repoId}::uuid,'integration:parallel-refresh:2','{}'::jsonb)
  `;
  const firstWorker = new OutboxService();
  const secondWorker = new OutboxService();
  const [claimA, claimB] = await Promise.all([firstWorker.claim(1), secondWorker.claim(1)]);
  assert.equal(claimA.length, 1);
  assert.equal(claimB.length, 1);
  assert.notEqual(claimA[0].outbox_id, claimB[0].outbox_id);
  await firstWorker.markFailed(claimA[0], 'permanent test failure', false);
  await secondWorker.markDelivered(claimB[0]);
  assert.equal(await firstWorker.replay(claimA[0].outbox_id), true);

  const obsoleteId = crypto.randomUUID();
  const contextualId = crypto.randomUUID();
  await sqlClient`
    INSERT INTO telemetry.ml_outbox (outbox_id,job_type,aggregate_id,idempotency_key,payload,status)
    VALUES
      (${obsoleteId}::uuid,'onboard',${userId}::uuid,${`integration:obsolete:${obsoleteId}`},
        ${JSON.stringify({
          job_id: crypto.randomUUID(), user_id: userId, profile_version: 1,
          profile: { username: 'integration-user', bio: null, interests: [], skills: [], tech_stack: [] },
        })}::jsonb,'dead'),
      (${contextualId}::uuid,'onboard',${userId}::uuid,${`integration:contextual:${contextualId}`},
        ${JSON.stringify({
          job_id: crypto.randomUUID(), user_id: userId, profile_version: 2,
          profile: { username: 'integration-user', bio: null, interests: ['typescript'], skills: [], tech_stack: [] },
        })}::jsonb,'dead')
  `;
  assert.equal(await firstWorker.supersedeObsoleteOnboarding(obsoleteId), true);
  assert.equal(await firstWorker.supersedeObsoleteOnboarding(contextualId), false);
  assert.equal(String((await sqlClient`
    SELECT status FROM telemetry.ml_outbox WHERE outbox_id=${obsoleteId}::uuid
  `)[0].status), 'superseded');
  assert.equal(await firstWorker.replay(obsoleteId), false);

  const historicalRepositoryJobId = crypto.randomUUID();
  const successorRepositoryJobId = crypto.randomUUID();
  const unresolvedRepositoryJobId = crypto.randomUUID();
  await sqlClient`
    INSERT INTO telemetry.ml_outbox (
      outbox_id,job_type,aggregate_id,idempotency_key,payload,status,created_at,delivered_at
    ) VALUES
      (${historicalRepositoryJobId}::uuid,'repo_index',${repoId}::uuid,
        ${`integration:historical-repository:${historicalRepositoryJobId}`},'{"content_version":1}'::jsonb,'dead',now()-interval '2 minutes',NULL),
      (${successorRepositoryJobId}::uuid,'repo_index',${repoId}::uuid,
        ${`integration:repository-successor:${successorRepositoryJobId}`},'{"content_version":2}'::jsonb,'delivered',now()-interval '1 minute',now()),
      (${unresolvedRepositoryJobId}::uuid,'repo_refresh',${repoId}::uuid,
        ${`integration:unresolved-repository:${unresolvedRepositoryJobId}`},'{}'::jsonb,'dead',now(),NULL)
  `;
  assert.equal(
    await firstWorker.supersedeRepositoryJobDeliveredBySuccessor(historicalRepositoryJobId),
    true,
  );
  assert.equal(
    await firstWorker.supersedeRepositoryJobDeliveredBySuccessor(unresolvedRepositoryJobId),
    false,
  );
  assert.equal(String((await sqlClient`
    SELECT status FROM telemetry.ml_outbox WHERE outbox_id=${historicalRepositoryJobId}::uuid
  `)[0].status), 'superseded');

  const concurrentPersistence = new PostgresRepositoryPersistence();
  const concurrentBase = {
    github_id: '202',
    owner_github_id: '9001',
    full_name: 'owner/concurrent',
    owner: 'owner',
    name: 'concurrent',
    url: 'https://github.com/owner/concurrent',
    readme: '# Concurrent',
    primary_language: 'TypeScript',
    languages: ['TypeScript'],
    topics: ['concurrency'],
    star_count: 1,
    fork_count: 0,
    open_issues_count: 0,
    observed_at: new Date().toISOString(),
  };
  await Promise.all([
    concurrentPersistence.bulkUpsert([{ ...concurrentBase, description: 'first' }]),
    concurrentPersistence.bulkUpsert([{ ...concurrentBase, description: 'second' }]),
  ]);
  const [concurrentContent] = await sqlClient`
    SELECT content.repo_id,content.description,content.content_version
    FROM app.repo_content content JOIN app.repos repo USING(repo_id)
    WHERE repo.github_id=202
  `;
  assert.equal(Number(concurrentContent.content_version), 2);
  const concurrentJobs = await sqlClient`
    SELECT payload FROM telemetry.ml_outbox
    WHERE aggregate_id=${String(concurrentContent.repo_id)}::uuid AND job_type='repo_index'
    ORDER BY (payload->>'content_version')::int
  `;
  assert.deepEqual(concurrentJobs.map((row) => Number(row.payload.content_version)), [1, 2]);
  assert.equal(
    String(concurrentJobs[1].payload.repository.description),
    String(concurrentContent.description),
  );

  // PostgreSQL invariants can run in an isolated database without requiring a
  // Redis daemon. Enable the final queue/restart section explicitly when the
  // disposable Redis database is available.
  if (process.env.RUN_REDIS_INTEGRATION !== '1') return;

  // The original repository has already been engaged with above. Preserve
  // fallback coverage with an unseen repository rather than bypass exclusions.
  const unseenRepoId = crypto.randomUUID();
  await sqlClient`
    INSERT INTO app.repos (repo_id,github_id,full_name,owner,name,url,status)
    VALUES (${unseenRepoId}::uuid,303,'unseen/repo','unseen','repo','https://github.com/unseen/repo','active')
  `;
  await sqlClient`
    INSERT INTO app.trending_snapshot_items (snapshot_id,position,repo_id)
    VALUES ('00000000-0000-4000-8000-000000000104',1,${unseenRepoId}::uuid)
  `;

  const redis = new Redis(process.env.REDIS_DATABASE_TEST_URL ?? 'redis://127.0.0.1:6379/14', { maxRetriesPerRequest: 1 });
  await redis.flushdb();
  try {
    const queue = new RedisFeedQueue(redis);
    const feed = new FeedV2Service(
      new PostgresFeedPersistence(), queue, undefined, true, 1_500, 25, 'database-integration-feed-cursor-secret',
    );
    const request = { feed_request_id: crypto.randomUUID(), session_id: sessionId, limit: 10, cursor: null };
    const served = await feed.getFeed(userId, request);
    assert.equal(served.source, 'fallback');
    assert.deepEqual(served.items.map((item) => item.repo_id), [unseenRepoId]);
    assert.deepEqual(await feed.getFeed(userId, request), served);

    const version = await new PostgresFeedPersistence().getFeedVersion(userId);
    const recommendation = {
      repo_id: repoId, score: 1, source: 'semantic', model_version: 'integration-model', summary_id: null,
    };
    await queue.replace(userId, version, [recommendation, recommendation], 60);
    const firstPageRequestId = crypto.randomUUID();
    const firstPage = await feed.getFeed(userId, {
      feed_request_id: firstPageRequestId, session_id: sessionId, limit: 1, cursor: null,
    });
    assert.deepEqual(firstPage.items.map((item) => item.position), [0]);
    assert.ok(firstPage.next_cursor);
    const replayedFirstPage = await feed.getFeed(userId, {
      feed_request_id: firstPageRequestId, session_id: sessionId, limit: 1, cursor: null,
    });
    assert.equal(replayedFirstPage.next_cursor, firstPage.next_cursor);
    const secondPage = await feed.getFeed(userId, {
      feed_request_id: crypto.randomUUID(), session_id: sessionId, limit: 1, cursor: firstPage.next_cursor,
    });
    assert.deepEqual(secondPage.items.map((item) => item.position), [1]);
    assert.equal(secondPage.next_cursor, null);
  } finally {
    await redis.flushdb();
    await redis.quit();
  }
});
