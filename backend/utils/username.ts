export const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;

export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return USERNAME_PATTERN.test(normalized) ? normalized : null;
}
