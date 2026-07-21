import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';

import {
  clientCodeChallengeFromVerifier,
  OAuthPkceCoordinator,
  RedisOAuthAttemptStore,
  type OAuthAttemptStore,
  type OAuthPkceStorageAdapter,
  type OAuthSupabaseClient,
  type StoredOAuthAttempt,
} from '../../services/oauthPkceService.js';

const CLIENT_VERIFIER = 'v'.repeat(64);
const CLIENT_CHALLENGE = crypto
  .createHash('sha256')
  .update(CLIENT_VERIFIER, 'ascii')
  .digest('base64url');

class MemoryAttemptStore implements OAuthAttemptStore {
  readonly attempts = new Map<string, StoredOAuthAttempt>();

  async create(state: string, attempt: StoredOAuthAttempt): Promise<boolean> {
    if (this.attempts.has(state)) return false;
    this.attempts.set(state, structuredClone(attempt));
    return true;
  }

  async get(state: string): Promise<StoredOAuthAttempt | null> {
    return this.attempts.get(state) ?? null;
  }

  async consume(state: string): Promise<StoredOAuthAttempt | null> {
    const attempt = this.attempts.get(state) ?? null;
    this.attempts.delete(state);
    return attempt;
  }
}

const requestScopedClient = (storage: OAuthPkceStorageAdapter, storageKey: string) => createClient(
  'https://oauth-test.supabase.co',
  'test-anon-key',
  {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: 'pkce',
      persistSession: true,
      skipAutoInitialize: true,
      storage,
      storageKey,
    },
  },
);

test('OAuth initiation creates an S256 challenge and binds redirect state to Redis data', async () => {
  const state = 'a'.repeat(43);
  const store = new MemoryAttemptStore();
  const coordinator = new OAuthPkceCoordinator(store, requestScopedClient, {
    stateFactory: () => state,
    now: () => 1_234,
  });

  const result = await coordinator.begin(
    'github',
    'ghsocial://callback?source=github',
    new URL('https://backend.example/api/auth/callback'),
    CLIENT_CHALLENGE,
  );

  assert.equal(result.state, state);
  const authorizationUrl = new URL(result.url);
  assert.equal(authorizationUrl.searchParams.get('provider'), 'github');
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 's256');

  const callback = new URL(authorizationUrl.searchParams.get('redirect_to') ?? '');
  assert.equal(callback.origin, 'https://backend.example');
  assert.equal(callback.pathname, '/api/auth/callback');
  assert.equal(callback.searchParams.has('oauth_attempt'), false);
  assert.equal(callback.searchParams.has('state'), false);
  assert.equal(callback.searchParams.has('client_redirect'), false);

  const stored = store.attempts.get(state);
  assert.ok(stored);
  assert.equal(stored.clientRedirect, 'ghsocial://callback?source=github');
  assert.equal(stored.clientCodeChallenge, CLIENT_CHALLENGE);
  assert.equal(stored.authorizationUrl, result.url);
  assert.equal(stored.provider, 'github');
  assert.equal(stored.createdAt, 1_234);

  const verifierEntry = Object.entries(stored.pkceStorage)
    .find(([key]) => key.endsWith('-code-verifier'));
  assert.ok(verifierEntry);
  const storedVerifier: unknown = JSON.parse(verifierEntry[1]);
  assert.ok(typeof storedVerifier === 'string');
  const expectedChallenge = crypto
    .createHash('sha256')
    .update(storedVerifier)
    .digest('base64url');
  assert.equal(authorizationUrl.searchParams.get('code_challenge'), expectedChallenge);
});

test('OAuth state is consumed once and restores only its matching PKCE verifier', async () => {
  const state = 'b'.repeat(43);
  const store = new MemoryAttemptStore();
  const exchangeCapture: { body?: Record<string, unknown> } = {};

  const clientFactory = (
    storage: OAuthPkceStorageAdapter,
    storageKey: string,
  ): OAuthSupabaseClient => createClient(
    'https://oauth-test.supabase.co',
    'test-anon-key',
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        flowType: 'pkce',
        persistSession: true,
        skipAutoInitialize: true,
        storage,
        storageKey,
      },
      global: {
        fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
          assert.equal(init?.method, 'POST');
          assert.equal(typeof init?.body, 'string');
          exchangeCapture.body = JSON.parse(init.body as string) as Record<string, unknown>;
          return new Response(JSON.stringify({
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            expires_in: 3_600,
            token_type: 'bearer',
            user: {
              id: '00000000-0000-4000-8000-000000000001',
              aud: 'authenticated',
              role: 'authenticated',
              created_at: '2026-07-21T00:00:00.000Z',
              app_metadata: { provider: 'google', providers: ['google'] },
              user_metadata: {},
            },
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    },
  );

  const coordinator = new OAuthPkceCoordinator(store, clientFactory, {
    stateFactory: () => state,
  });
  await coordinator.begin(
    'google',
    'ghsocial://callback',
    new URL('https://backend.example/api/auth/callback'),
    CLIENT_CHALLENGE,
  );

  const first = await coordinator.consume(state);
  assert.ok(first);
  assert.equal(await coordinator.consume(state), null);

  const result = await coordinator.exchange(first, 'supabase-auth-code');
  assert.equal(result.error, null);
  assert.equal(result.data.user?.id, '00000000-0000-4000-8000-000000000001');
  const exchangeBody = exchangeCapture.body;
  assert.ok(exchangeBody);
  assert.equal(exchangeBody.auth_code, 'supabase-auth-code');
  assert.equal(typeof exchangeBody.code_verifier, 'string');
  assert.ok((exchangeBody.code_verifier as string).length >= 43);
});

test('OAuth continuation reads an attempt without consuming it', async () => {
  const state = 'd'.repeat(43);
  const store = new MemoryAttemptStore();
  const coordinator = new OAuthPkceCoordinator(store, requestScopedClient, {
    stateFactory: () => state,
  });
  const started = await coordinator.begin(
    'github',
    'ghsocial://callback',
    new URL('https://backend.example/api/auth/callback'),
    CLIENT_CHALLENGE,
  );

  assert.deepEqual(await coordinator.resume(state), started);
  assert.ok(await coordinator.consume(state));
  assert.equal(await coordinator.resume(state), null);
});

test('Redis attempt store uses NX, expiry, and an atomic one-time consume', async () => {
  const values = new Map<string, string>();
  const setCalls: unknown[][] = [];
  const redis = {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async set(...args: [string, string, 'EX', number, 'NX']) {
      setCalls.push(args);
      if (values.has(args[0])) return null;
      values.set(args[0], args[1]);
      return 'OK';
    },
    async eval(_script: string, _numberOfKeys: number, key: string) {
      const value = values.get(key) ?? null;
      values.delete(key);
      return value;
    },
  };
  const store = new RedisOAuthAttemptStore(redis);
  const state = 'c'.repeat(43);
  const attempt: StoredOAuthAttempt = {
    provider: 'github',
    clientRedirect: 'ghsocial://callback',
    clientCodeChallenge: CLIENT_CHALLENGE,
    authorizationUrl: 'https://oauth-test.supabase.co/auth/v1/authorize?provider=github',
    storageKey: `oauth-pkce-${state}`,
    pkceStorage: { [`oauth-pkce-${state}-code-verifier`]: 'verifier' },
    createdAt: 100,
  };

  assert.equal(await store.create(state, attempt, 300), true);
  assert.equal(await store.create(state, attempt, 300), false);
  assert.deepEqual(setCalls[0]?.slice(2), ['EX', 300, 'NX']);
  assert.deepEqual(await store.consume(state), attempt);
  assert.equal(await store.consume(state), null);
});

test('final OAuth code PKCE validates verifier syntax and derives S256 base64url', () => {
  assert.equal(clientCodeChallengeFromVerifier(CLIENT_VERIFIER), CLIENT_CHALLENGE);
  assert.equal(clientCodeChallengeFromVerifier('too-short'), null);
  assert.equal(clientCodeChallengeFromVerifier(`${'v'.repeat(63)}!`), null);
});
