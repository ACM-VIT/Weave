/** A backend-only discovery policy using verified, immutable GitHub identities.
 * Correlated SQL references are fixed code literals, never request values.
 * Do not apply this to product detail/list reads or durable historical replay.
 */
export function unfamiliarRepositorySql(viewerReference: '$2::uuid' | 'serve.user_id' | 'feed_viewer.user_id'): string {
  if (!['$2::uuid','serve.user_id','feed_viewer.user_id'].includes(viewerReference)) throw new Error('Invalid familiarity viewer reference.');
  return `NOT EXISTS (
    SELECT 1 FROM app.users known_viewer
    LEFT JOIN app.user_github_imports imported
      ON imported.user_id=known_viewer.user_id AND imported.github_id=known_viewer.github_id
      AND imported.accepted_at IS NOT NULL AND imported.revoked_at IS NULL
    WHERE known_viewer.user_id=${viewerReference} AND known_viewer.github_identity_verified_at IS NOT NULL
      AND (repo.owner_github_id::text=known_viewer.github_id
        OR (imported.provenance->'repository_ids') @> jsonb_build_array(jsonb_build_object('github_id',repo.github_id::text)))
  )`;
}

/** Keep repository identity lookups on bigint indexes, even with malformed old provenance. */
export function canonicalGithubIdSql(reference: 'feed_viewer.github_id' | "known.value->>'github_id'"): string {
  if (!['feed_viewer.github_id',"known.value->>'github_id'"].includes(reference)) throw new Error('Invalid GitHub identity reference.');
  return `(CASE WHEN (${reference}) ~ '^[1-9][0-9]{0,18}$'
    THEN CASE WHEN (${reference})::numeric <= 9223372036854775807 THEN (${reference})::bigint END END)`;
}
