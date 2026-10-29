export const PASSWORD_POLICY = Object.freeze({minimumLength: 12, maximumLength: 128});
const policy = PASSWORD_POLICY;
export const PASSWORD_REQUIREMENTS = `Use ${policy.minimumLength}–${policy.maximumLength} characters.`;

export function passwordPolicyError(password: unknown): string | null {
  if (typeof password !== 'string' || !password.length) return 'Enter a password.';
  if (password.length < policy.minimumLength) return `Use at least ${policy.minimumLength} characters.`;
  if (password.length > policy.maximumLength) return `Use no more than ${policy.maximumLength} characters.`;
  return null;
}
