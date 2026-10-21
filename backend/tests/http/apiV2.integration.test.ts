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
const ownerProfileId = '00000000-0000-4000-8000-000000000206';
const externalProfileId = '00000000-0000-4000-8000-000000000207';
const ingestionCanonicalProfileId = '00000000-0000-4000-8000-000000000208';
const ingestionDuplicateProfileId = '00000000-0000-4000-8000-000000000209';
const renamedIngestionProfileId = '00000000-0000-4000-8000-000000000210';
const recycledHandleProfileId = '00000000-0000-4000-8000-000000000211';

async function seed(): Promise<void> {
  await sqlClient`
    TRUNCATE app.social_profiles,app.users,app.repos,app.trending_snapshots,
      telemetry.ml_outbox,telemetry.generation_attempts CASCADE
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
    INSERT INTO app.social_profiles(
      profile_id,provider,provider_subject,handle,profile_kind,claimed_by_user_id
    ) VALUES
      (${ownerProfileId}::uuid,'github','9001','owner','user',${ownerUserId}::uuid),
      (${externalProfileId}::uuid,'github',NULL,'external-owner','organization',NULL)
  `;
  await sqlClient`
    INSERT INTO app.repos (repo_id,github_id,owner_github_id,full_name,owner,name,url,status)
    VALUES (${repoId}::uuid,202,9001,'owner/http-repo','owner','http-repo','https://github.com/owner/http-repo','active')
  `;
  await sqlClient`
    INSERT INTO app.repo_content (
      repo_id,content_hash,description,readme,readme_source_path,
      readme_default_branch,readme_base_url,primary_language,languages
    ) VALUES (
      ${repoId}::uuid,'http-test','repo','# HTTP Repo\n\nComplete README content.',
      'docs/README.md','main','https://raw.githubusercontent.com/owner/http-repo/refs/heads/main/docs/',
      'TypeScript','["TypeScript","SQL"]'::jsonb
    )
  `;
  await sqlClient`INSERT INTO app.repo_engagement (repo_id) VALUES (${repoId}::uuid)`;
  await sqlClient`
    INSERT INTO app.repo_stat_snapshots (
      repo_id,star_count,fork_count,open_issues_count,observed_at
    ) VALUES (${repoId}::uuid,12,3,2,now())
  `;
  const [topic] = await sqlClient`
    INSERT INTO app.topics(slug,display_name) VALUES('phase-two','Phase Two')
    ON CONFLICT(slug) DO UPDATE SET display_name=EXCLUDED.display_name
    RETURNING topic_id
  `;
  await sqlClient`
    INSERT INTO app.repo_topics(repo_id,topic_id)
    VALUES(${repoId}::uuid,${String(topic.topic_id)}::bigint)
  `;
  await sqlClient`
    INSERT INTO app.repo_card_summaries(
      repo_id,content_version,prompt_version,model_version,format_version,
      summary,highlights,source,active
    ) VALUES(
      ${repoId}::uuid,1,'repo-card-summary-v1','http-summary-v1','repo-card-summary-json-v1',
      'Concise generated repository summary.','["Internal navigation"]'::jsonb,'generated',true
    )
  `;
  await sqlClient`
    INSERT INTO app.trending_snapshots (snapshot_id,period,source,computed_at,complete,active,activated_at)
    VALUES ('00000000-0000-4000-8000-000000000204','daily','http',now(),true,true,now())
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
  // Recommendation fixtures belong to this isolated HTTP test, never the live catalogue.
  const seedRecommendation = async () => getApplicationRuntime().queue.replace(
    userId, await feedPersistence.getFeedVersion(userId),
    [{repo_id:repoId,score:1,source:'semantic',model_version:'http-test-model',summary_id:null}],600,
  );
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

    const unavailable = await fetch(`${base}/api/v2/feed`, {
      method:'POST',headers:authHeaders,body:JSON.stringify({
        feed_request_id:crypto.randomUUID(),session_id:sessionId,limit:10,cursor:null,
      }),
    });
    assert.equal(unavailable.status,503,'Missing ML generations must not invent personalized recommendations');
    await seedRecommendation();
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
          owner_profile_id: string | null;
          viewer_follows_owner: boolean;
          summary_prompt_version: string | null;
          readme_source_path: string | null;
          readme_base_url: string | null;
        };
      }>;
    };
    assert.equal(served.source, 'personalized');
    assert.deepEqual(served.items.map((item) => item.repo_id), [repoId]);
    assert.equal(served.items[0].repository.owner_user_id, ownerUserId);
    assert.equal(served.items[0].repository.owner_profile_id, ownerProfileId);
    assert.equal(served.items[0].repository.viewer_follows_owner, false);
    assert.equal(served.items[0].repository.summary_prompt_version, 'repo-card-summary-v1');
    assert.equal(served.items[0].repository.readme_source_path, 'docs/README.md');
    assert.equal(
      served.items[0].repository.readme_base_url,
      'https://raw.githubusercontent.com/owner/http-repo/refs/heads/main/docs/',
    );
    await sqlClient`
      UPDATE telemetry.feed_serve_items SET summary_id=NULL
      WHERE serve_id=${served.serve_id}::uuid
    `;
    const replayWithLegacyMissingSummary = await feedPersistence.getServeByRequest(userId, feedRequestId);
    assert.match(replayWithLegacyMissingSummary?.items[0].summary_id ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(
      replayWithLegacyMissingSummary?.items[0].repository.summary,
      'Concise generated repository summary.',
    );

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

    const unauthenticatedDetail = await fetch(`${base}/api/v2/repositories/${repoId}`);
    assert.equal(unauthenticatedDetail.status, 401);
    const repositoryDetail = await fetch(`${base}/api/v2/repositories/${repoId}`, { headers: authHeaders });
    assert.equal(repositoryDetail.status, 200);
    const repositoryDetailData = (await repositoryDetail.json()) as {
      data: {
        repo_id: string;
        github_id: string;
        full_name: string;
        owner_user_id: string | null;
        owner_profile_id: string | null;
        owner_display_name: string | null;
        description: string | null;
        summary: string | null;
        summary_highlights: string[];
        summary_prompt_version: string | null;
        summary_format_version: string | null;
        summary_source: string | null;
        readme_md: string | null;
        readme_source_path: string | null;
        readme_default_branch: string | null;
        readme_base_url: string | null;
        languages: string[];
        topics: string[];
        star_count: number;
        fork_count: number;
        open_issues_count: number;
        viewer_reaction: 'like' | 'dislike' | null;
        viewer_saved: boolean;
        selected_list_ids: string[];
      };
    };
    assert.equal(repositoryDetailData.data.repo_id, repoId);
    assert.equal(repositoryDetailData.data.github_id, '202');
    assert.equal(repositoryDetailData.data.full_name, 'owner/http-repo');
    assert.equal(repositoryDetailData.data.owner_user_id, ownerUserId);
    assert.equal(repositoryDetailData.data.owner_profile_id, ownerProfileId);
    assert.equal(repositoryDetailData.data.owner_display_name, 'owner');
    assert.equal(repositoryDetailData.data.description, 'repo');
    assert.equal(repositoryDetailData.data.summary, 'Concise generated repository summary.');
    assert.deepEqual(repositoryDetailData.data.summary_highlights, ['Internal navigation']);
    assert.equal(repositoryDetailData.data.summary_prompt_version, 'repo-card-summary-v1');
    assert.equal(repositoryDetailData.data.summary_format_version, 'repo-card-summary-json-v1');
    assert.equal(repositoryDetailData.data.summary_source, 'generated');
    assert.equal(repositoryDetailData.data.readme_md, '# HTTP Repo\n\nComplete README content.');
    assert.equal(repositoryDetailData.data.readme_source_path, 'docs/README.md');
    assert.equal(repositoryDetailData.data.readme_default_branch, 'main');
    assert.equal(
      repositoryDetailData.data.readme_base_url,
      'https://raw.githubusercontent.com/owner/http-repo/refs/heads/main/docs/',
    );
    assert.deepEqual(repositoryDetailData.data.languages, ['TypeScript', 'SQL']);
    assert.deepEqual(repositoryDetailData.data.topics, ['phase-two']);
    assert.equal(repositoryDetailData.data.star_count, 12);
    assert.equal(repositoryDetailData.data.fork_count, 3);
    assert.equal(repositoryDetailData.data.open_issues_count, 2);
    assert.equal(repositoryDetailData.data.viewer_reaction, 'like');
    assert.equal(repositoryDetailData.data.viewer_saved, false);
    assert.deepEqual(repositoryDetailData.data.selected_list_ids, []);

    type ViewerAwareRepositoryListItem = {
      repo_id: string;
      summary: string | null;
      summary_prompt_version: string | null;
      summary_source: string | null;
      readme_md: string | null;
      readme_source_path: string | null;
      readme_default_branch: string | null;
      readme_base_url: string | null;
      languages: string[];
      topics: string[];
      viewer_reaction: 'like' | 'dislike' | null;
      viewer_saved: boolean;
      selected_list_ids: string[];
    };
    const exploreRepositories = await fetch(
      `${base}/api/v2/repositories?limit=25&offset=0`,
      { headers: authHeaders },
    );
    assert.equal(exploreRepositories.status, 200);
    const exploreItem = ((await exploreRepositories.json()) as {
      data: { items: ViewerAwareRepositoryListItem[] };
    }).data.items[0];
    assert.equal(exploreItem.repo_id, repoId);
    assert.equal(exploreItem.summary, 'Concise generated repository summary.');
    assert.equal(exploreItem.readme_md, '# HTTP Repo\n\nComplete README content.');
    assert.equal(exploreItem.summary_prompt_version, 'repo-card-summary-v1');
    assert.equal(exploreItem.summary_source, 'generated');
    assert.equal(exploreItem.readme_source_path, 'docs/README.md');
    assert.equal(exploreItem.readme_default_branch, 'main');
    assert.equal(exploreItem.readme_base_url, 'https://raw.githubusercontent.com/owner/http-repo/refs/heads/main/docs/');
    assert.deepEqual(exploreItem.languages, ['TypeScript', 'SQL']);
    assert.deepEqual(exploreItem.topics, ['phase-two']);
    assert.equal(exploreItem.viewer_reaction, 'like');
    assert.equal(exploreItem.viewer_saved, false);
    assert.deepEqual(exploreItem.selected_list_ids, []);

    const trendingRepositories = await fetch(
      `${base}/api/v2/repositories/trending?period=daily`,
      { headers: authHeaders },
    );
    assert.equal(trendingRepositories.status, 200);
    const trendingItem = ((await trendingRepositories.json()) as {
      data: { items: ViewerAwareRepositoryListItem[] };
    }).data.items[0];
    assert.equal(trendingItem.repo_id, repoId);
    assert.equal(trendingItem.summary, 'Concise generated repository summary.');
    assert.equal(trendingItem.readme_md, '# HTTP Repo\n\nComplete README content.');
    assert.equal(trendingItem.summary_prompt_version, 'repo-card-summary-v1');
    assert.equal(trendingItem.readme_source_path, 'docs/README.md');
    assert.deepEqual(trendingItem.languages, ['TypeScript', 'SQL']);
    assert.deepEqual(trendingItem.topics, ['phase-two']);
    assert.equal(trendingItem.viewer_reaction, 'like');
    assert.equal(trendingItem.viewer_saved, false);
    assert.deepEqual(trendingItem.selected_list_ids, []);

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
    await sqlClient`
      UPDATE app.users SET github_handle='renamed-owner' WHERE user_id=${ownerUserId}::uuid
    `;
    await sqlClient`
      UPDATE app.repos
      SET owner='renamed-owner'
      WHERE repo_id=${repoId}::uuid
    `;
    await sqlClient`
      UPDATE app.users SET github_id='9002',github_handle='owner',github_identity_verified_at=now()
      WHERE user_id=${spoofOwnerUserId}::uuid
    `;

    const renamedSocialProfile = await fetch(`${base}/api/v2/profiles/${ownerProfileId}`, {
      headers: authHeaders,
    });
    assert.equal(renamedSocialProfile.status, 200);
    const renamedSocialProfileData = (await renamedSocialProfile.json()) as {
      data: { repositories: Array<{ repo_id: string }> };
    };
    assert.deepEqual(
      renamedSocialProfileData.data.repositories.map((repository) => repository.repo_id),
      [repoId],
      'GitHub owner IDs keep profile repositories connected after a handle rename',
    );

    const ownerProfile = await fetch(`${base}/api/v2/users/${ownerUserId}`, {
      headers: authHeaders,
    });
    assert.equal(ownerProfile.status, 200);
    const ownerProfileData = (await ownerProfile.json()) as {
      data: {
        user_id: string;
        is_self: boolean;
        viewer_follows_user: boolean;
        followers_count: number;
      };
    };
    assert.equal(ownerProfileData.data.user_id, ownerUserId);
    assert.equal(ownerProfileData.data.is_self, false);
    assert.equal(ownerProfileData.data.viewer_follows_user, true);
    assert.equal(Number(ownerProfileData.data.followers_count), 1);

    const followingList = await fetch(
      `${base}/api/v2/users/${userId}/following?limit=25&offset=0`,
      { headers: authHeaders },
    );
    assert.equal(followingList.status, 200);
    const followingListData = (await followingList.json()) as {
      data: { items: Array<{ user_id: string; viewer_follows_user: boolean }> };
    };
    assert.equal(followingListData.data.items.length, 1);
    assert.equal(followingListData.data.items[0].user_id, ownerUserId);
    assert.equal(followingListData.data.items[0].viewer_follows_user, true);

    const selfFollow = await fetch(`${base}/api/v2/users/${userId}/follow`, {
      method: 'PUT', headers: authHeaders,
    });
    assert.equal(selfFollow.status, 400);
    const unknownFollow = await fetch(
      `${base}/api/v2/users/00000000-0000-4000-8000-000000000299/follow`,
      { method: 'PUT', headers: authHeaders },
    );
    assert.equal(unknownFollow.status, 404);

    await seedRecommendation();
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
    const countersAfterUnfollow = await sqlClient`
      SELECT user_id,followers_count,following_count
      FROM app.user_stats
      WHERE user_id IN (${userId}::uuid,${ownerUserId}::uuid)
      ORDER BY user_id
    `;
    assert.equal(
      countersAfterUnfollow.find((row) => String(row.user_id) === userId)?.following_count,
      0,
    );
    assert.equal(
      countersAfterUnfollow.find((row) => String(row.user_id) === ownerUserId)?.followers_count,
      0,
    );

    const externalFollow = await fetch(`${base}/api/v2/profiles/${externalProfileId}/follow`, {
      method: 'PUT', headers: authHeaders,
    });
    assert.equal(externalFollow.status, 204);
    const duplicateExternalFollow = await fetch(
      `${base}/api/v2/profiles/${externalProfileId}/follow`,
      { method: 'PUT', headers: authHeaders },
    );
    assert.equal(duplicateExternalFollow.status, 204);
    const externalProfile = await fetch(`${base}/api/v2/profiles/${externalProfileId}`, {
      headers: authHeaders,
    });
    assert.equal(externalProfile.status, 200);
    const externalProfileData = (await externalProfile.json()) as {
      data: {
        profile_id: string;
        followers_count: number;
        viewer_follows_profile: boolean;
      };
    };
    assert.equal(externalProfileData.data.profile_id, externalProfileId);
    assert.equal(Number(externalProfileData.data.followers_count), 1);
    assert.equal(externalProfileData.data.viewer_follows_profile, true);
    assert.equal(Number((await sqlClient`
      SELECT following_count FROM app.user_stats WHERE user_id=${userId}::uuid
    `)[0].following_count), 1);
    const followingWithExternal = await fetch(
      `${base}/api/v2/users/${userId}/following?limit=25&offset=0`,
      { headers: authHeaders },
    );
    assert.equal(followingWithExternal.status, 200);
    const followingWithExternalData = (await followingWithExternal.json()) as {
      data: {
        items: Array<{
          user_id: string | null;
          profile_id: string | null;
          viewer_follows_profile: boolean;
        }>;
      };
    };
    assert.deepEqual(
      followingWithExternalData.data.items.map((item) => item.profile_id),
      [externalProfileId],
    );
    assert.equal(followingWithExternalData.data.items[0].user_id, null);
    assert.equal(followingWithExternalData.data.items[0].viewer_follows_profile, true);

    const externalUnfollow = await fetch(`${base}/api/v2/profiles/${externalProfileId}/follow`, {
      method: 'DELETE', headers: authHeaders,
    });
    assert.equal(externalUnfollow.status, 204);
    const duplicateExternalUnfollow = await fetch(
      `${base}/api/v2/profiles/${externalProfileId}/follow`,
      { method: 'DELETE', headers: authHeaders },
    );
    assert.equal(duplicateExternalUnfollow.status, 204);
    assert.equal(Number((await sqlClient`
      SELECT following_count FROM app.user_stats WHERE user_id=${userId}::uuid
    `)[0].following_count), 0);

    const claimedProfileFollow = await fetch(`${base}/api/v2/profiles/${ownerProfileId}/follow`, {
      method: 'PUT', headers: authHeaders,
    });
    assert.equal(claimedProfileFollow.status, 204);
    assert.equal(Number((await sqlClient`
      SELECT count(*) AS count FROM app.follows
      WHERE follower_id=${userId}::uuid AND following_id=${ownerUserId}::uuid
    `)[0].count), 1);
    const claimedProfileUnfollow = await fetch(
      `${base}/api/v2/profiles/${ownerProfileId}/follow`,
      { method: 'DELETE', headers: authHeaders },
    );
    assert.equal(claimedProfileUnfollow.status, 204);

    const likesGiven = await fetch(`${base}/api/v2/users/${userId}/likes-given?limit=100&offset=0`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(likesGiven.status, 200);
    const likedItems = (await likesGiven.json()) as {
      data: { items: Array<ViewerAwareRepositoryListItem & { repo_name: string }> };
    };
    assert.deepEqual(likedItems.data.items.map((item) => item.repo_id), [repoId]);
    assert.equal(likedItems.data.items[0].repo_name, 'http-repo');
    assert.equal(likedItems.data.items[0].viewer_reaction, 'like');
    assert.equal(likedItems.data.items[0].viewer_saved, false);
    assert.deepEqual(likedItems.data.items[0].selected_list_ids, []);
    assert.equal(likedItems.data.items[0].summary, 'Concise generated repository summary.');
    assert.equal(likedItems.data.items[0].readme_md, '# HTTP Repo\n\nComplete README content.');

    const me = await fetch(`${base}/api/v2/users/me`, { headers: authHeaders });
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as { data: { user_id: string } }).data.user_id, userId);

    const completedProfile = await fetch(`${base}/api/v2/users/me`, {
      method:'PATCH',headers:authHeaders,body:JSON.stringify({full_name:'HTTP Test User',date_of_birth:'2000-01-01'}),
    });
    assert.equal(completedProfile.status,200);
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
    const collectionSaveEvent = {
      event_id: crypto.randomUUID(), schema_version: 2, session_id: sessionId, serve_id: served.serve_id,
      repo_id: repoId, position: 0, event_type: 'save', dwell_ms: null,
      client_occurred_at: new Date().toISOString(), context: { client: 'http-integration' },
    };
    const collectionSave = await fetch(`${base}/api/v2/collections/save`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        repositoryId: repoId,
        collectionIds: [collectionId],
        boardIds: [],
        event: collectionSaveEvent,
      }),
    });
    assert.equal(collectionSave.status, 200);
    const collectionSaveData = (await collectionSave.json()) as { data: { saved: boolean; collection_ids: string[] } };
    assert.equal(collectionSaveData.data.saved, true);
    assert.deepEqual(collectionSaveData.data.collection_ids, [collectionId]);
    const duplicateCollectionSave = await fetch(`${base}/api/v2/collections/save`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        repositoryId: repoId,
        collectionIds: [collectionId],
        boardIds: [],
        event: collectionSaveEvent,
      }),
    });
    assert.equal(duplicateCollectionSave.status, 200);
    assert.equal(Number((await sqlClient`
      SELECT count(*) AS count FROM telemetry.interaction_events
      WHERE event_id=${collectionSaveEvent.event_id}::uuid
    `)[0].count), 1, 'a retried List save records feedback exactly once');
    assert.equal(Number((await sqlClient`
      SELECT count(*) AS count FROM telemetry.ml_outbox
      WHERE idempotency_key=${`feedback:${collectionSaveEvent.event_id}`}
    `)[0].count), 1);
    const collectionsForRepo = await fetch(`${base}/api/v2/collections?repository_id=${repoId}`, { headers: authHeaders });
    assert.equal(collectionsForRepo.status, 200);
    const collectionItems = (await collectionsForRepo.json()) as { data: { items: Array<{ collection_id: string; repo_count: number; selected: boolean }> } };
    assert.equal(collectionItems.data.items[0].collection_id, collectionId);
    assert.equal(collectionItems.data.items[0].repo_count, 1);
    assert.equal(collectionItems.data.items[0].selected, true);
    const collectionRepos = await fetch(
      `${base}/api/v2/collections/${collectionId}/repositories`,
      { headers: authHeaders },
    );
    assert.equal(collectionRepos.status, 200);
    const collectionRepoItems = (await collectionRepos.json()) as {
      data: { items: Array<ViewerAwareRepositoryListItem & { full_name: string }> };
    };
    assert.equal(collectionRepoItems.data.items[0].repo_id, repoId);
    assert.equal(collectionRepoItems.data.items[0].full_name, 'owner/http-repo');
    assert.equal(collectionRepoItems.data.items[0].viewer_reaction, 'like');
    assert.equal(collectionRepoItems.data.items[0].viewer_saved, true);
    assert.deepEqual(collectionRepoItems.data.items[0].selected_list_ids, [`collection:${collectionId}`]);
    assert.equal(collectionRepoItems.data.items[0].summary, 'Concise generated repository summary.');
    assert.equal(collectionRepoItems.data.items[0].readme_md, '# HTTP Repo\n\nComplete README content.');
    const secondCollection = await fetch(`${base}/api/v2/collections`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ name: 'Read next' }),
    });
    assert.equal(secondCollection.status, 201);
    const secondCollectionId = ((await secondCollection.json()) as {
      data: { collection_id: string };
    }).data.collection_id;
    const multiListSave = await fetch(`${base}/api/v2/collections/save`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        repositoryId: repoId,
        collectionIds: [collectionId, secondCollectionId],
        boardIds: [],
        event: { ...collectionSaveEvent, event_id: crypto.randomUUID() },
      }),
    });
    assert.equal(multiListSave.status, 200);
    const multiListData = (await multiListSave.json()) as {
      data: { selected_list_ids: string[]; saved: boolean; save_state_changed: boolean };
    };
    assert.deepEqual(multiListData.data.selected_list_ids, [
      `collection:${collectionId}`,
      `collection:${secondCollectionId}`,
    ]);
    assert.equal(multiListData.data.saved, true);
    assert.equal(multiListData.data.save_state_changed, false);

    const selectedDetail = await fetch(`${base}/api/v2/repositories/${repoId}`, { headers: authHeaders });
    assert.equal(selectedDetail.status, 200);
    const selectedDetailData = ((await selectedDetail.json()) as {
      data: { selected_list_ids: string[]; viewer_saved: boolean };
    }).data;
    assert.deepEqual(
      [...selectedDetailData.selected_list_ids].sort(),
      [`collection:${collectionId}`, `collection:${secondCollectionId}`].sort(),
    );
    assert.equal(selectedDetailData.viewer_saved, true);

    const deleteFirstList = await fetch(`${base}/api/v2/collections/${collectionId}`, {
      method: 'DELETE', headers: authHeaders,
    });
    assert.equal(deleteFirstList.status, 204);
    assert.equal(Number((await sqlClient`
      SELECT count(*) AS count FROM app.saves
      WHERE user_id=${userId}::uuid AND repo_id=${repoId}::uuid
    `)[0].count), 1, 'deleting one of two Lists keeps the repository saved');

    const deleteFinalList = await fetch(`${base}/api/v2/collections/${secondCollectionId}`, {
      method: 'DELETE', headers: authHeaders,
    });
    assert.equal(deleteFinalList.status, 204);
    assert.equal(Number((await sqlClient`
      SELECT count(*) AS count FROM app.saves
      WHERE user_id=${userId}::uuid AND repo_id=${repoId}::uuid
    `)[0].count), 0, 'deleting the final List clears the saved union');
    assert.equal(Number((await sqlClient`
      SELECT saves_count FROM app.repo_engagement WHERE repo_id=${repoId}::uuid
    `)[0].saves_count), 0);
    assert.equal(Number((await sqlClient`
      SELECT saved_repos_count FROM app.user_stats WHERE user_id=${userId}::uuid
    `)[0].saved_repos_count), 0);

    const board = await fetch(`${base}/api/v2/boards`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ name: 'Read later', visibility: 'private' }),
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
    const boardsForRepo = await fetch(`${base}/api/v2/boards?repository_id=${repoId}`, {
      headers: authHeaders,
    });
    assert.equal(boardsForRepo.status, 200);
    const boardListItems = ((await boardsForRepo.json()) as {
      data: { items: Array<{ board_id: string; selected: boolean }> };
    }).data.items;
    assert.equal(boardListItems[0].board_id, boardId);
    assert.equal(boardListItems[0].selected, true);
    const boardRepos = await fetch(`${base}/api/v2/boards/${boardId}/repositories`, { headers: authHeaders });
    assert.equal(boardRepos.status, 200);
    const boardRepoItems = ((await boardRepos.json()) as {
      data: { items: ViewerAwareRepositoryListItem[] };
    }).data.items;
    assert.equal(boardRepoItems.length, 1);
    assert.equal(boardRepoItems[0].viewer_reaction, 'like');
    assert.equal(boardRepoItems[0].viewer_saved, true);
    assert.deepEqual(boardRepoItems[0].selected_list_ids, [`legacy-board:${boardId}`]);
    assert.equal(boardRepoItems[0].summary, 'Concise generated repository summary.');
    assert.equal(boardRepoItems[0].readme_md, '# HTTP Repo\n\nComplete README content.');
    const savedRepos = await fetch(`${base}/api/v2/repositories/saved`, { headers: authHeaders });
    assert.equal(savedRepos.status, 200);
    const savedRepoItems = ((await savedRepos.json()) as {
      data: { items: ViewerAwareRepositoryListItem[] };
    }).data.items;
    assert.deepEqual(savedRepoItems.map((item) => item.repo_id), [repoId]);
    assert.equal(savedRepoItems[0].viewer_reaction, 'like');
    assert.equal(savedRepoItems[0].viewer_saved, true);
    assert.deepEqual(savedRepoItems[0].selected_list_ids, [`legacy-board:${boardId}`]);
    assert.equal(savedRepoItems[0].summary, 'Concise generated repository summary.');
    assert.equal(savedRepoItems[0].readme_md, '# HTTP Repo\n\nComplete README content.');

    const mixedCollection = await fetch(`${base}/api/v2/collections`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ name: 'Mixed membership' }),
    });
    assert.equal(mixedCollection.status, 201);
    const mixedCollectionId = ((await mixedCollection.json()) as {
      data: { collection_id: string };
    }).data.collection_id;
    const mixedSaveEvent = { ...saveEvent, event_id: crypto.randomUUID() };
    const mixedSave = await fetch(`${base}/api/v2/collections/save`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        repositoryId: repoId,
        collectionIds: [mixedCollectionId],
        boardIds: [boardId],
        event: mixedSaveEvent,
      }),
    });
    assert.equal(mixedSave.status, 200);
    const mixedSaveData = ((await mixedSave.json()) as {
      data: { selected_list_ids: string[]; saved: boolean; save_state_changed: boolean };
    }).data;
    assert.deepEqual(mixedSaveData.selected_list_ids, [
      `collection:${mixedCollectionId}`,
      `legacy-board:${boardId}`,
    ]);
    assert.equal(mixedSaveData.saved, true);
    assert.equal(mixedSaveData.save_state_changed, false);
    assert.equal(Number((await sqlClient`
      SELECT count(*) AS count FROM telemetry.interaction_events
      WHERE event_id=${mixedSaveEvent.event_id}::uuid
    `)[0].count), 0, 'moving an already-saved repository does not duplicate save feedback');

    const versionBeforeLegacySave=await feedPersistence.getFeedVersion(userId);
    const legacySave=await fetch(`${base}/api/v2/collections/save`,{
      method:'POST',headers:authHeaders,body:JSON.stringify({repositoryId:repoId,collectionIds:[]}),
    });
    assert.equal(legacySave.status,200);
    const legacySaved=(await legacySave.json() as {data:{board_ids:string[];saved:boolean;save_state_changed:boolean}}).data;
    assert.deepEqual(legacySaved.board_ids,[boardId]);assert.equal(legacySaved.saved,true);
    assert.equal(legacySaved.save_state_changed,false);
    assert.equal(await feedPersistence.getFeedVersion(userId),versionBeforeLegacySave,'No-op saved state must not invalidate pagination');
    const invalidBoardIds=await fetch(`${base}/api/v2/collections/save`,{
      method:'POST',headers:authHeaders,body:JSON.stringify({repositoryId:repoId,collectionIds:[],boardIds:null}),
    });
    assert.equal(invalidBoardIds.status,400,'Only omission preserves existing Boards; malformed values are rejected');

    const keepBoardEvent = { ...saveEvent, event_id: crypto.randomUUID() };
    const keepBoardOnly = await fetch(`${base}/api/v2/collections/save`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        repositoryId: repoId,
        collectionIds: [],
        boardIds: [boardId],
        event: keepBoardEvent,
      }),
    });
    assert.equal(keepBoardOnly.status, 200);
    const keepBoardOnlyData = ((await keepBoardOnly.json()) as {
      data: { saved: boolean; save_state_changed: boolean };
    }).data;
    assert.equal(keepBoardOnlyData.saved, true);
    assert.equal(keepBoardOnlyData.save_state_changed, false);

    const unsaveEvent = {
      ...saveEvent,
      event_id: crypto.randomUUID(),
      event_type: 'unsave',
    };
    const removeFinalMembership = await fetch(`${base}/api/v2/collections/save`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        repositoryId: repoId,
        collectionIds: [],
        boardIds: [],
        event: unsaveEvent,
      }),
    });
    assert.equal(removeFinalMembership.status, 200);
    const removeFinalMembershipData = ((await removeFinalMembership.json()) as {
      data: { saved: boolean; save_state_changed: boolean };
    }).data;
    assert.equal(removeFinalMembershipData.saved, false);
    assert.equal(removeFinalMembershipData.save_state_changed, true);
    const duplicateFinalRemoval = await fetch(`${base}/api/v2/collections/save`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        repositoryId: repoId,
        collectionIds: [],
        boardIds: [],
        event: unsaveEvent,
      }),
    });
    assert.equal(duplicateFinalRemoval.status, 200);
    assert.equal(Number((await sqlClient`
      SELECT count(*) AS count FROM app.saves
      WHERE user_id=${userId}::uuid AND repo_id=${repoId}::uuid
    `)[0].count), 0, 'removing the final List membership clears saved state');
    assert.equal(Number((await sqlClient`
      SELECT count(*) AS count FROM telemetry.interaction_events
      WHERE event_id=${unsaveEvent.event_id}::uuid
    `)[0].count), 1, 'a retried final removal records unsave feedback exactly once');
    assert.equal(Number((await sqlClient`
      SELECT count(*) AS count FROM telemetry.ml_outbox
      WHERE idempotency_key=${`feedback:${unsaveEvent.event_id}`}
    `)[0].count), 1);

    const secondSaveEvent = { ...saveEvent, event_id: crypto.randomUUID() };
    const reAddBoardRepository = await fetch(
      `${base}/api/v2/boards/${boardId}/repositories/${repoId}`,
      { method: 'PUT', headers: authHeaders, body: JSON.stringify({ event: secondSaveEvent }) },
    );
    assert.equal(reAddBoardRepository.status, 204);
    const deleteBoard = await fetch(`${base}/api/v2/boards/${boardId}`, {
      method: 'DELETE', headers: authHeaders,
    });
    assert.equal(deleteBoard.status, 204);
    assert.equal(Number((await sqlClient`
      SELECT count(*) AS count FROM app.saves
      WHERE user_id=${userId}::uuid AND repo_id=${repoId}::uuid
    `)[0].count), 0, 'deleting a board recomputes saved state for its repositories');

    const legacy = await fetch(`${base}/api/users/id/${userId}`, { headers: authHeaders });
    assert.equal(legacy.status, 404);

    await sqlClient`
      INSERT INTO app.social_profiles(
        profile_id,provider,provider_subject,handle,profile_kind,claimed_by_user_id
      ) VALUES
        (${ingestionCanonicalProfileId}::uuid,'github','9003','former-owner','unknown',NULL),
        (${ingestionDuplicateProfileId}::uuid,'github',NULL,'new-owner','organization',NULL),
        (${renamedIngestionProfileId}::uuid,'github','9004','former-recycled-owner','user',NULL),
        (${recycledHandleProfileId}::uuid,'github','9005','recycled-owner','user',NULL)
    `;
    await sqlClient`
      INSERT INTO app.social_profile_follows(follower_id,profile_id)
      VALUES (${userId}::uuid,${ingestionDuplicateProfileId}::uuid)
    `;
    await sqlClient`
      UPDATE app.user_stats
      SET following_count=following_count+1
      WHERE user_id=${userId}::uuid
    `;
    const feedVersionBeforeReconciliation = BigInt((await sqlClient`
      SELECT feed_version FROM app.user_feed_state WHERE user_id=${userId}::uuid
    `)[0].feed_version);

    const ingestion = await fetch(`${base}/api/internal/v2/ingestion/repositories/upsert`, {
      method: 'POST', headers: { 'x-internal-secret': process.env.INTERNAL_API_SECRET!, 'content-type': 'application/json' },
      body: JSON.stringify({ repositories: [
        {
          github_id: '303', owner_github_id: '9003', full_name: 'new-owner/ingested', owner: 'new-owner', name: 'ingested',
          url: 'https://github.com/new-owner/ingested', description: 'ingested', languages: [], topics: [],
          readme: '# Canonical README\n\n![Preview](./media/preview.png)',
          readme_source_path: 'docs/README.md', readme_default_branch: 'main',
          readme_base_url: 'https://raw.githubusercontent.com/new-owner/ingested/refs/heads/main/docs/',
          star_count: 1, fork_count: 0, observed_at: new Date().toISOString(),
        },
        {
          github_id: '304', owner_github_id: '9004', full_name: 'recycled-owner/ingested',
          owner: 'recycled-owner', name: 'ingested',
          url: 'https://github.com/recycled-owner/ingested', description: 'ingested', languages: [], topics: [],
          star_count: 1, fork_count: 0, observed_at: new Date().toISOString(),
        },
      ] }),
    });
    assert.equal(ingestion.status, 200);
    const ingested = await ingestion.json() as { mappings: Array<{ github_id: number; repo_id: string }> };
    assert.equal(ingested.mappings[0].github_id, '303');
    assert.match(ingested.mappings[0].repo_id, /^[0-9a-f-]{36}$/);
    assert.equal(ingested.mappings[1].github_id, '304');
    assert.match(ingested.mappings[1].repo_id, /^[0-9a-f-]{36}$/);
    const ingestedContent = (await sqlClient`
      SELECT readme,readme_source_path,readme_default_branch,readme_base_url
      FROM app.repo_content WHERE repo_id=${ingested.mappings[0].repo_id}::uuid
    `)[0];
    assert.equal(String(ingestedContent.readme), '# Canonical README\n\n![Preview](./media/preview.png)');
    assert.equal(String(ingestedContent.readme_source_path), 'docs/README.md');
    assert.equal(String(ingestedContent.readme_default_branch), 'main');
    assert.equal(
      String(ingestedContent.readme_base_url),
      'https://raw.githubusercontent.com/new-owner/ingested/refs/heads/main/docs/',
    );
    assert.equal(Number((await sqlClient`
      SELECT count(*) AS count FROM app.social_profiles
      WHERE provider='github' AND provider_subject='9003' AND lower(handle)='new-owner'
    `)[0].count), 1);
    assert.equal(Number((await sqlClient`
      SELECT count(*) AS count FROM app.social_profiles
      WHERE profile_id=${ingestionDuplicateProfileId}::uuid
    `)[0].count), 0);
    const recycledHandleProfiles = await sqlClient`
      SELECT profile_id,provider_subject,status
      FROM app.social_profiles
      WHERE profile_id IN (
        ${renamedIngestionProfileId}::uuid,
        ${recycledHandleProfileId}::uuid
      )
      ORDER BY provider_subject
    `;
    assert.deepEqual(
      recycledHandleProfiles.map((profile) => ({
        profileId: String(profile.profile_id),
        providerSubject: String(profile.provider_subject),
        status: String(profile.status),
      })),
      [
        { profileId: renamedIngestionProfileId, providerSubject: '9004', status: 'active' },
        { profileId: recycledHandleProfileId, providerSubject: '9005', status: 'deleted' },
      ],
      'a recycled handle must not merge two identified GitHub profiles or abort the batch',
    );
    assert.equal(Number((await sqlClient`
      SELECT count(*) AS count
      FROM app.social_profiles
      WHERE status='active' AND lower(handle)='recycled-owner'
        AND provider_subject='9004'
    `)[0].count), 1);
    assert.equal(Number((await sqlClient`
      SELECT count(*) AS count
      FROM app.social_profile_follows
      WHERE follower_id=${userId}::uuid
        AND profile_id=${ingestionCanonicalProfileId}::uuid
    `)[0].count), 1);
    assert.equal(
      BigInt((await sqlClient`
        SELECT feed_version FROM app.user_feed_state WHERE user_id=${userId}::uuid
      `)[0].feed_version),
      feedVersionBeforeReconciliation + 1n,
    );
    assert.deepEqual(
      await feedPersistence.listFollowedRepositoryIds(userId, 10),
      [ingested.mappings[0].repo_id],
      'reconciled handle-only follows must include repositories owned by the immutable GitHub ID',
    );
    const ingestedOwnerProfile = await fetch(
      `${base}/api/v2/profiles/${ingestionCanonicalProfileId}`,
      { headers: authHeaders },
    );
    assert.equal(ingestedOwnerProfile.status, 200);
    const ingestedOwnerProfileData = (await ingestedOwnerProfile.json()) as {
      data: {
        handle: string;
        repositories: Array<{ repo_id: string }>;
        viewer_follows_profile: boolean;
      };
    };
    assert.equal(ingestedOwnerProfileData.data.handle, 'new-owner');
    assert.equal(ingestedOwnerProfileData.data.viewer_follows_profile, true);
    assert.deepEqual(
      ingestedOwnerProfileData.data.repositories.map((repository) => repository.repo_id),
      [ingested.mappings[0].repo_id],
    );

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
