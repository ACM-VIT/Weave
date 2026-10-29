/** Cross-session recent exposure uses elapsed 24-hour days, defaulting to seven. */
export function feedRecentExposureDays(raw = process.env.FEED_RECENT_EXPOSURE_DAYS): number {
  if (raw === undefined || raw === '') return 7;
  const days = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error('FEED_RECENT_EXPOSURE_DAYS must be an integer from 1 to 365.');
  }
  return days;
}

/** Operator-triggered global history reset; durable telemetry remains unchanged.
 * UTC ISO format: YYYY-MM-DDTHH:mm:ss[.SSS]Z, never a future time; unset means epoch.
 * Stop API/feed preparation, advance affected users' feed_version, and restart all
 * API/worker replicas with the same fixed cutoff to abandon old queue exclusions.
 * Keep that cutoff unchanged afterward; new deliveries are still deduplicated.
 */
export function feedExposureResetAt(raw = process.env.FEED_EXPOSURE_RESET_AT): string {
  if (raw === undefined || raw === '') return '1970-01-01T00:00:00.000Z';
  const value = Date.parse(raw);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw)
    || !Number.isFinite(value) || value > Date.now()
    || new Date(value).toISOString().replace('.000Z', 'Z') !== raw.replace('.000Z', 'Z')) {
    throw new Error('FEED_EXPOSURE_RESET_AT must be a valid UTC ISO timestamp in the past.');
  }
  return new Date(value).toISOString();
}
