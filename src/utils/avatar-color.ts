const AVATAR_COLOR_PALETTE = [
  '#7459C8',
  '#337CB8',
  '#B64F6A',
  '#328568',
  '#B66A3C',
  '#8B5BA1',
  '#3E7F89',
  '#9A713F',
] as const;

/**
 * Maps a stable user identifier to one of Weave's dark-theme avatar colors.
 * FNV-1a gives a better spread for similar usernames than summing character codes.
 */
export function getAvatarColor(identifier: string): string {
  const normalizedIdentifier = identifier.trim().toLowerCase() || 'weave-user';
  let hash = 0x811c9dc5;

  for (let index = 0; index < normalizedIdentifier.length; index += 1) {
    hash ^= normalizedIdentifier.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return AVATAR_COLOR_PALETTE[(hash >>> 0) % AVATAR_COLOR_PALETTE.length];
}
