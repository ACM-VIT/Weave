import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { assertDisposableDatabase } from './disposableDatabase.js';
const enabled = process.env.RUN_DATABASE_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();
const integration = enabled ? test : test.skip;
integration('real SQL preserves custom photos on provider login and rolls avatar/profile versions back together', async () => {
    const [{ sqlClient }, { ensureIdentityProfile }, { postgresProfileAvatarStore }] = await Promise.all([
        import('../../db/index.js'), import('../../services/identityService.js'), import('../../adapters/postgresProfileAvatarStore.js'),
    ]);
    const owner = randomUUID(), username = 'photo_' + owner.replaceAll('-', '').slice(0, 20);
    try {
        await sqlClient `INSERT INTO auth.users(id,raw_user_meta_data) VALUES(${owner}::uuid,'{}'::jsonb)`;
        await ensureIdentityProfile({ userId: owner, username, avatarUrl: 'https://provider.invalid/initial.jpg' });
        const saved = await postgresProfileAvatarStore.commit(owner, 'https://storage.invalid/custom.webp', '1');
        assert.equal(saved.previousUrl, 'https://provider.invalid/initial.jpg');
        await ensureIdentityProfile({ userId: owner, username, avatarUrl: 'https://provider.invalid/new.jpg' });
        let [row] = await sqlClient `SELECT avatar_url,profile_version FROM app.users WHERE user_id=${owner}::uuid`;
        assert.equal(row.avatar_url, 'https://storage.invalid/custom.webp');
        assert.equal(String(row.profile_version), '2');
        await Promise.all([
            ensureIdentityProfile({ userId: owner, username, avatarUrl: 'https://provider.invalid/racing.jpg' }),
            postgresProfileAvatarStore.commit(owner, 'https://storage.invalid/racing-custom.webp', '2'),
        ]);
        [row] = await sqlClient `SELECT avatar_url FROM app.users WHERE user_id=${owner}::uuid`;
        assert.equal(row.avatar_url, 'https://storage.invalid/racing-custom.webp');
        await assert.rejects(postgresProfileAvatarStore.commit(owner, 'https://storage.invalid/stale.webp', '2'), { statusCode: 409, avatarRollbackKnown: true });
        await sqlClient `UPDATE app.users SET profile_version=9007199254740991 WHERE user_id=${owner}::uuid`;
        await assert.rejects(postgresProfileAvatarStore.commit(owner, 'https://storage.invalid/must-rollback.webp', '9007199254740991'), { avatarRollbackKnown: true });
        [row] = await sqlClient `SELECT avatar_url,profile_version FROM app.users WHERE user_id=${owner}::uuid`;
        assert.equal(row.avatar_url, 'https://storage.invalid/racing-custom.webp');
        assert.equal(String(row.profile_version), '9007199254740991');
    }
    finally {
        await sqlClient `DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${owner}::uuid`;
        await sqlClient `DELETE FROM app.users WHERE user_id=${owner}::uuid`;
        await sqlClient `DELETE FROM auth.users WHERE id=${owner}::uuid`;
        await sqlClient.end({ timeout: 0 });
    }
});
