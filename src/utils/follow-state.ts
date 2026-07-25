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

export function getProfileFollowIdentity(
  targetProfileId?: string | null,
  targetUserId?: string | null,
  fallbackIdentity?: string | null,
): string {
  const normalizedProfileId = targetProfileId?.trim();
  if (normalizedProfileId) return `profile:${normalizedProfileId}`;
  return getFollowIdentity(targetUserId, fallbackIdentity);
}
