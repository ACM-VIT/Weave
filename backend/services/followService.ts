import { sqlClient } from '../db/index.js';

type FollowMutationOptions = {
  followerId: string;
  followingId: string;
  following: boolean;
};

export type FollowMutationResult = {
  changed: boolean;
};

function domainError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

export async function setFollowRelationship({
  followerId,
  followingId,
  following,
}: FollowMutationOptions): Promise<FollowMutationResult> {
  if (followerId === followingId) {
    throw domainError('A user cannot follow themselves.', 400);
  }
  return sqlClient.begin(async (tx) => {
    // Lock both user rows in a stable order. This serializes concurrent
    // follow/unfollow requests and keeps the relationship and counters aligned.
    const users = await tx`
      SELECT u.user_id,u.status,(s.user_id IS NOT NULL) AS has_stats
      FROM app.users u
      LEFT JOIN app.user_stats s USING(user_id)
      WHERE u.user_id IN (${followerId}::uuid,${followingId}::uuid)
      ORDER BY u.user_id
      FOR UPDATE OF u
    `;
    const follower = users.find((row) => String(row.user_id) === followerId);
    const target = users.find((row) => String(row.user_id) === followingId);

    if (!follower || follower.status !== 'active') {
      throw domainError('Your account is not available for follow actions.', 403);
    }
    if (!target || (following && target.status !== 'active')) {
      throw domainError('Target user not found.', 404);
    }
    if (!follower.has_stats || !target.has_stats) {
      throw domainError('User statistics are unavailable.', 500);
    }

    const changedRows = following
      ? await tx`
          INSERT INTO app.follows(follower_id,following_id)
          VALUES(${followerId}::uuid,${followingId}::uuid)
          ON CONFLICT DO NOTHING
          RETURNING follower_id
        `
      : await tx`
          DELETE FROM app.follows
          WHERE follower_id=${followerId}::uuid AND following_id=${followingId}::uuid
          RETURNING follower_id
        `;

    if (changedRows.length === 0) return { changed: false };

    const followerStats = await tx`
      UPDATE app.user_stats
      SET following_count=GREATEST(0,following_count+${following ? 1 : -1}),updated_at=now()
      WHERE user_id=${followerId}::uuid
      RETURNING user_id
    `;
    const targetStats = await tx`
      UPDATE app.user_stats
      SET followers_count=GREATEST(0,followers_count+${following ? 1 : -1}),updated_at=now()
      WHERE user_id=${followingId}::uuid
      RETURNING user_id
    `;
    if (followerStats.length !== 1 || targetStats.length !== 1) {
      throw domainError('User statistics could not be updated.', 500);
    }

    // Preserve the current recommendation contract: a changed social graph
    // invalidates only the follower's queued feed. Duplicate requests do not.
    await tx`
      INSERT INTO app.user_feed_state (user_id,feed_version,updated_at)
      VALUES (${followerId}::uuid,2,now())
      ON CONFLICT (user_id) DO UPDATE SET
        feed_version=app.user_feed_state.feed_version+1,
        updated_at=now()
    `;

    return { changed: true };
  });
}
