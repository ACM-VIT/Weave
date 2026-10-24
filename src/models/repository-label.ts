/** Additive feed metadata. Provenance and feed position are never label evidence. */
type LabelFreshness = { observed_at: string; expires_at: string };
export type RepositoryLabel = LabelFreshness & (
  | { kind: 'trending'; rank: number; period: 'daily'; source: 'github-trending' }
  | { kind: 'recent_likes'; count: number; rank: number; window_hours: 168 }
  | { kind: 'popular'; star_count: number }
);

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const instant = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));

/** Reject unknown/malformed/expired metadata; retain normal source copy instead. */
export function parseRepositoryLabel(value: unknown, now = Date.now()): RepositoryLabel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!instant(row.observed_at) || !instant(row.expires_at)
    || Date.parse(row.observed_at) > now || Date.parse(row.expires_at) <= now
    || Date.parse(row.expires_at) <= Date.parse(row.observed_at)) return null;
  const freshness = { observed_at: row.observed_at, expires_at: row.expires_at };
  switch (row.kind) {
    case 'trending':
      return positiveInteger(row.rank) && row.rank <= 10
        && row.period === 'daily' && row.source === 'github-trending'
        ? { ...freshness, kind: 'trending', rank: row.rank, period: row.period, source: row.source } : null;
    case 'recent_likes':
      return positiveInteger(row.rank) && row.rank <= 10 && positiveInteger(row.count)
        && row.window_hours === 168
        ? { ...freshness, kind: 'recent_likes', count: row.count, rank: row.rank, window_hours: row.window_hours } : null;
    case 'popular':
      return positiveInteger(row.star_count)
        ? { ...freshness, kind: 'popular', star_count: row.star_count } : null;
    default:
      return null;
  }
}
