import type postgres from 'postgres';

export async function setRepositorySaved(
  tx: postgres.TransactionSql,
  userId: string,
  repoId: string,
  saved: boolean,
): Promise<boolean> {
  // Repository engagement is the shared lock for save transitions. Taking it
  // before touching app.saves keeps board and activity writes in the same lock
  // order and prevents concurrent requests from double-counting.
  await tx`INSERT INTO app.repo_engagement (repo_id) VALUES (${repoId}::uuid) ON CONFLICT DO NOTHING`;
  await tx`SELECT repo_id FROM app.repo_engagement WHERE repo_id=${repoId}::uuid FOR UPDATE`;

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
