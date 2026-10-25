import redis from '../config/redis.js';
import { createAvatarStorageClient } from '../config/supabase.js';
import { createProfileAvatarStorage } from '../adapters/supabaseProfileAvatarStorage.js';
import { postgresProfileAvatarStore } from '../adapters/postgresProfileAvatarStore.js';
import { createProfileAvatarService } from '../services/profileAvatarService.js';
import { sanitizeProfileAvatar, avatarError } from '../services/profileAvatarImage.js';
import { createProfileAvatarRouter } from '../routes/profileAvatarRoutes.js';
export const profileAvatarRoutes = createProfileAvatarRouter({
    async admit(owner) {
        let count: number;
        try {
            count = Number(await redis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n", 1, `rate:avatar:${owner.toLowerCase()}`));
        }
        catch {
            throw avatarError(503, 'Photo upload admission is unavailable.');
        }
        if (!Number.isFinite(count))
            throw avatarError(503, 'Photo upload admission is unavailable.');
        if (count > 5)
            throw avatarError(429, 'Too many photo uploads. Try again in one minute.');
    },
    async save(owner, input, expectedVersion) {
        const bucket = process.env.PROFILE_AVATAR_BUCKET ?? '';
        if (!bucket)
            throw avatarError(503, 'Photo uploads are not configured yet.');
        const storage = createProfileAvatarStorage(createAvatarStorageClient(), bucket, process.env.SUPABASE_URL!);
        return createProfileAvatarService({ storage, store: postgresProfileAvatarStore, sanitize: sanitizeProfileAvatar }).save(owner, input, expectedVersion);
    },
});
