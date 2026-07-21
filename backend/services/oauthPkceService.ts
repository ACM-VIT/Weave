import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export type OAuthProvider = 'github' | 'google';

export interface OAuthPkceStorageAdapter {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export class OAuthPkceStorage implements OAuthPkceStorageAdapter {
  private readonly values: Map<string, string>;

  constructor(initialValues: Record<string, string> = {}) {
    this.values = new Map(Object.entries(initialValues));
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.values);
  }
}

export interface StoredOAuthAttempt {
  provider: OAuthProvider;
  clientRedirect: string;
  clientCodeChallenge: string;
  authorizationUrl: string;
  storageKey: string;
  pkceStorage: Record<string, string>;
  createdAt: number;
}

export interface ConsumedOAuthAttempt extends StoredOAuthAttempt {
  state: string;
}

export interface OAuthAttemptStore {
  create(state: string, attempt: StoredOAuthAttempt, ttlSeconds: number): Promise<boolean>;
  get(state: string): Promise<StoredOAuthAttempt | null>;
  consume(state: string): Promise<StoredOAuthAttempt | null>;
}

interface OAuthAttemptRedis {
  get(key: string): Promise<unknown>;
  set(
    key: string,
    value: string,
    expirationMode: 'EX',
    ttlSeconds: number,
    condition: 'NX',
  ): Promise<unknown>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

const CONSUME_ATTEMPT_LUA = `
local value = redis.call('get', KEYS[1])
if not value then return nil end
redis.call('del', KEYS[1])
return value
`;

const STATE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
export const CLIENT_CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const CLIENT_CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const ATTEMPT_KEY_PREFIX = 'oauth:pkce:attempt:';

function attemptKey(state: string): string {
  return `${ATTEMPT_KEY_PREFIX}${state}`;
}

function isStoredOAuthAttempt(value: unknown): value is StoredOAuthAttempt {
  if (!value || typeof value !== 'object') return false;
  const attempt = value as Partial<StoredOAuthAttempt>;
  if (attempt.provider !== 'github' && attempt.provider !== 'google') return false;
  if (typeof attempt.clientRedirect !== 'string' || attempt.clientRedirect.length > 2_048) return false;
  if (typeof attempt.clientCodeChallenge !== 'string'
    || !CLIENT_CODE_CHALLENGE_PATTERN.test(attempt.clientCodeChallenge)) return false;
  if (typeof attempt.authorizationUrl !== 'string' || attempt.authorizationUrl.length > 8_192) return false;
  try {
    const authorizationUrl = new URL(attempt.authorizationUrl);
    if (authorizationUrl.protocol !== 'https:' && authorizationUrl.protocol !== 'http:') return false;
  } catch {
    return false;
  }
  if (typeof attempt.storageKey !== 'string' || attempt.storageKey.length > 256) return false;
  if (typeof attempt.createdAt !== 'number' || !Number.isFinite(attempt.createdAt)) return false;
  if (!attempt.pkceStorage || typeof attempt.pkceStorage !== 'object' || Array.isArray(attempt.pkceStorage)) {
    return false;
  }

  const entries = Object.entries(attempt.pkceStorage);
  return entries.length > 0
    && entries.length <= 4
    && entries.some(([key]) => key.endsWith('-code-verifier'))
    && entries.every(([key, entry]) => key.length <= 256 && typeof entry === 'string' && entry.length <= 2_048);
}

export class RedisOAuthAttemptStore implements OAuthAttemptStore {
  constructor(private readonly redis: OAuthAttemptRedis) {}

  async create(state: string, attempt: StoredOAuthAttempt, ttlSeconds: number): Promise<boolean> {
    if (!STATE_PATTERN.test(state)) throw new Error('Invalid OAuth state.');
    const result = await this.redis.set(
      attemptKey(state),
      JSON.stringify(attempt),
      'EX',
      ttlSeconds,
      'NX',
    );
    return result === 'OK';
  }

  async get(state: string): Promise<StoredOAuthAttempt | null> {
    if (!STATE_PATTERN.test(state)) return null;
    const raw = await this.redis.get(attemptKey(state));
    if (typeof raw !== 'string') return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isStoredOAuthAttempt(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async consume(state: string): Promise<StoredOAuthAttempt | null> {
    if (!STATE_PATTERN.test(state)) return null;
    const raw = await this.redis.eval(CONSUME_ATTEMPT_LUA, 1, attemptKey(state));
    if (typeof raw !== 'string') return null;

    try {
      const parsed: unknown = JSON.parse(raw);
      return isStoredOAuthAttempt(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

type OAuthAuthClient = Pick<
  SupabaseClient['auth'],
  'signInWithOAuth' | 'exchangeCodeForSession'
>;

export interface OAuthSupabaseClient {
  auth: OAuthAuthClient;
}

export type OAuthSupabaseClientFactory = (
  storage: OAuthPkceStorageAdapter,
  storageKey: string,
) => OAuthSupabaseClient;

export interface OAuthAuthorization {
  state: string;
  url: string;
}

interface OAuthPkceCoordinatorOptions {
  attemptTtlSeconds?: number;
  stateFactory?: () => string;
  now?: () => number;
}

export class OAuthPkceCoordinator {
  private readonly attemptTtlSeconds: number;
  private readonly stateFactory: () => string;
  private readonly now: () => number;

  constructor(
    private readonly store: OAuthAttemptStore,
    private readonly clientFactory: OAuthSupabaseClientFactory,
    options: OAuthPkceCoordinatorOptions = {},
  ) {
    this.attemptTtlSeconds = options.attemptTtlSeconds ?? 300;
    this.stateFactory = options.stateFactory ?? (() => crypto.randomBytes(32).toString('base64url'));
    this.now = options.now ?? Date.now;

    if (!Number.isInteger(this.attemptTtlSeconds) || this.attemptTtlSeconds < 60 || this.attemptTtlSeconds > 900) {
      throw new Error('OAuth attempt TTL must be between 60 and 900 seconds.');
    }
  }

  async begin(
    provider: OAuthProvider,
    clientRedirect: string,
    backendCallbackUrl: URL,
    clientCodeChallenge: string,
  ): Promise<OAuthAuthorization> {
    if (!CLIENT_CODE_CHALLENGE_PATTERN.test(clientCodeChallenge)) {
      throw new Error('Invalid client OAuth code challenge.');
    }
    // A collision is cryptographically implausible, but SET NX keeps the
    // invariant explicit and bounded retries prevent accidental overwrite.
    for (let tryNumber = 0; tryNumber < 3; tryNumber += 1) {
      const state = this.stateFactory();
      if (!STATE_PATTERN.test(state)) throw new Error('OAuth state generator returned an invalid value.');

      const storageKey = `oauth-pkce-${state}`;
      const storage = new OAuthPkceStorage();
      const requestClient = this.clientFactory(storage, storageKey);
      const callbackUrl = new URL(backendCallbackUrl);

      const { data, error } = await requestClient.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: callbackUrl.toString(),
          skipBrowserRedirect: true,
        },
      });
      if (error) throw new Error(`Unable to start ${provider} authentication: ${error.message}`);
      if (!data.url) throw new Error(`Supabase did not return a ${provider} authorization URL.`);

      const authorizationUrl = new URL(data.url);
      const challenge = authorizationUrl.searchParams.get('code_challenge');
      const challengeMethod = authorizationUrl.searchParams.get('code_challenge_method');
      const pkceStorage = storage.snapshot();
      if (!challenge || challengeMethod?.toLowerCase() !== 's256') {
        throw new Error('Supabase OAuth client did not create an S256 PKCE challenge.');
      }
      if (!Object.keys(pkceStorage).some((key) => key.endsWith('-code-verifier'))) {
        throw new Error('Supabase OAuth client did not retain a PKCE verifier.');
      }

      const stored = await this.store.create(state, {
        provider,
        clientRedirect,
        clientCodeChallenge,
        authorizationUrl: data.url,
        storageKey,
        pkceStorage,
        createdAt: this.now(),
      }, this.attemptTtlSeconds);
      if (stored) return { state, url: data.url };
    }

    throw new Error('Unable to allocate a unique OAuth state.');
  }

  async consume(state: unknown): Promise<ConsumedOAuthAttempt | null> {
    if (typeof state !== 'string' || !STATE_PATTERN.test(state)) return null;
    const attempt = await this.store.consume(state);
    return attempt ? { ...attempt, state } : null;
  }


  async resume(state: unknown): Promise<OAuthAuthorization | null> {
    if (typeof state !== 'string' || !STATE_PATTERN.test(state)) return null;
    const attempt = await this.store.get(state);
    return attempt ? { state, url: attempt.authorizationUrl } : null;
  }

  exchange(
    attempt: ConsumedOAuthAttempt,
    authorizationCode: string,
  ): ReturnType<OAuthAuthClient['exchangeCodeForSession']> {
    const storage = new OAuthPkceStorage(attempt.pkceStorage);
    const requestClient = this.clientFactory(storage, attempt.storageKey);
    return requestClient.auth.exchangeCodeForSession(authorizationCode);
  }
}

export function clientCodeChallengeFromVerifier(verifier: string): string | null {
  if (!CLIENT_CODE_VERIFIER_PATTERN.test(verifier)) return null;
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}
