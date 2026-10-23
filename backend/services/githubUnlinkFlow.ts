import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import {
  OAuthPkceCoordinator, RedisOAuthAttemptStore, clientCodeChallengeFromVerifier,
  type OAuthAttemptStore, type OAuthPkceStorageAdapter, type OAuthSupabaseClientFactory, type StoredOAuthAttempt,
} from './oauthPkceService.js';
import { isValidUuid } from '../utils/validators.js';

const PURPOSE = 'github-unlink-v1';
const TTL = 300;
const opaque = /^[A-Za-z0-9_-]{43}$/;
const numeric = /^[1-9][0-9]{0,18}$/;
const fail = (message: string, statusCode = 409, unlinkReason?: string) => Object.assign(new Error(message), { statusCode, unlinkReason });
export interface GithubUnlinkOwner { userId: string; githubId: string }
export interface GithubUnlinkIdentity { identityId: string; provider: string; subject: string | null }
export interface GithubUnlinkUser { userId: string; identities: GithubUnlinkIdentity[] }
export interface GithubUnlinkPersistence {
  owner(userId: string): Promise<GithubUnlinkOwner>;
  prepare(owner: GithubUnlinkOwner, operationId: string): Promise<void>;
  complete(owner: GithubUnlinkOwner, operationId: string): Promise<'done' | 'superseded'>;
  refused(owner: GithubUnlinkOwner, operationId: string): Promise<void>;
  operation(userId: string): Promise<(GithubUnlinkOwner & { operationId: string; status: string }) | null>;
}
export interface GithubUnlinkProvider {
  user(accessToken: string): Promise<GithubUnlinkUser>;
  unlink(accessToken: string, identityId: string): Promise<void>;
  inspect(userId: string): Promise<GithubUnlinkUser>;
}
export interface GithubUnlinkRedis {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, mode: 'EX', seconds: number, condition: 'NX'): Promise<unknown>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}
interface OwnedAttempt extends StoredOAuthAttempt { unlinkPurpose: typeof PURPOSE; ownerUserId: string; ownerGithubId: string }
interface SessionProof { purpose: typeof PURPOSE; ownerUserId: string; ownerGithubId: string; challenge: string; issuedAt: number; accessToken: string }
interface SealedProof { purpose: typeof PURPOSE; ownerUserId: string; challenge: string; issuedAt: number; nonce: string; tag: string; ciphertext: string }

function attemptRedis(redis: GithubUnlinkRedis): GithubUnlinkRedis {
  const scope = (key: string) => key.replace(/^oauth:pkce:attempt:/, 'oauth:github-unlink:attempt:');
  return { get: key => redis.get(scope(key)), set: (key, value, mode, seconds, condition) => redis.set(scope(key), value, mode, seconds, condition),
    eval: (script, count, ...args) => redis.eval(script, count, ...args.map((value, index) => index < count ? scope(value) : value)) };
}
class OwnedAttemptStore implements OAuthAttemptStore {
  private readonly base: RedisOAuthAttemptStore;
  constructor(redis: GithubUnlinkRedis, private readonly owner?: GithubUnlinkOwner) { this.base = new RedisOAuthAttemptStore(attemptRedis(redis)); }
  async create(state: string, attempt: StoredOAuthAttempt, seconds: number) {
    if (!this.owner || Object.keys(attempt.pkceStorage).some(key => !key.endsWith('-code-verifier'))) throw fail('Invalid unlink authorization purpose.', 400);
    const value: OwnedAttempt = { ...attempt, unlinkPurpose: PURPOSE, ownerUserId: this.owner.userId, ownerGithubId: this.owner.githubId };
    return this.base.create(state, value, seconds);
  }
  private owned(value: StoredOAuthAttempt | null): OwnedAttempt | null {
    const attempt = value as OwnedAttempt | null;
    return attempt?.unlinkPurpose === PURPOSE && attempt.provider === 'github' && attempt.authIntent === 'login'
      && isValidUuid(attempt.ownerUserId) && numeric.test(attempt.ownerGithubId) ? attempt : null;
  }
  async get(state: string) { return this.owned(await this.base.get(state)); }
  async consume(state: string) { return this.owned(await this.base.consume(state)); }
}

const TAKE_PROOF = `
local raw=redis.call('get',KEYS[1])
if not raw then return nil end
local ok,value=pcall(cjson.decode,raw)
if not ok or value.purpose~=ARGV[1] or value.ownerUserId~=ARGV[2] or value.challenge~=ARGV[3] then return nil end
redis.call('del',KEYS[1])
return raw
`;

export class GithubUnlinkFlow {
  private readonly cipherKey: Buffer;
  constructor(private readonly options: {
    redis: GithubUnlinkRedis; clientFactory: OAuthSupabaseClientFactory; persistence: GithubUnlinkPersistence;
    provider: GithubUnlinkProvider; revokeImport: (userId: string) => Promise<unknown>; secret: string; now?: () => number;
  }) {
    if (!options.secret) throw new Error('The backend authentication secret is required for unlink proofs.');
    this.cipherKey = Buffer.from(crypto.hkdfSync('sha256', options.secret, PURPOSE, 'supabase-session-capsule', 32));
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private recent(issuedAt: number) { return Number.isSafeInteger(issuedAt) && issuedAt <= this.now() + 5_000 && this.now() - issuedAt < TTL * 1_000; }
  private coordinator(store: OAuthAttemptStore) { return new OAuthPkceCoordinator(store, this.options.clientFactory, { attemptTtlSeconds: TTL, now: () => this.now() }); }
  private identity(user: GithubUnlinkUser, owner: GithubUnlinkOwner, requireAlternative: boolean) {
    if (user.userId !== owner.userId) throw fail('Reauthenticate the same Weave account.');
    const identities = new Map(user.identities.filter(identity => isValidUuid(identity.identityId)).map(identity => [identity.identityId, identity]));
    if (requireAlternative && identities.size < 2) throw fail('GitHub is your only login identity. Add another login method before disconnecting it.', 409, 'last_identity');
    const github = [...identities.values()].find(identity => identity.provider === 'github' && identity.subject === owner.githubId);
    if (!github || !isValidUuid(github.identityId)) throw fail('The current verified GitHub identity does not match this authorization.');
    return github;
  }
  async start(userId: string, clientRedirect: string, callback: URL, challenge: string) {
    const owner = await this.options.persistence.owner(userId);
    const store = new OwnedAttemptStore(this.options.redis, owner);
    return this.coordinator(store).begin('github', clientRedirect, callback, challenge, 'login');
  }
  async continuation(state: string) {
    if (!opaque.test(state)) throw fail('Invalid or expired unlink authorization.', 400);
    const attempt = await new OwnedAttemptStore(this.options.redis).get(state);
    if (!attempt || !this.recent(attempt.createdAt)) throw fail('Invalid or expired unlink authorization.', 400);
    return { url: attempt.authorizationUrl };
  }
  async callback(state: string, code: string) {
    if (!opaque.test(state) || !code || code.length > 4_096) throw fail('Invalid unlink authorization.', 400);
    const store = new OwnedAttemptStore(this.options.redis);
    const attempt = await store.consume(state);
    if (!attempt || !this.recent(attempt.createdAt)) throw fail('The unlink authorization expired. Start again.', 400);
    try {
      const result = await this.coordinator(store).exchange({ ...attempt, state }, code);
      if (result.error || !result.data.session?.access_token) throw fail('GitHub reauthentication failed.', 401);
      const owner = await this.options.persistence.owner(attempt.ownerUserId);
      if (owner.githubId !== attempt.ownerGithubId) throw fail('The verified GitHub account changed.');
      const accessToken = result.data.session.access_token;
      this.identity(await this.options.provider.user(accessToken), owner, true);
      const proof: SessionProof = { purpose: PURPOSE, ownerUserId: owner.userId, ownerGithubId: owner.githubId,
        challenge: attempt.clientCodeChallenge, issuedAt: this.now(), accessToken };
      if (Buffer.byteLength(JSON.stringify(proof)) > 32_768) throw fail('The provider session exceeds its supported bound.', 503);
      for (let collision = 0; collision < 3; collision++) {
        const completion = crypto.randomBytes(32).toString('base64url');
        const nonce = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.cipherKey, nonce);
        cipher.setAAD(Buffer.from(`${PURPOSE}:${completion}`));
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(proof), 'utf8'), cipher.final()]);
        const sealed: SealedProof = { purpose: PURPOSE, ownerUserId: owner.userId, challenge: proof.challenge, issuedAt: proof.issuedAt,
          nonce: nonce.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
        if (await this.options.redis.set(`oauth:github-unlink:proof:${completion}`, JSON.stringify(sealed), 'EX', TTL, 'NX') === 'OK') {
          return { clientRedirect: attempt.clientRedirect, completion };
        }
      }
      throw fail('Unable to allocate unlink confirmation. Start again.', 503);
    } catch (error) {
      if (error instanceof Error) Object.assign(error, { clientRedirect: attempt.clientRedirect });
      throw error;
    }
  }
  async finish(userId: string, completion: string, verifier: string) {
    const challenge = clientCodeChallengeFromVerifier(verifier);
    if (!opaque.test(completion) || !challenge) throw fail('Invalid unlink confirmation.', 400);
    const raw = await this.options.redis.eval(TAKE_PROOF, 1, `oauth:github-unlink:proof:${completion}`, PURPOSE, userId, challenge);
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 65_536) throw fail('Unlink confirmation expired or belongs to another account.', 400);
    let proof: SessionProof;
    try {
      const sealed = JSON.parse(raw) as SealedProof;
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.cipherKey, Buffer.from(sealed.nonce, 'base64url'));
      decipher.setAAD(Buffer.from(`${PURPOSE}:${completion}`)); decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
      proof = JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64url')), decipher.final()]).toString('utf8')) as SessionProof;
      if (proof.purpose !== PURPOSE || proof.ownerUserId !== userId || proof.challenge !== challenge || !this.recent(proof.issuedAt)) throw new Error('Invalid proof binding.');
    } catch { throw fail('Invalid or expired unlink confirmation.', 400); }
    const owner = await this.options.persistence.owner(userId);
    if (owner.githubId !== proof.ownerGithubId) throw fail('The verified GitHub account changed.');
    let freshUser: GithubUnlinkUser;
    try { freshUser = await this.options.provider.user(proof.accessToken); }
    catch { throw fail('The recent provider session could not be verified. Reauthenticate again.', 409, 'reauthentication_required'); }
    const identity = this.identity(freshUser, owner, true);
    const operationId = crypto.randomUUID();
    await this.options.persistence.prepare(owner, operationId);
    // Persist the fence before revocation, so concurrent previews cannot restore consent.
    await this.options.revokeImport(userId);
    try { await this.options.provider.unlink(proof.accessToken, identity.identityId); }
    catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
      if (status >= 400 && status < 500) {
        await this.options.persistence.refused(owner, operationId);
        return { status: 'refused', operation_id: operationId, message: 'Activity import was revoked, but the provider refused to disconnect GitHub. The login remains linked.' };
      }
      return { status: 'pending', operation_id: operationId, message: 'The provider outcome needs verification. Check unlink status before retrying.' };
    }
    try { return { status: await this.options.persistence.complete(owner, operationId), operation_id: operationId }; }
    catch { return { status: 'pending', operation_id: operationId, message: 'GitHub accepted the unlink. Product cleanup is pending verification.' }; }
  }
  async reconcile(userId: string) {
    const operation = await this.options.persistence.operation(userId);
    if (!operation || operation.status !== 'prepared') return operation ? { status: operation.status, operation_id: operation.operationId } : { status: 'none' };
    const user = await this.options.provider.inspect(userId);
    if (user.userId !== userId) throw fail('Provider verification returned the wrong account.', 503);
    if (user.identities.some(identity => identity.provider === 'github' && identity.subject === operation.githubId)) {
      return { status: 'pending', operation_id: operation.operationId, message: 'GitHub still reports this identity. Reauthenticate to retry, or check again later.' };
    }
    return { status: await this.options.persistence.complete(operation, operation.operationId), operation_id: operation.operationId };
  }
}

/** Fresh provider credentials stay backend-only; SDK requests cannot leave its configured origin. */
export function createGithubUnlinkClients(options: { url: string; anonKey: string; serviceKey: string; fetch?: typeof fetch }) {
  const configured = new URL(options.url);
  if (configured.protocol !== 'https:' && !(configured.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname))) throw new Error('Provider credentials require HTTPS or loopback.');
  const origin = configured.origin;
  const transport: typeof fetch = (input, init) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (target.origin !== origin) throw fail('Invalid provider request origin.', 503);
    const timeout = AbortSignal.timeout(10_000);
    return (options.fetch ?? fetch)(input, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  };
  const client = (token?: string) => createClient(options.url, options.anonKey, {
    global: { fetch: transport, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) },
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const normalize = (user: { id: string; identities?: Array<{ identity_id: string; provider: string; id: string; identity_data?: Record<string, unknown> }> }): GithubUnlinkUser => {
    if (!isValidUuid(user.id) || !Array.isArray(user.identities) || user.identities.length > 100) throw fail('Provider identities could not be verified.', 503);
    const seen = new Set<string>();
    return { userId: user.id, identities: user.identities.map(identity => {
      if (!isValidUuid(identity.identity_id) || seen.has(identity.identity_id) || !identity.provider) throw fail('Provider identities could not be verified.', 503);
      seen.add(identity.identity_id);
      const raw = identity.identity_data?.provider_id ?? identity.identity_data?.sub ?? identity.id;
      const subject = typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? String(raw)
        : typeof raw === 'string' && numeric.test(raw) ? raw : null;
      if (identity.provider === 'github' && !subject) throw fail('Provider GitHub identity could not be verified.', 503);
      return { identityId: identity.identity_id, provider: identity.provider, subject };
    }),
    };
  };
  const provider: GithubUnlinkProvider = {
    async user(token) { const { data, error } = await client(token).auth.getUser(token); if (error || !data.user) throw error ?? fail('Provider identity unavailable.', 503); return normalize(data.user); },
    async unlink(token, identityId) {
      const scoped = client(token); const { data, error } = await scoped.auth.getUser(token);
      if (error || !data.user) throw error ?? fail('Provider identity unavailable.', 503);
      const identity = data.user.identities?.find(value => value.identity_id === identityId);
      if (!identity) throw fail('The provider identity changed.');
      const outcome = await scoped.auth.unlinkIdentity(identity); if (outcome.error) throw outcome.error;
    },
    async inspect(userId) {
      const admin = createClient(options.url, options.serviceKey, { global: { fetch: transport }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      const { data, error } = await admin.auth.admin.getUserById(userId); if (error || !data.user) throw error ?? fail('Provider identity unavailable.', 503);
      return normalize(data.user);
    },
  };
  const clientFactory: OAuthSupabaseClientFactory = (storage: OAuthPkceStorageAdapter, storageKey: string) => createClient(options.url, options.anonKey, {
    global: { fetch: transport }, auth: { autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce', persistSession: true, skipAutoInitialize: true, storage, storageKey },
  });
  return { provider, clientFactory };
}
