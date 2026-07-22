import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSyntheticCodeChallenge,
  preflightOAuthContract,
  validateOAuthContinuationUrl,
} from '../scripts/oauth-contract-preflight.mjs';
import {
  validatedAndroidArchitectures,
  validatedBackendUrl,
} from '../scripts/build-android-artifact.mjs';

const BACKEND_URL = 'https://weave-backend.example/api';

test('artifact configuration requires a public HTTPS API and supported ABIs', () => {
  assert.equal(
    validatedBackendUrl('https://weave-backend.example/api///'),
    BACKEND_URL,
  );
  assert.equal(validatedAndroidArchitectures('arm64-v8a, arm64-v8a,x86_64'), 'arm64-v8a,x86_64');

  for (const backendUrl of [
    'http://weave-backend.example/api',
    'https://localhost/api',
    'https://127.0.0.1/api',
    'https://10.0.2.2/api',
    'https://[::1]/api',
    'https://user:secret@weave-backend.example/api',
    'https://weave-backend.example/api?target=other',
  ]) {
    assert.throws(() => validatedBackendUrl(backendUrl), /Artifact backend URL/i);
  }
  assert.throws(() => validatedAndroidArchitectures('arm64-v8a,mips'), /architectures/i);
});

test('artifact OAuth preflight uses secure S256-shaped challenges', () => {
  const first = createSyntheticCodeChallenge();
  const second = createSyntheticCodeChallenge();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.match(second, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
});

test('artifact OAuth preflight checks both providers against the current broker contract', async () => {
  const requests: URL[] = [];
  const fetchImpl = async (input: URL | RequestInfo) => {
    const requestUrl = new URL(input.toString());
    requests.push(requestUrl);
    const provider = requestUrl.pathname.endsWith('/github') ? 'github' : 'google';
    return new Response(JSON.stringify({
      success: true,
      data: {
        url: `${BACKEND_URL}/auth/oauth/continue?oauth_attempt=${provider === 'github' ? 'g' : 'o'}${'a'.repeat(42)}`,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const results = await preflightOAuthContract(BACKEND_URL, {
    fetchImpl,
    challengeFactory: () => 'c'.repeat(43),
  });

  assert.equal(results.length, 2);
  assert.deepEqual(
    requests.map((request) => request.pathname).sort(),
    ['/api/auth/oauth/github', '/api/auth/oauth/google'],
  );
  for (const request of requests) {
    assert.equal(request.searchParams.get('redirect_uri'), 'ghsocial://callback');
    assert.equal(request.searchParams.get('code_challenge'), 'c'.repeat(43));
    assert.equal(request.searchParams.get('auth_intent'), 'login');
  }
});

test('artifact OAuth preflight rejects the stale direct-Supabase contract', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    success: true,
    data: { url: 'https://project.supabase.co/auth/v1/authorize?provider=github' },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  await assert.rejects(
    preflightOAuthContract(BACKEND_URL, {
      fetchImpl,
      challengeFactory: () => 'c'.repeat(43),
    }),
    /expected the deployed backend continuation contract/i,
  );
});

test('artifact OAuth continuation validation requires an exact path and attempt state', () => {
  for (const url of [
    'https://weave-backend.example/api/auth/oauth/continue',
    `https://weave-backend.example/api/auth/oauth/continue/?oauth_attempt=${'a'.repeat(43)}`,
    `https://attacker.example/api/auth/oauth/continue?oauth_attempt=${'a'.repeat(43)}`,
  ]) {
    assert.throws(
      () => validateOAuthContinuationUrl(url, BACKEND_URL, 'github'),
      /expected the deployed backend continuation contract/i,
    );
  }
});
