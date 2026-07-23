import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import test from 'node:test';
import jwt from 'jsonwebtoken';

import { sqlClient } from '../../db/index.js';
import { PostgresFeedPersistence } from '../../adapters/postgresFeedPersistence.js';

const integration = process.env.RUN_HTTP_INTEGRATION === '1' ? test : test.skip;
const userId = '00000000-0000-4000-8000-000000000201';
const repoId = '00000000-0000-4000-8000-000000000202';
const sessionId = '00000000-0000-4000-8000-000000000203';
const spoofOwnerUserId = '00000000-0000-4000-8000-000000000204';
const ownerUserId = '00000000-0000-4000-8000-000000000205';

async function seed(): Promise<void> {
  await sqlClient`
    TRUNCATE app.users,app.repos,app.trending_snapshots,telemetry.ml_outbox,telemetry.generation_attempts CASCADE
  `;
  await sqlClient`
    INSERT INTO auth.users (id,raw_user_meta_data) VALUES
      (${userId}::uuid,'{}'::jsonb),
      (${spoofOwnerUserId}::uuid,'{}'::jsonb),
      (${ownerUserId}::uuid,'{}'::jsonb)
    ON CONFLICT DO NOTHING
  `;
  await sqlClient`
    INSERT INTO app.users (
      user_id,username,github_id,github_handle,github_identity_verified_at,status
    ) VALUES
      (${userId}::uuid,'http_test',NULL,'http-viewer',NULL,'active'),
      (${spoofOwnerUserId}::uuid,'http_spoof',NULL,'owner',NULL,'active'),
      (${ownerUserId}::uuid,'http_owner','9001','owner',now(),'active')
  `;
  await sqlClient`INSERT INTO app.user_stats (user_id) VALUES (${userId}::uuid),(${ownerUserId}::uuid)`;
  await sqlClient`INSERT INTO app.user_feed_state (user_id) VALUES (${userId}::uuid)`;
  await sqlClient`
    INSERT INTO app.repos (repo_id,github_id,full_name,owner,name,url,status)
    VALUES (${repoId}::uuid,202,'owner/http-repo','owner','http-repo','https://github.com/owner/http-repo','active')
  `;
  await sqlClient`
    INSERT INTO app.repo_content (repo_id,content_hash,description,languages)
    VALUES (${repoId}::uuid,'http-test','repo','[]'::jsonb)
  `;
  await sqlClient`INSERT INTO app.repo_engagement (repo_id) VALUES (${repoId}::uuid)`;
  await sqlClient`
    INSERT INTO app.trending_snapshots (snapshot_id,period,source,computed_at,complete,active,activated_at)
    VALUES ('00000000-0000-4000-8000-000000000204','test','http',now(),true,true,now())
  `;
  await sqlClient`
    INSERT INTO app.trending_snapshot_items (snapshot_id,position,repo_id)
    VALUES ('00000000-0000-4000-8000-000000000204',0,${repoId}::uuid)
  `;
}

integration('registered v2 HTTP paths complete controlled integration flows', async () => {
  Object.assign(process.env, {
    DB_SCHEMA_V2_READS: 'true',
    DB_SCHEMA_V2_WRITES: 'true',
    FEED_V2: 'true',
    FEED_RESERVATIONS: 'true',
    ML_V2_RECOMMENDATIONS: 'false',
    // The HTTP suite verifies durable outbox writes, not live ML delivery/health.
    ML_FEEDBACK_OUTBOX: 'false',
    ML_QDRANT_ONLY: 'true',
    TRENDING_FALLBACK: 'true',
  });
  const [{ default: app }, { default: redisClient }, { getApplicationRuntime }] = await Promise.all([
    import('../../app.js'), import('../../config/redis.js'), import('../../runtime/applicationRuntime.js'),
  ]);
  await seed();
  await redisClient.flushdb();
  const feedPersistence = new PostgresFeedPersistence();
  await sqlClient`
    INSERT INTO app.follows (follower_id,following_id)
    VALUES (${userId}::uuid,${spoofOwnerUserId}::uuid)
  `;
  assert.deepEqual(
    await feedPersistence.listFollowedRepositoryIds(userId, 10),
    [],
    'an unverified application profile must never impersonate a GitHub repository owner',
  );
  await sqlClient`
    DELETE FROM app.follows
    WHERE follower_id=${userId}::uuid AND following_id=${spoofOwnerUserId}::uuid
  `;
  const server: Server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP integration server did not bind');
  const base = `http://127.0.0.1:${address.port}`;
  const token = jwt.sign({ userId, email: 'test@example.com' }, process.env.JWT_SECRET!);
  const authHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  try {
    const publicShare = await fetch(`${base}/api/v2/repositories/${repoId}/share`);
    assert.equal(publicShare.status, 200);
    const publicShareData = (await publicShare.json()) as { data: { full_name: string; url: string } };
    assert.equal(publicShareData.data.full_name, 'owner/http-repo');
    assert.equal(publicShareData.data.url, 'https://github.com/owner/http-repo');

    const spoofHandle = await fetch(`${base}/api/v2/users/me`, {
      method: 'PATCH', headers: authHeaders, body: JSON.stringify({ github_handle: 'owner' }),
    });
    assert.equal(spoofHandle.status, 400);

    const feedRequestId = crypto.randomUUID();
    const feed = await fetch(`${base}/api/v2/feed`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-request-id': 'http-integration' },
      body: JSON.stringify({ feed_request_id: feedRequestId, session_id: sessionId, limit: 10, cursor: null }),
    });
    assert.equal(feed.status, 200);
    assert.equal(feed.headers.get('x-request-id'), 'http-integration');
    const served = await feed.json() as {
      serve_id: string;
      source: string;
      items: Array<{
        repo_id: string;
        repository: {
          owner_user_id: string | null;
          viewer_follows_owner: boolean;
        };
      }>;
    };
    assert.equal(served.source, 'fallback');
    assert.deepEqual(served.items.map((item) => item.repo_id), [repoId]);
    assert.equal(served.items[0].repository.owner_user_id, ownerUserId);
    assert.equal(served.items[0].repository.viewer_follows_owner, false);

    const interaction = await fetch(`${base}/api/v2/interactions/batch`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{
        event_id: crypto.randomUUID(), schema_version: 2, session_id: sessionId, serve_id: served.serve_id,
        repo_id: repoId, position: 0, event_type: 'like', dwell_ms: null,
        client_occurred_at: new Date().toISOString(), context: {},
      }] }),
    });
    assert.equal(interaction.status, 202);
    assert.equal(Number((await sqlClient`SELECT count(*) AS count FROM telemetry.ml_outbox`)[0].count), 1);

    const feedVersionBeforeFollow = BigInt((await sqlClient`
      SELECT feed_version FROM app.user_feed_state WHERE user_id=${userId}::uuid
    `)[0].feed_version);
    const follow = await fetch(`${base}/api/v2/users/${ownerUserId}/follow`, {
      method: 'PUT', headers: authHeaders,
    });
    assert.equal(follow.status, 204);
    const duplicateFollow = await fetch(`${base}/api/v2/users/${ownerUserId}/follow`, {
      method: 'PUT', headers: authHeaders,
    });
    assert.equal(duplicateFollow.status, 204);
    const feedVersionAfterFollow = BigInt((await sqlClient`
      SELECT feed_version FROM app.user_feed_state WHERE user_id=${userId}::uuid
    `)[0].feed_version);
    assert.equal(feedVersionAfterFollow, feedVersionBeforeFollow + 1n);

    const followedFeed = await fetch(`${base}/api/v2/feed`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        feed_request_id: crypto.randomUUID(), session_id: sessionId, limit: 10, cursor: null,
      }),
    });
    assert.equal(followedFeed.status, 200);
    const followedItems = (await followedFeed.json()) as {
      items: Array<{
        repo_id: string;
        repository: {
          owner_user_id: string | null;
          viewer_follows_owner: boolean;
        };
      }>;
    };
    assert.equal(followedItems.items[0].repository.owner_user_id, ownerUserId);
    assert.equal(followedItems.items[0].repository.viewer_follows_owner, true);
    assert.deepEqual(await feedPersistence.listFollowedRepositoryIds(userId, 10), [repoId]);

    const unfollow = await fetch(`${base}/api/v2/users/${ownerUserId}/follow`, {
      method: 'DELETE', headers: authHeaders,
    });
    assert.equal(unfollow.status, 204);
    const duplicateUnfollow = await fetch(`${base}/api/v2/users/${ownerUserId}/follow`, {
      method: 'DELETE', headers: authHeaders,
    });
    assert.equal(duplicateUnfollow.status, 204);
    const feedVersionAfterUnfollow = BigInt((await sqlClient`
      SELECT feed_version FROM app.user_feed_state WHERE user_id=${userId}::uuid
    `)[0].feed_version);
    assert.equal(feedVersionAfterUnfollow, feedVersionAfterFollow + 1n);

    const likesGiven = await fetch(`${base}/api/v2/users/${userId}/likes-given?limit=100&offset=0`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(likesGiven.status, 200);
    const likedItems = (await likesGiven.json()) as { data: { items: Array<{ repo_id: string; repo_name: string }> } };
    assert.deepEqual(likedItems.data.items.map((item) => item.repo_id), [repoId]);
    assert.equal(likedItems.data.items[0].repo_name, 'http-repo');

    const me = await fetch(`${base}/api/v2/users/me`, { headers: authHeaders });
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as { data: { user_id: string } }).data.user_id, userId);

    const onboard = await fetch(`${base}/api/v2/onboarding`, {
      method: 'PUT', headers: authHeaders,
      body: JSON.stringify({
        bio: 'Integration profile', interests: ['machine-learning'], skills: ['typescript'], tech_stack: ['postgresql'],
      }),
    });
    assert.equal(onboard.status, 200);
    assert.equal(Number((await sqlClient`SELECT count(*) count FROM app.user_topics WHERE user_id=${userId}::uuid`)[0].count), 3);
    const onboardJob = (await sqlClient`SELECT payload FROM telemetry.ml_outbox WHERE job_type='onboard' ORDER BY created_at DESC LIMIT 1`)[0].payload as Record<string, unknown>;
    assert.match(String(onboardJob.job_id), /^[0-9a-f-]{36}$/);
    assert.equal(onboardJob.user_id, userId);
    assert.deepEqual((onboardJob.profile as Record<string, unknown>).interests, ['machine-learning']);
    assert.deepEqual((onboardJob.profile as Record<string, unknown>).skills, ['typescript']);
    assert.deepEqual((onboardJob.profile as Record<string, unknown>).tech_stack, ['postgresql']);

    const invalidUsername = await fetch(`${base}/api/v2/users/me`, {
      method: 'PATCH', headers: authHeaders, body: JSON.stringify({ username: 'invalid username!' }),
    });
    assert.equal(invalidUsername.status, 400);

    const profilePatch = await fetch(`${base}/api/v2/users/me`, {
      method: 'PATCH', headers: authHeaders, body: JSON.stringify({ bio: 'Updated integration profile' }),
    });
    assert.equal(profilePatch.status, 200);
    const patchedJob = (await sqlClient`
      SELECT payload FROM telemetry.ml_outbox WHERE job_type='onboard' ORDER BY created_at DESC LIMIT 1
    `)[0].payload as Record<string, unknown>;
    assert.deepEqual((patchedJob.profile as Record<string, unknown>).interests, ['machine-learning']);
    assert.deepEqual((patchedJob.profile as Record<string, unknown>).skills, ['typescript']);
    assert.deepEqual((patchedJob.profile as Record<string, unknown>).tech_stack, ['postgresql']);

    const comment = await fetch(`${base}/api/v2/repositories/${repoId}/comments`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ body: 'Useful repository' }),
    });
    assert.equal(comment.status, 201);
    const commentId = ((await comment.json()) as { data: { comment_id: string } }).data.comment_id;
    assert.match(commentId, /^[0-9a-f-]{36}$/);
    const comments = await fetch(`${base}/api/v2/repositories/${repoId}/comments`, { headers: authHeaders });
    assert.equal(comments.status, 200);
    const commentItems = (await comments.json()) as { data: { items: Array<{ comment_id: string; repo_id: string; body: string }> } };
    assert.equal(commentItems.data.items[0].comment_id, commentId);
    assert.equal(commentItems.data.items[0].repo_id, repoId);
    assert.equal(commentItems.data.items[0].body, 'Useful repository');

    const collection = await fetch(`${base}/api/v2/collections`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ name: 'Research', icon: '🔬', color: '#5E5CE6' }),
    });
    assert.equal(collection.status, 201);
    const collectionData = ((await collection.json()) as { data: { collection_id: string; icon: string; color: string } }).data;
    const collectionId = collectionData.collection_id;
    assert.equal(collectionData.icon, '🔬');
    assert.equal(collectionData.color, '#5E5CE6');
    const collectionSave = await fetch(`${base}/api/v2/collections/save`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ repositoryId: repoId, collectionIds: [collectionId] }),
    });
    assert.equal(collectionSave.status, 200);
    const collectionSaveData = (await collectionSave.json()) as { data: { saved: boolean; collection_ids: string[] } };
    assert.equal(collectionSaveData.data.saved, true);
    assert.deepEqual(collectionSaveData.data.collection_ids, [collectionId]);
    const collectionsForRepo = await fetch(`${base}/api/v2/collections?repository_id=${repoId}`, { headers: authHeaders });
    assert.equal(collectionsForRepo.status, 200);
    const collectionItems = (await collectionsForRepo.json()) as { data: { items: Array<{ collection_id: string; repo_count: number; selected: boolean }> } };
    assert.equal(collectionItems.data.items[0].collection_id, collectionId);
    assert.equal(collectionItems.data.items[0].repo_count, 1);
    assert.equal(collectionItems.data.items[0].selected, true);
    const board = await fetch(`${base}/api/v2/boards`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ name: 'Read later', visibility: 'private', collection_id: collectionId }),
    });
    assert.equal(board.status, 201);
    const boardId = ((await board.json()) as { data: { board_id: string } }).data.board_id;
    const saveEvent = {
      event_id: crypto.randomUUID(), schema_version: 2, session_id: sessionId, serve_id: served.serve_id,
      repo_id: repoId, position: 0, event_type: 'save', dwell_ms: null,
      client_occurred_at: new Date().toISOString(), context: { client: 'http-integration' },
    };
    const addRepo = await fetch(`${base}/api/v2/boards/${boardId}/repositories/${repoId}`, {
      method: 'PUT', headers: authHeaders, body: JSON.stringify({ event: saveEvent }),
    });
    assert.equal(addRepo.status, 204);
    const duplicateAdd = await fetch(`${base}/api/v2/boards/${boardId}/repositories/${repoId}`, {
      method: 'PUT', headers: authHeaders, body: JSON.stringify({ event: saveEvent }),
    });
    assert.equal(duplicateAdd.status, 204);
    assert.equal(Number((await sqlClient`
      SELECT count(*) AS count FROM app.saves WHERE user_id=${userId}::uuid AND repo_id=${repoId}::uuid
    `)[0].count), 1);
    assert.equal(Number((await sqlClient`
      SELECT saves_count FROM app.repo_engagement WHERE repo_id=${repoId}::uuid
    `)[0].saves_count), 1);
    assert.equal(Number((await sqlClient`
      SELECT saved_repos_count FROM app.user_stats WHERE user_id=${userId}::uuid
    `)[0].saved_repos_count), 1);
    assert.equal(Number((await sqlClient`
      SELECT count(*) AS count FROM telemetry.interaction_events WHERE event_id=${saveEvent.event_id}::uuid
    `)[0].count), 1);
    assert.equal(Number((await sqlClient`
      SELECT count(*) AS count FROM telemetry.ml_outbox WHERE idempotency_key=${`feedback:${saveEvent.event_id}`}
    `)[0].count), 1);
    const boardRepos = await fetch(`${base}/api/v2/boards/${boardId}/repositories`, { headers: authHeaders });
    assert.equal(boardRepos.status, 200);
    assert.equal(((await boardRepos.json()) as { data: { items: unknown[] } }).data.items.length, 1);
    const savedRepos = await fetch(`${base}/api/v2/repositories/saved`, { headers: authHeaders });
    assert.equal(savedRepos.status, 200);
    assert.deepEqual(
      ((await savedRepos.json()) as { data: { items: Array<{ repo_id: string }> } }).data.items.map((item) => item.repo_id),
      [repoId],
    );

    const legacy = await fetch(`${base}/api/users/id/${userId}`, { headers: authHeaders });
    assert.equal(legacy.status, 404);

    const ingestion = await fetch(`${base}/api/internal/v2/ingestion/repositories/upsert`, {
      method: 'POST', headers: { 'x-internal-secret': process.env.INTERNAL_API_SECRET!, 'content-type': 'application/json' },
      body: JSON.stringify({ repositories: [{
        github_id: '303', full_name: 'owner/ingested', owner: 'owner', name: 'ingested',
        url: 'https://github.com/owner/ingested', description: 'ingested', languages: [], topics: [],
        star_count: 1, fork_count: 0, observed_at: new Date().toISOString(),
      }] }),
    });
    assert.equal(ingestion.status, 200);
    const ingested = await ingestion.json() as { mappings: Array<{ github_id: number; repo_id: string }> };
    assert.equal(ingested.mappings[0].github_id, '303');
    assert.match(ingested.mappings[0].repo_id, /^[0-9a-f-]{36}$/);

    const status = await fetch(`${base}/api/internal/v2/operations/status`, {
      headers: { 'x-internal-secret': process.env.INTERNAL_API_SECRET! },
    });
    assert.equal(status.status, 200);
    const body = await status.json() as { healthy: boolean; outbox: { dead: number } };
    assert.equal(body.healthy, true);
    assert.equal(body.outbox.dead, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await getApplicationRuntime().supervisor.stop();
    await Promise.allSettled([redisClient.quit(), sqlClient.end({ timeout: 1 })]);
  }
});
