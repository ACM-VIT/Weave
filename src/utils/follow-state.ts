export function getFollowIdentity(
  targetUserId?: string | null,
  fallbackIdentity?: string | null,
): string {
  const normalizedUserId = targetUserId?.trim();
  if (normalizedUserId) return normalizedUserId;

  return fallbackIdentity?.trim().toLowerCase() || 'unavailable';
}

export function followStateQueryKey(identity: string) {
  return ['user-follow-state', identity] as const;
}
