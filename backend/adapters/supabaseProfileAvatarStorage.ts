import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProfileAvatarStorage } from '../services/profileAvatarService.js';
import { avatarError } from '../services/profileAvatarImage.js';
import { isValidUuid } from '../utils/validators.js';
export function createProfileAvatarStorage(client: SupabaseClient, bucket: string, baseUrl: string): ProfileAvatarStorage {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(bucket))
        throw avatarError(503, 'Photo uploads are not configured yet.');
    const prefix = `${baseUrl.replace(/\/$/, '')}/storage/v1/object/public/${encodeURIComponent(bucket)}/`;
    function owned(owner: string, key: string): boolean {
        return isValidUuid(owner) && key.startsWith(`${owner.toLowerCase()}/`)
            && /^[a-f0-9-]{36}\.webp$/.test(key.slice(37)) && isValidUuid(key.slice(37, -5));
    }
    return {
        async put(owner, output) {
            if (!isValidUuid(owner))
                throw avatarError(400, 'Invalid photo owner.');
            const key = `${owner.toLowerCase()}/${randomUUID()}.webp`;
            const { error } = await client.storage.from(bucket).upload(key, output, { contentType: 'image/webp', cacheControl: '3600', upsert: false });
            if (error)
                throw avatarError(503, 'Photo storage is unavailable. Please try again later.');
            return { key, url: prefix + key };
        },
        managedKey(owner, url) {
            const key = url.startsWith(prefix) ? url.slice(prefix.length) : '';
            return owned(owner, key) ? key : null;
        },
        async removeOwned(owner, key) {
            if (!owned(owner, key))
                throw avatarError(400, 'Invalid photo object.');
            const { error } = await client.storage.from(bucket).remove([key]);
            if (error)
                throw avatarError(503, 'Photo cleanup is unavailable.');
        },
    };
}
