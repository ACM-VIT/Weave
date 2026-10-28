import { sqlClient } from '../db/index.js';
import { avatarError } from '../services/profileAvatarImage.js';
import { assertProfileAvatarVersion, type ProfileAvatarStore } from '../services/profileAvatarService.js';
import { buildMlOnboardingJob, hasMlEmbeddingContext } from '../services/mlOnboardingService.js';
import { enqueueProfileDelivery } from '../services/modelOperationService.js';
export const postgresProfileAvatarStore: ProfileAvatarStore = {
    async assertActive(owner, expectedVersion) {
        const [row] = await sqlClient `SELECT user_id,profile_version FROM app.users WHERE user_id=${owner}::uuid AND status='active'`;
        if (!row)
            throw avatarError(404, 'Active user profile not found.');
        assertProfileAvatarVersion(row.profile_version, expectedVersion);
    },
    async commit(owner, url, expectedVersion) {
        let callbackFailed = false;
        try {
            return await sqlClient.begin(async (tx) => {
                try {
                    const [old] = await tx `SELECT avatar_url,profile_version FROM app.users WHERE user_id=${owner}::uuid AND status='active' FOR UPDATE`;
                    if (!old)
                        throw avatarError(404, 'Active user profile not found.');
                    assertProfileAvatarVersion(old.profile_version, expectedVersion);
                    const [profile] = await tx `UPDATE app.users SET avatar_url=${url},profile_version=profile_version+1,updated_at=now()
            WHERE user_id=${owner}::uuid AND status='active' RETURNING *`;
                    if (!profile)
                        throw avatarError(404, 'Active user profile not found.');
                    await tx `INSERT INTO app.user_feed_state(user_id,feed_version) VALUES(${owner}::uuid,2)
            ON CONFLICT(user_id) DO UPDATE SET feed_version=app.user_feed_state.feed_version+1,updated_at=now()`;
                    const version = Number(profile.profile_version);
                    if (!Number.isSafeInteger(version))
                        throw avatarError(503, 'Profile version exceeds the supported range.');
                    const job = buildMlOnboardingJob(owner, version, {
                        username: profile.username, fullName: profile.full_name, bio: profile.bio, githubUsername: profile.github_handle,
                        avatarUrl: url, interests: profile.interests, skills: profile.skills, techStack: profile.tech_stack,
                    });
                    if (hasMlEmbeddingContext(job.profile))
                        await enqueueProfileDelivery(tx, job);
                    return { previousUrl: old.avatar_url == null ? null : String(old.avatar_url),
                        saved: { user_id: owner, avatar_url: url, profile_version: String(profile.profile_version) } };
                }
                catch (error) {
                    callbackFailed = true;
                    throw error;
                }
            });
        }
        catch (error) {
            // A callback failure never requests COMMIT; a transport failure after the
            // callback may have committed and must retain the uploaded object.
            if (error instanceof Error)
                Object.assign(error, { avatarRollbackKnown: callbackFailed });
            throw error;
        }
    },
};
