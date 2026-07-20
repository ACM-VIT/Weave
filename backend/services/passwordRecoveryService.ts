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
  | "update-failed";

export async function updatePasswordFromRecoverySession(
  auth: RecoveryAuthClient,
  tokens: RecoveryTokens,
  password: string,
): Promise<PasswordRecoveryResult> {
  const { data, error } = await auth.setSession(tokens);
  if (error || !data.session) return "invalid-session";

  const { error: updateError } = await auth.updateUser({ password });
  return updateError ? "update-failed" : "updated";
}
