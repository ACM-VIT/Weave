/** Authoritative current product preferences, independent of bounded exposures.
 * Read before NEW candidate publication/serving; never rewrite durable replay.
 * This reader is not a concurrent fresh-serve fence (owned by the serving flow).
 */
export const MAX_NEGATIVE_ELIGIBILITY_IDS = 150;
export interface NegativePreferenceReader {
  query(text: string, parameters: readonly (string | string[])[]): Promise<Record<string, unknown>[]>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const NEGATIVE_PREFERENCE_ELIGIBILITY_SQL = `
SELECT repo.repo_id FROM app.repos repo
WHERE repo.repo_id=ANY($1::uuid[]) AND repo.status='active'
  AND EXISTS(SELECT 1 FROM app.users viewer WHERE viewer.user_id=$2::uuid AND viewer.status='active')
  AND NOT EXISTS(
    SELECT 1 FROM app.reactions negative
    WHERE negative.user_id=$2::uuid AND negative.repo_id=repo.repo_id AND negative.reaction='dislike'
  )
ORDER BY repo.repo_id`;

export async function loadNegativePreferenceEligibleIds(
  reader: NegativePreferenceReader, viewerUserId: string, candidateRepoIds: readonly string[],
): Promise<string[]> {
  if (!uuid.test(viewerUserId)) throw new Error('Negative eligibility requires a canonical viewer UUID.');
  if (candidateRepoIds.length>MAX_NEGATIVE_ELIGIBILITY_IDS || candidateRepoIds.some(id => !uuid.test(id))) {
    throw new Error('Negative eligibility requires at most 150 canonical candidate UUIDs.');
  }
  const requested = [...new Set(candidateRepoIds)].sort();
  if (!requested.length) return [];
  const rows = await reader.query(NEGATIVE_PREFERENCE_ELIGIBILITY_SQL,[requested,viewerUserId]);
  const allowed = new Set<string>();
  for (const row of rows) {
    if (typeof row.repo_id!=='string' || !requested.includes(row.repo_id) || allowed.has(row.repo_id)) {
      throw new Error('Negative eligibility returned an unexpected canonical identity.');
    }
    allowed.add(row.repo_id);
  }
  return requested.filter(id => allowed.has(id));
}
