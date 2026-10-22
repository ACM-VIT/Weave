export function getFollowIdentity(
  targetUserId?: string | null,
  fallbackIdentity?: string | null,
): string {
  const normalizedUserId = targetUserId?.trim();
  if (normalizedUserId) return normalizedUserId;

  return fallbackIdentity?.trim().toLowerCase() || 'unavailable';
}

export function followStateQueryKey(identity: string, viewer?: string | null) {
  return ['user-follow-state', viewer ?? null, identity] as const;
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
