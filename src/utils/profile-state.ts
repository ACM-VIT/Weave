export type SavedUserProfileAttributes = {
  username: string;
  full_name: string | null;
  bio: string | null;
  avatar_url?: string | null;
};

export function mergeSavedUserProfile<T extends Record<string, unknown>>(
  current: T | null,
  saved: SavedUserProfileAttributes,
): T | null {
  return current ? { ...current, ...saved } : null;
}
