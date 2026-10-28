import assert from 'node:assert/strict';
import test from 'node:test';
import { oauthAvatarFromAuthUser } from '../../services/oauthAvatarPolicy.js';
test('Google picture is taken from the matching linked identity, not another provider', () => {
    const user = { identities: [
            { provider: 'github', identity_data: { avatar_url: 'https://github.invalid/old.png' } },
            { provider: 'google', identity_data: { picture: 'https://google.invalid/new.png' } },
        ], user_metadata: { avatar_url: 'https://wrong.invalid/meta.png' } };
    assert.equal(oauthAvatarFromAuthUser(user, 'google'), 'https://google.invalid/new.png');
    assert.equal(oauthAvatarFromAuthUser(user, 'github'), 'https://github.invalid/old.png');
});
test('fresh provider metadata fallback is attempt-bound and unsafe URLs are ignored', () => {
    assert.equal(oauthAvatarFromAuthUser({ user_metadata: { picture: 'https://google.invalid/a' } }, 'google'), 'https://google.invalid/a');
    assert.equal(oauthAvatarFromAuthUser({ user_metadata: { picture: 'https://google.invalid/a' } }), null);
    for (const picture of ['', 'http://example.invalid/a', 'data:image/svg+xml,x', 'https://u:p@example.invalid/a', 'https://example.invalid/' + 'a'.repeat(2048)]) {
        assert.equal(oauthAvatarFromAuthUser({ identities: [{ provider: 'google', identity_data: { picture } }] }, 'google'), null);
    }
});
