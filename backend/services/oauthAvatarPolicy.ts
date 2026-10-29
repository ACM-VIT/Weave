interface AvatarAuthUser {
    identities?: Array<{
        provider?: string;
        identity_data?: Record<string, unknown>;
    }> | null;
    user_metadata?: Record<string, unknown>;
}
function avatarUrl(value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 2048)
        return null;
    try {
        const url = new URL(value.trim());
        return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
    }
    catch {
        return null;
    }
}
/** Only a server-owned OAuth attempt permits the fresh-user metadata fallback. */
export function oauthAvatarFromAuthUser(user: AvatarAuthUser, provider?: 'google' | 'github'): string | null {
    const identity = user.identities?.find(item => item.provider === (provider ?? 'google'))
        ?? (!provider ? user.identities?.find(item => item.provider === 'github') : undefined);
    const metadata = identity?.identity_data ?? (provider ? user.user_metadata : undefined);
    return avatarUrl(metadata?.picture) ?? avatarUrl(metadata?.avatar_url);
}
