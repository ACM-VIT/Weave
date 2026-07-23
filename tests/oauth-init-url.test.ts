import assert from 'node:assert/strict';
import test from 'node:test';

import { validateOAuthInitiationUrl } from '../src/utils/oauth-init-url';

const API_URL = 'https://weave-backend.example/api';

test('OAuth initiation accepts only the backend continuation endpoint', () => {
  const url = 'https://weave-backend.example/api/auth/oauth/continue?oauth_attempt=state';
  assert.equal(validateOAuthInitiationUrl(url, API_URL), url);
});

test('OAuth initiation rejects direct provider and lookalike-host URLs', () => {
  for (const url of [
    'https://project.supabase.co/auth/v1/authorize?provider=github',
    'https://weave-backend.example.attacker.test/api/auth/oauth/continue',
    'https://attacker.test@weave-backend.example/api/auth/oauth/continue',
  ]) {
    assert.throws(
      () => validateOAuthInitiationUrl(url, API_URL),
      /incompatible authorization URL/i,
    );
  }
});

test('OAuth initiation rejects sibling and almost-matching backend paths', () => {
  for (const url of [
    'https://weave-backend.example/api/auth/oauth/github',
    'https://weave-backend.example/api/auth/oauth/continue/',
    'https://weave-backend.example/api/auth/callback',
  ]) {
    assert.throws(
      () => validateOAuthInitiationUrl(url, API_URL),
      /incompatible authorization URL/i,
    );
  }
});

test('OAuth initiation rejects missing and malformed URLs', () => {
  for (const value of [undefined, null, '', 'not a URL']) {
    assert.throws(
      () => validateOAuthInitiationUrl(value, API_URL),
      /incompatible authorization URL/i,
    );
  }
});
