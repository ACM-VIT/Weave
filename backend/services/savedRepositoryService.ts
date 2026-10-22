import type postgres from 'postgres';

export function hasAnyRepositoryMembership(
  collectionMembership: boolean,
  boardMembership: boolean,
): boolean {
  return collectionMembership || boardMembership;
}

export async function getRepositoryMembershipSavedState(
  tx: postgres.TransactionSql,
  userId: string,
  repoId: string,
): Promise<boolean> {
  const rows = await tx`
    SELECT EXISTS(
      SELECT 1
      FROM app.collection_repos membership
      JOIN app.board_collections collection USING(collection_id)
      WHERE membership.repo_id=${repoId}::uuid AND collection.user_id=${userId}::uuid
    ) AS collection_membership,
    EXISTS(
      SELECT 1
      FROM app.board_repos membership
      JOIN app.boards board USING(board_id)
      WHERE membership.repo_id=${repoId}::uuid AND board.user_id=${userId}::uuid
    ) AS board_membership
  `;
  return hasAnyRepositoryMembership(
    rows[0]?.collection_membership === true,
    rows[0]?.board_membership === true,
  );
}

export async function setRepositorySaved(
  tx: postgres.TransactionSql,
  userId: string,
  repoId: string,
  saved: boolean,
  options: { engagementLocked?: boolean } = {},
): Promise<boolean> {
  // engagementLocked is used only by the activity batch after its sorted bulk lock.
  // Repository engagement is the shared lock for save transitions. Taking it
  // before touching app.saves keeps board and activity writes in the same lock
  // order and prevents concurrent requests from double-counting.
  if (!options.engagementLocked) {
    await tx`INSERT INTO app.repo_engagement (repo_id) VALUES (${repoId}::uuid) ON CONFLICT DO NOTHING`;
    await tx`SELECT repo_id FROM app.repo_engagement WHERE repo_id=${repoId}::uuid FOR UPDATE`;
  }

  const changed = saved
    ? await tx`
        INSERT INTO app.saves (user_id,repo_id) VALUES (${userId}::uuid,${repoId}::uuid)
        ON CONFLICT (user_id,repo_id) DO NOTHING RETURNING repo_id
      `
    : await tx`
        DELETE FROM app.saves WHERE user_id=${userId}::uuid AND repo_id=${repoId}::uuid
        RETURNING repo_id
      `;
  if (changed.length === 0) return false;

  const delta = saved ? 1 : -1;
  await tx`
    UPDATE app.repo_engagement
    SET saves_count=GREATEST(0,saves_count+${delta}),updated_at=now()
    WHERE repo_id=${repoId}::uuid
  `;
  await tx`INSERT INTO app.user_stats (user_id) VALUES (${userId}::uuid) ON CONFLICT DO NOTHING`;
  await tx`
    UPDATE app.user_stats
    SET saved_repos_count=GREATEST(0,saved_repos_count+${delta}),updated_at=now()
    WHERE user_id=${userId}::uuid
  `;
  return true;
}
