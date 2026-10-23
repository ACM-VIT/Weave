/** Cross-session recent exposure uses elapsed 24-hour days, defaulting to seven. */
export function feedRecentExposureDays(raw = process.env.FEED_RECENT_EXPOSURE_DAYS): number {
  if (raw === undefined || raw === '') return 7;
  const days = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error('FEED_RECENT_EXPOSURE_DAYS must be an integer from 1 to 365.');
  }
  return days;
}
