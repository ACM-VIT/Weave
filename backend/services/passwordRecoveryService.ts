type RecoveryTokens = {
  access_token: string;
  refresh_token: string;
};

type RecoveryAuthClient = {
  setSession(tokens: RecoveryTokens): Promise<{
    data: { session: unknown | null };
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
): Promise<PasswordRecoveryResult> {
  const { data, error } = await auth.setSession(tokens);
  if (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error
      ? (error as {status: unknown}).status : undefined;
    // Only an explicit credential rejection proves the recovery link unusable.
    // Rate limits, provider outages and unknown transport failures remain retryable.
    return status === 400 || status === 401 || status === 403 ? "invalid-session" : "session-unavailable";
  }
  if (!data.session) return "invalid-session";

  const { error: updateError } = await auth.updateUser({ password });
  return updateError ? "update-failed" : "updated";
}
