import { feedExposureResetAt } from '../config/feedExposure.js';
import { NEGATIVE_PREFERENCE_ELIGIBILITY_SQL, type NegativePreferenceReader } from './negativePreferenceEligibility.js';

/** Exact candidate check; bounded ML exclusion hints are not a delivery fence. */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RECENT_EXPOSURE_ELIGIBILITY_SQL = `
WITH requested AS (SELECT unnest($1::uuid[]) AS repo_id),
recent AS MATERIALIZED (
  SELECT item.repo_id FROM telemetry.feed_serves serve
  JOIN telemetry.feed_serve_items item ON item.serve_id=serve.serve_id
  WHERE serve.user_id=$2::uuid
    AND serve.created_at>=greatest(now()-($3::integer * interval '1 second'),$4::timestamptz)
    AND item.repo_id=ANY($1::uuid[])
  UNION
  SELECT engagement.repo_id FROM telemetry.interaction_events engagement
  WHERE engagement.user_id=$2::uuid AND engagement.repo_id=ANY($1::uuid[])
    AND engagement.server_received_at>=greatest(now()-($3::integer * interval '1 second'),$4::timestamptz)
    AND (engagement.serve_id IS NULL OR EXISTS (
      SELECT 1 FROM telemetry.feed_serves origin WHERE origin.serve_id=engagement.serve_id
        AND origin.user_id=engagement.user_id AND origin.created_at>=$4::timestamptz
    ))
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
  const rows = await reader.query(RECENT_EXPOSURE_ELIGIBILITY_SQL, [requested, userId, String(days * 86400), feedExposureResetAt()]);
  const allowed = new Set<string>();
  for (const row of rows) {
    if (typeof row.repo_id !== 'string' || !requested.includes(row.repo_id) || allowed.has(row.repo_id)) {
      throw new Error('Exposure eligibility returned an unexpected canonical identity.');
    }
    allowed.add(row.repo_id);
  }
  return requested.filter(id => allowed.has(id));
}

/** One snapshot for canonical identity, preferences and exposure eligibility. */
export async function loadCandidateEligibility(
  reader: NegativePreferenceReader, userId: string, repoIds: readonly string[], days: number, sessionId?: string,
) {
  if (!uuid.test(userId) || repoIds.length > 150 || repoIds.some(id => !uuid.test(id))) {
    throw new Error('Candidate eligibility requires canonical UUIDs and at most 150 repositories.');
  }
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Invalid recent exposure window.');
  const canonicalSessionId = sessionId?.toLowerCase();
  if (canonicalSessionId !== undefined && !uuid.test(canonicalSessionId)) throw new Error('Session eligibility requires a canonical UUID.');
  const requested = [...new Set(repoIds)].sort();
  if (!requested.length) return { identities: [], preferenceIds: [], exposureIds: [], servedIds: [] };
  const rows = await reader.query(`
    WITH preference AS (${NEGATIVE_PREFERENCE_ELIGIBILITY_SQL}),
    exposure AS (${RECENT_EXPOSURE_ELIGIBILITY_SQL})
    SELECT repo.repo_id,summary.summary_id,
      EXISTS(SELECT 1 FROM preference WHERE preference.repo_id=repo.repo_id) AS preference_eligible,
      EXISTS(SELECT 1 FROM exposure WHERE exposure.repo_id=repo.repo_id) AS exposure_eligible,
      EXISTS(SELECT 1 FROM telemetry.feed_serves served JOIN telemetry.feed_serve_items item USING(serve_id)
        WHERE served.user_id=$2::uuid AND served.session_id=NULLIF($5,'')::uuid AND item.repo_id=repo.repo_id
          AND served.created_at>=$4::timestamptz) AS session_served
    FROM app.repos repo LEFT JOIN app.repo_content content USING(repo_id)
    LEFT JOIN LATERAL (
      SELECT card.summary_id FROM app.repo_card_summaries card
      WHERE card.repo_id=repo.repo_id AND card.active AND card.content_version=content.content_version
        AND card.source IN ('generated','description_fallback')
      ORDER BY card.created_at DESC LIMIT 1
    ) summary ON true
    WHERE repo.repo_id=ANY($1::uuid[]) AND repo.status='active' ORDER BY repo.repo_id`,
    [requested, userId, String(days * 86400), feedExposureResetAt(), canonicalSessionId ?? '']);
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row.repo_id !== 'string' || !requested.includes(row.repo_id) || seen.has(row.repo_id)
      || typeof row.preference_eligible !== 'boolean' || typeof row.exposure_eligible !== 'boolean') {
      throw new Error('Candidate eligibility returned an invalid result.');
    }
    seen.add(row.repo_id);
  }
  return {
    servedIds: rows.filter(row => row.session_served === true).map(row => String(row.repo_id)),
    identities: rows.map(row => ({ repo_id: String(row.repo_id), summary_id: row.summary_id == null ? null : String(row.summary_id) })),
    preferenceIds: rows.filter(row => row.preference_eligible).map(row => String(row.repo_id)),
    exposureIds: rows.filter(row => row.exposure_eligible).map(row => String(row.repo_id)),
  };
}
