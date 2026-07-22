const DATE_OF_BIRTH_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateOfBirth(value: unknown, today = new Date()): value is string {
  if (typeof value !== 'string' || !DATE_OF_BIRTH_PATTERN.test(value)) return false;

  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day) return false;

  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return year >= 1900 && parsed.getTime() <= todayUtc;
}
