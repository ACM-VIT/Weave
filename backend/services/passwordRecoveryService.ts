import { isValidUuid } from '../utils/validators.js';

type RecoveryTokens = {
  access_token: string;
  refresh_token: string;
};

type RecoveryAuthClient = {
  setSession(tokens: RecoveryTokens): Promise<{
    data: { session: { user?: { id?: string } } | null };
    error: unknown | null;
  }>;
  updateUser(attributes: { password: string }): Promise<{
    error: unknown | null;
  }>;
};

export type PasswordRecoveryResult =
  | "updated"
  | "invalid-session"
  | "session-unavailable"
  | "update-failed";

export async function updatePasswordFromRecoverySession(
  auth: RecoveryAuthClient,
  tokens: RecoveryTokens,
  password: string,
  revokeSessions: (userId: string) => Promise<void>,
): Promise<PasswordRecoveryResult> {
  const { data, error } = await auth.setSession(tokens);
  if (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error
      ? (error as {status: unknown}).status : undefined;
    // Only an explicit credential rejection proves the recovery link unusable.
    // Rate limits, provider outages and unknown transport failures remain retryable.
    return status === 400 || status === 401 || status === 403 ? "invalid-session" : "session-unavailable";
  }
  const userId = data.session?.user?.id;
  if (!userId || !isValidUuid(userId)) return "invalid-session";

  // Revoke first so a database outage cannot change the password while leaving
  // the old app credentials renewable. Repeat after success to fence work that
  // started while the provider was updating the password.
  await revokeSessions(userId);
  const { error: updateError } = await auth.updateUser({ password });
  if (updateError) return "update-failed";
  await revokeSessions(userId);
  return "updated";
}
