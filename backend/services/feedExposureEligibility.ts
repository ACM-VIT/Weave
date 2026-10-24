import type { NegativePreferenceReader } from './negativePreferenceEligibility.js';

/** Exact candidate check; bounded ML exclusion hints are not a delivery fence. */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RECENT_EXPOSURE_ELIGIBILITY_SQL = `
WITH requested AS (SELECT unnest($1::uuid[]) AS repo_id),
recent AS MATERIALIZED (
  SELECT item.repo_id FROM telemetry.feed_serves serve
  JOIN telemetry.feed_serve_items item ON item.serve_id=serve.serve_id
  WHERE serve.user_id=$2::uuid
    AND serve.created_at>=now()-($3::integer * interval '1 second')
    AND item.repo_id=ANY($1::uuid[])
  UNION
  SELECT engagement.repo_id FROM telemetry.interaction_events engagement
  WHERE engagement.user_id=$2::uuid AND engagement.repo_id=ANY($1::uuid[])
    AND engagement.server_received_at>=now()-($3::integer * interval '1 second')
)
SELECT requested.repo_id FROM requested
WHERE NOT EXISTS(SELECT 1 FROM recent WHERE recent.repo_id=requested.repo_id)
ORDER BY requested.repo_id`;

export async function loadRecentExposureEligibleIds(
  reader: NegativePreferenceReader, userId: string, repoIds: readonly string[], days: number,
): Promise<string[]> {
  if (!uuid.test(userId) || repoIds.length > 150 || repoIds.some(id => !uuid.test(id))) {
    throw new Error('Exposure eligibility requires a canonical viewer and at most 150 canonical repository UUIDs.');
  }
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Invalid recent exposure window.');
  const requested = [...new Set(repoIds)].sort();
  if (!requested.length) return [];
  const rows = await reader.query(RECENT_EXPOSURE_ELIGIBILITY_SQL, [requested, userId, String(days * 86400)]);
  const allowed = new Set<string>();
  for (const row of rows) {
    if (typeof row.repo_id !== 'string' || !requested.includes(row.repo_id) || allowed.has(row.repo_id)) {
      throw new Error('Exposure eligibility returned an unexpected canonical identity.');
    }
    allowed.add(row.repo_id);
  }
  return requested.filter(id => allowed.has(id));
}
