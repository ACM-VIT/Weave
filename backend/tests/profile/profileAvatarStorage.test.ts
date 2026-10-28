import assert from 'node:assert/strict';
import test from 'node:test';
import { createProfileAvatarStorage } from '../../adapters/supabaseProfileAvatarStorage.js';
const owner = '00000000-0000-4000-8000-000000000001';
test('storage ignores filenames and generates owner-scoped immutable WebP keys', async () => {
    const calls: any[] = [];
    const bucket = { upload: async (...args: any[]) => { calls.push(args); return { error: null }; }, remove: async (...args: any[]) => { calls.push(args); return { error: null }; } };
    const storage = createProfileAvatarStorage({ storage: { from: (id: string) => { assert.equal(id, 'avatars'); return bucket; } } } as any, 'avatars', 'https://project.invalid');
    const saved = await storage.put(owner, Buffer.from('sanitized'));
    assert.match(saved.key, new RegExp(`^${owner}/[a-f0-9-]{36}\\.webp$`));
    assert.equal(calls[0][2].upsert, false);
    assert.equal(calls[0][2].contentType, 'image/webp');
    assert.equal(storage.managedKey(owner, saved.url), saved.key);
    for (const url of [saved.url + '?x=1', saved.url.replace(owner, '00000000-0000-4000-8000-000000000002'), saved.url.replace('project.invalid', 'other.invalid'), 'https://google.invalid/avatar'])
        assert.equal(storage.managedKey(owner, url), null);
    await assert.rejects(storage.removeOwned(owner, '../foreign.webp'));
    await storage.removeOwned(owner, saved.key);
    assert.deepEqual(calls[1], [[saved.key]]);
});
test('missing bucket is safely unavailable, never auto-created', () => {
    assert.throws(() => createProfileAvatarStorage({} as any, '', 'https://project.invalid'), { statusCode: 503 });
});
