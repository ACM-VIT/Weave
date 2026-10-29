export type SavedUserProfileAttributes = {
    username: string;
    full_name: string | null;
    bio: string | null;
    avatar_url?: string | null;
};
export function mergeSavedUserProfile<T extends Record<string, unknown>>(current: T | null, saved: SavedUserProfileAttributes): T | null {
    return current ? { ...current, ...saved } : null;
}
/** Apply cosmetic upload results only to their original account and generation. */
export function mergeSavedAvatar<T extends Record<string, unknown>>(current: T | null, owner: string, generationIsCurrent: boolean, saved: {
    avatar_url: string;
    profile_version: string;
}): T | null {
    if (!current || !generationIsCurrent || current.user_id !== owner)
        return current;
    try {
        if (BigInt(String(current.profile_version ?? 0)) > BigInt(saved.profile_version))
            return current;
    }
    catch {
        return current;
    }
    return { ...current, avatar_url: saved.avatar_url, profile_version: saved.profile_version };
}
/** A GET started before an upload may settle after its confirmed mutation. */
export function preserveNewerAvatar<T extends Record<string, unknown>>(current: T | null, loaded: T): T {
    if (!current || current.user_id !== loaded.user_id)
        return loaded;
    try {
        if (BigInt(String(current.profile_version ?? 0)) > BigInt(String(loaded.profile_version ?? 0))) {
            return { ...loaded, avatar_url: current.avatar_url, profile_version: current.profile_version };
        }
    }
    catch { /* Invalid versions do not gain authority over a server read. */ }
    return loaded;
}
