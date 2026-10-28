export type SavedAvatarProfile = {
    user_id: string;
    avatar_url: string;
    profile_version: string;
};
export interface ProfileAvatarStorage {
    put(owner: string, output: Buffer): Promise<{
        key: string;
        url: string;
    }>;
    managedKey(owner: string, url: string): string | null;
    removeOwned(owner: string, key: string): Promise<void>;
}
export interface ProfileAvatarStore {
    assertActive(owner: string, expectedVersion: string): Promise<void>;
    commit(owner: string, url: string, expectedVersion: string): Promise<{
        saved: SavedAvatarProfile;
        previousUrl: string | null;
    }>;
}
export function createProfileAvatarService(ports: {
    sanitize(input: Buffer): Promise<Buffer>;
    storage: ProfileAvatarStorage;
    store: ProfileAvatarStore;
}) {
    return { async save(owner: string, input: Buffer, expectedVersion: string): Promise<SavedAvatarProfile> {
            await ports.store.assertActive(owner, expectedVersion);
            const output = await ports.sanitize(input);
            const uploaded = await ports.storage.put(owner, output);
            let committed: Awaited<ReturnType<ProfileAvatarStore['commit']>>;
            try {
                committed = await ports.store.commit(owner, uploaded.url, expectedVersion);
            }
            catch (error) {
                // A COMMIT network failure can mean success. Never remove its object.
                if (error instanceof Error && (error as Error & {
                    avatarRollbackKnown?: boolean;
                }).avatarRollbackKnown === true) {
                    await ports.storage.removeOwned(owner, uploaded.key).catch(() => undefined);
                }
                throw error;
            }
            const oldKey = committed.previousUrl ? ports.storage.managedKey(owner, committed.previousUrl) : null;
            if (oldKey && oldKey !== uploaded.key)
                await ports.storage.removeOwned(owner, oldKey).catch(() => undefined);
            return committed.saved;
        } };
}

/** Must also run under the user row lock immediately before the update. */
export function assertProfileAvatarVersion(actual:unknown,expected:string):void {
 if(String(actual)!==expected)throw Object.assign(new Error('Your profile changed. Check the saved photo before trying again.'),{statusCode:409});
}
