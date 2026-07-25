import { sqlClient } from '../db/index.js';
import type postgres from 'postgres';

type TransactionSql = postgres.TransactionSql;

type SocialFollowOptions = {
  followerId: string;
  profileId: string;
  following: boolean;
};

type VerifiedGithubClaim = {
  userId: string;
  githubId: string;
  githubHandle: string;
  displayName?: string | null;
  avatarUrl?: string | null;
};

function domainError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

async function bumpFeedVersion(tx: TransactionSql, userId: string): Promise<void> {
  await tx`
    INSERT INTO app.user_feed_state (user_id,feed_version,updated_at)
    VALUES (${userId}::uuid,2,now())
    ON CONFLICT (user_id) DO UPDATE SET
      feed_version=app.user_feed_state.feed_version+1,
      updated_at=now()
  `;
}

export async function setSocialProfileFollowing({
  followerId,
  profileId,
  following,
}: SocialFollowOptions): Promise<{ changed: boolean; claimedUserId: string | null }> {
  return sqlClient.begin(async (tx) => {
    const followers = await tx`
      SELECT u.user_id,u.status,(stats.user_id IS NOT NULL) AS has_stats
      FROM app.users u
      LEFT JOIN app.user_stats stats USING(user_id)
      WHERE u.user_id=${followerId}::uuid
      FOR UPDATE OF u
    `;
    const profiles = await tx`
      SELECT profile_id,status,claimed_by_user_id
      FROM app.social_profiles
      WHERE profile_id=${profileId}::uuid
      FOR UPDATE
    `;
    const follower = followers[0];
    const profile = profiles[0];
    if (!follower || follower.status !== 'active') {
      throw domainError('Your account is not available for follow actions.', 403);
    }
    if (!follower.has_stats) throw domainError('User statistics are unavailable.', 500);
    if (!profile || profile.status !== 'active') throw domainError('Profile not found.', 404);

    const claimedUserId = profile.claimed_by_user_id == null
      ? null
      : String(profile.claimed_by_user_id);
    if (claimedUserId === followerId) {
      throw domainError('A user cannot follow themselves.', 400);
    }

    let changedRows: Array<Record<string, unknown>>;
    if (claimedUserId) {
      const targets = await tx`
        SELECT u.user_id,u.status,(stats.user_id IS NOT NULL) AS has_stats
        FROM app.users u
        LEFT JOIN app.user_stats stats USING(user_id)
        WHERE u.user_id=${claimedUserId}::uuid
        FOR UPDATE OF u
      `;
      const target = targets[0];
      if (!target || (following && target.status !== 'active')) {
        throw domainError('Target user not found.', 404);
      }
      if (!target.has_stats) throw domainError('User statistics are unavailable.', 500);
      changedRows = following
        ? await tx`
            INSERT INTO app.follows(follower_id,following_id)
            VALUES(${followerId}::uuid,${claimedUserId}::uuid)
            ON CONFLICT DO NOTHING RETURNING follower_id
          `
        : await tx`
            DELETE FROM app.follows
            WHERE follower_id=${followerId}::uuid AND following_id=${claimedUserId}::uuid
            RETURNING follower_id
          `;
      if (changedRows.length > 0) {
        await tx`
          UPDATE app.user_stats
          SET following_count=GREATEST(0,following_count+${following ? 1 : -1}),updated_at=now()
          WHERE user_id=${followerId}::uuid
        `;
        await tx`
          UPDATE app.user_stats
          SET followers_count=GREATEST(0,followers_count+${following ? 1 : -1}),updated_at=now()
          WHERE user_id=${claimedUserId}::uuid
        `;
      }
    } else {
      changedRows = following
        ? await tx`
            INSERT INTO app.social_profile_follows(follower_id,profile_id)
            VALUES(${followerId}::uuid,${profileId}::uuid)
            ON CONFLICT DO NOTHING RETURNING follower_id
          `
        : await tx`
            DELETE FROM app.social_profile_follows
            WHERE follower_id=${followerId}::uuid AND profile_id=${profileId}::uuid
            RETURNING follower_id
          `;
      if (changedRows.length > 0) {
        await tx`
          UPDATE app.user_stats
          SET following_count=GREATEST(0,following_count+${following ? 1 : -1}),updated_at=now()
          WHERE user_id=${followerId}::uuid
        `;
      }
    }

    if (changedRows.length === 0) return { changed: false, claimedUserId };
    await bumpFeedVersion(tx, followerId);
    return { changed: true, claimedUserId };
  });
}

export async function claimVerifiedGithubProfile(
  tx: TransactionSql,
  claim: VerifiedGithubClaim,
): Promise<string> {
  const matches = await tx`
    SELECT profile_id,provider_subject,handle,claimed_by_user_id
    FROM app.social_profiles
    WHERE provider='github'
      AND (
        provider_subject=${claim.githubId}
        OR (provider_subject IS NULL AND lower(handle)=lower(${claim.githubHandle}))
      )
    ORDER BY (provider_subject=${claim.githubId}) DESC,created_at ASC
    FOR UPDATE
  `;
  const claimedByAnother = matches.find((profile) =>
    profile.claimed_by_user_id != null && String(profile.claimed_by_user_id) !== claim.userId
  );
  if (claimedByAnother) {
    throw domainError('This GitHub identity is already claimed by another account.', 409);
  }

  let canonical = matches.find((profile) => String(profile.provider_subject ?? '') === claim.githubId)
    ?? matches[0];
  if (!canonical) {
    const inserted = await tx`
      INSERT INTO app.social_profiles(
        provider,provider_subject,handle,display_name,avatar_url,profile_kind,claimed_by_user_id
      ) VALUES (
        'github',${claim.githubId},${claim.githubHandle},${claim.displayName ?? null},
        ${claim.avatarUrl ?? null},'user',${claim.userId}::uuid
      )
      RETURNING profile_id,provider_subject,handle,claimed_by_user_id
    `;
    canonical = inserted[0];
  }
  const canonicalId = String(canonical.profile_id);

  for (const duplicate of matches) {
    const duplicateId = String(duplicate.profile_id);
    if (duplicateId === canonicalId) continue;
    const overlappingFollowers = await tx`
      SELECT duplicate_follow.follower_id
      FROM app.social_profile_follows duplicate_follow
      JOIN app.social_profile_follows canonical_follow
        ON canonical_follow.follower_id=duplicate_follow.follower_id
       AND canonical_follow.profile_id=${canonicalId}::uuid
      WHERE duplicate_follow.profile_id=${duplicateId}::uuid
    `;
    for (const overlap of overlappingFollowers) {
      await tx`
        UPDATE app.user_stats
        SET following_count=GREATEST(0,following_count-1),updated_at=now()
        WHERE user_id=${String(overlap.follower_id)}::uuid
      `;
    }
    await tx`
      INSERT INTO app.social_profile_follows(follower_id,profile_id,created_at)
      SELECT follower_id,${canonicalId}::uuid,created_at
      FROM app.social_profile_follows
      WHERE profile_id=${duplicateId}::uuid
      ON CONFLICT DO NOTHING
    `;
    await tx`DELETE FROM app.social_profile_follows WHERE profile_id=${duplicateId}::uuid`;
    await tx`DELETE FROM app.social_profiles WHERE profile_id=${duplicateId}::uuid`;
  }

  await tx`
    UPDATE app.social_profiles
    SET provider_subject=${claim.githubId},
        handle=${claim.githubHandle},
        display_name=COALESCE(${claim.displayName ?? null},display_name),
        avatar_url=COALESCE(${claim.avatarUrl ?? null},avatar_url),
        profile_kind='user',
        claimed_by_user_id=${claim.userId}::uuid,
        updated_at=now()
    WHERE profile_id=${canonicalId}::uuid
  `;

  const externalFollowers = await tx`
    DELETE FROM app.social_profile_follows
    WHERE profile_id=${canonicalId}::uuid
    RETURNING follower_id,created_at
  `;
  let insertedCount = 0;
  for (const relationship of externalFollowers) {
    const followerId = String(relationship.follower_id);
    if (followerId === claim.userId) {
      await tx`
        UPDATE app.user_stats
        SET following_count=GREATEST(0,following_count-1),updated_at=now()
        WHERE user_id=${followerId}::uuid
      `;
      continue;
    }
    const inserted = await tx`
      INSERT INTO app.follows(follower_id,following_id,created_at)
      VALUES(${followerId}::uuid,${claim.userId}::uuid,${relationship.created_at})
      ON CONFLICT DO NOTHING RETURNING follower_id
    `;
    if (inserted.length > 0) {
      insertedCount += 1;
    } else {
      // The same person was already followed directly and externally.
      await tx`
        UPDATE app.user_stats
        SET following_count=GREATEST(0,following_count-1),updated_at=now()
        WHERE user_id=${followerId}::uuid
      `;
    }
  }
  if (insertedCount > 0) {
    await tx`
      UPDATE app.user_stats
      SET followers_count=followers_count+${insertedCount},updated_at=now()
      WHERE user_id=${claim.userId}::uuid
    `;
  }
  return canonicalId;
}
