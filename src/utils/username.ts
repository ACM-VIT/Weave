export const USERNAME_MAX_LENGTH = 50;
export const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;

export function normalizeUsername(value: string): string {
  return value.trim();
}

export function isValidUsername(value: string): boolean {
  return USERNAME_PATTERN.test(normalizeUsername(value));
}

export const USERNAME_GUIDANCE = 'Use 1–50 letters, numbers, underscores, or hyphens.';
