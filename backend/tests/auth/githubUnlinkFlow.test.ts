import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { GithubUnlinkFlow, createGithubUnlinkClients, type GithubUnlinkPersistence, type GithubUnlinkOwner, type GithubUnlinkRedis } from '../../services/githubUnlinkFlow.js';

const userId = crypto.randomUUID(), peerId = crypto.randomUUID();
const ownerGithubId = String(crypto.randomInt(1_000_000_000, 2_000_000_000));
const githubIdentity = '10000000-0000-4000-8000-000000000001', emailIdentity = '10000000-0000-4000-8000-000000000002';
const verifier = 'v'.repeat(64), challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');

class MemoryRedis implements GithubUnlinkRedis {
  readonly values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string) { if (this.values.has(key)) return null; this.values.set(key, value); return 'OK'; }
  async eval(script: string, _count: number, key: string, ...args: string[]) {
    const raw = this.values.get(key); if (!raw) return null;
    if (script.includes('value.ownerUserId')) {
      const value = JSON.parse(raw);
      if (value.purpose !== args[0] || value.ownerUserId !== args[1] || value.challenge !== args[2]) return null;
    }
    this.values.delete(key); return raw;
  }
}
class MemoryPersistence implements GithubUnlinkPersistence {
  githubId: string | null = ownerGithubId; failCompletion = false;
  current: (GithubUnlinkOwner & { operationId: string; status: string }) | null = null;
  async owner(id: string) { if (id !== userId || !this.githubId) throw Object.assign(new Error('No verified GitHub identity.'), { statusCode: 409 }); return { userId: id, githubId: this.githubId }; }
  async prepare(owner: GithubUnlinkOwner, operationId: string) { this.current = { ...owner, operationId, status: 'prepared' }; }
  async complete(owner: GithubUnlinkOwner, operationId: string): Promise<'done'> {
    if (this.failCompletion) throw new Error('Explicit persistence boundary failure.');
    assert.equal(owner.userId, userId); assert.equal(this.current?.operationId, operationId);
    this.githubId = null; this.current!.status = 'done'; return 'done';
  }
  async refused(_owner: GithubUnlinkOwner, operationId: string) { assert.equal(this.current?.operationId, operationId); this.current!.status = 'refused'; }
  async operation(id: string) { return id === userId ? this.current : null; }
}

test('registered unlink routes use actual scoped Supabase OAuth/session HTTP without exposing provider credentials', async t => {
  process.env.JWT_SECRET = 'backend-unlink-fixture-authentication-secret';
  const [{ default: express }, { default: cookieParser }, { default: jwt }, { createGithubUnlinkRoutes }] = await Promise.all([
    import('express'), import('cookie-parser'), import('jsonwebtoken'), import('../../routes/githubUnlinkRoutes.js'),
  ]);
  const tokens = new Map<string, string>();
  const codes = new Map<string, { user: string; challenge: string }>();
  let linked = true, alternatives = 1, deleteMode = 'success', deletes = 0, adminReads = 0, malformedAdmin = false;
  let now = Date.now();
  const providerUser = (id: string) => ({ id, aud: 'authenticated', email: 'fixture@invalid.test', created_at: new Date().toISOString(),
    app_metadata: { provider: 'github', providers: ['github', 'email'] }, user_metadata: { provider_id: ownerGithubId, user_name: 'fixture' },
    identities: [ ...(linked ? [{ id: ownerGithubId, identity_id: githubIdentity, provider: 'github', user_id: id, identity_data: { sub: ownerGithubId, provider_id: ownerGithubId } }] : []),
      ...(alternatives ? [{ id: 'fixture@invalid.test', identity_id: emailIdentity, provider: 'email', user_id: id, identity_data: { email: 'fixture@invalid.test' } }] : []) ] });
  const provider = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/auth/v1/token') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); const proof = codes.get(body.auth_code); assert.ok(proof);
      assert.equal(crypto.createHash('sha256').update(body.code_verifier, 'ascii').digest('base64url'), proof.challenge);
      const access = jwt.sign({ sub: proof.user, aud: 'authenticated', jti: crypto.randomUUID() }, 'provider-session-secret', { expiresIn: '1h' });
      tokens.set(access, proof.user);
      res.end(JSON.stringify({ access_token: access, refresh_token: 'never-persist-this-provider-refresh', token_type: 'bearer', expires_in: 3_600, user: providerUser(proof.user) })); return;
    }
    if (url.pathname.startsWith('/auth/v1/admin/users/')) {
      assert.equal(req.headers.authorization, 'Bearer fixture-service-key'); adminReads++;
      res.end(JSON.stringify({ user: { ...providerUser(url.pathname.split('/').pop()!), ...(malformedAdmin ? { identities: undefined } : {}) } })); return;
    }
    const access = req.headers.authorization?.replace(/^Bearer /, '')!;
    const id = tokens.get(access); assert.ok(id, 'every identity action must use the fresh Supabase user session');
    jwt.verify(access, 'provider-session-secret');
    assert.equal(req.headers.apikey, 'fixture-anon-key');
    if (req.method === 'DELETE') {
      assert.equal(url.pathname, `/auth/v1/user/identities/${githubIdentity}`); deletes++;
      if (!alternatives || deleteMode === 'refuse') { res.statusCode = 400; res.end(JSON.stringify({ code: 'single_identity_not_deletable', msg: 'Provider refused the unlink.' })); return; }
      linked = false;
      if (deleteMode === 'lost-response') { res.destroy(); return; }
      res.end('{}'); return;
    }
    assert.equal(url.pathname, '/auth/v1/user'); res.end(JSON.stringify(providerUser(id)));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerAddress = provider.address(); assert.ok(providerAddress && typeof providerAddress === 'object');
  const persistence = new MemoryPersistence(), redis = new MemoryRedis(); const revoked: string[] = [];
  const clients = createGithubUnlinkClients({ url: `http://127.0.0.1:${providerAddress.port}`, anonKey: 'fixture-anon-key', serviceKey: 'fixture-service-key' });
  const flow = new GithubUnlinkFlow({ redis, persistence, ...clients, secret: process.env.JWT_SECRET!, now: () => now,
    revokeImport: async owner => { revoked.push(owner); } });
  const app = express(); app.use(express.json()); app.use(cookieParser());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.listening ? resolve() : server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  let origin = `http://127.0.0.1:${address.port}`;
  let activeFlow = flow;
  const dynamicFlow = new Proxy(flow, { get(_target, property) { const value = Reflect.get(activeFlow, property); return typeof value === 'function' ? value.bind(activeFlow) : value; } });
  const routes = createGithubUnlinkRoutes({ flow: dynamicFlow, backendUrl: origin, clientUrl: `${origin}/callback`, nodeEnv: 'test' });
  app.use('/api/v2/onboarding/github-unlink', routes.authenticated);
  app.use('/api/auth/github-unlink', routes.publicRoutes);
  app.get('/api/auth/callback', routes.callback);
  const backendTokens = new Map([userId, peerId].map(id => [id, jwt.sign({ userId: id, email: 'fixture@invalid.test' }, process.env.JWT_SECRET!, { expiresIn: '1m' })]));
  const send = (action: string, body: unknown = {}, owner = userId) => fetch(`${origin}/api/v2/onboarding/github-unlink/${action}`, {
    method: 'POST', headers: { Authorization: `Bearer ${backendTokens.get(owner)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const authorize = async (providerOwner = userId) => {
    const response = await send('start', { confirmation: 'disconnect-github', code_challenge: challenge, redirect_uri: `${origin}/callback` });
    assert.equal(response.status, 200, await response.clone().text());
    const initial = await response.json() as { data: { url: string } };
    const continuation = await fetch(initial.data.url, { redirect: 'manual' }); assert.equal(continuation.status, 302);
    const authorization = new URL(continuation.headers.get('location')!);
    assert.equal(authorization.searchParams.get('redirect_to'), `${origin}/api/auth/callback`, 'reuse the existing provider allowlisted callback');
    const code = crypto.randomUUID(); codes.set(code, { user: providerOwner, challenge: authorization.searchParams.get('code_challenge')! });
    const cookies = continuation.headers.getSetCookie().find(value => value.startsWith('github_unlink_attempt='))!.split(';')[0];
    const callback = await fetch(`${origin}/api/auth/callback?code=${code}`, { headers: { Cookie: cookies }, redirect: 'manual' });
    assert.equal(callback.status, 302);
    return new URL(callback.headers.get('location')!);
  };
  const finish = (code: string, proof = verifier, owner = userId) => send('finish', { unlink_code: code, code_verifier: proof, confirmation: 'disconnect-github' }, owner);
  const reset = () => { linked = true; alternatives = 1; deleteMode = 'success'; persistence.githubId = ownerGithubId; persistence.current = null; persistence.failCompletion = false; redis.values.clear(); now = Date.now(); };
  t.after(async () => {
    server.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => provider.close(() => resolve()))]);
  });
  await t.test('callback only stages a sealed proof; wrong owner/PKCE cannot consume it; finish and replay are fenced', async () => {
    reset(); const before = deletes; const target = await authorize(); const code = target.searchParams.get('unlink_code')!; assert.ok(code);
    assert.equal(deletes, before); assert.deepEqual(revoked, []);
    const serialized = [...redis.values.values()].join('\n');
    for (const token of tokens.keys()) assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes('never-persist-this-provider-refresh'), false);
    assert.equal((await finish(code, verifier, peerId)).status, 400);
    assert.equal((await finish(code, 'w'.repeat(64))).status, 400);
    const response = await finish(code); assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json() as { data: { status: string } }).data.status, 'done');
    assert.equal(deletes, before + 1); assert.equal(persistence.githubId, null); assert.deepEqual(revoked, [userId]);
    assert.equal((await finish(code)).status, 400); assert.equal(deletes, before + 1);
  });
  await t.test('single identity refusal and account swaps never reach a provider mutation', async () => {
    reset(); const before = deletes; alternatives = 0;
    assert.equal((await authorize()).searchParams.get('unlink_error'), 'last_identity');
    assert.equal(deletes, before);
    alternatives = 1;
    assert.equal((await authorize(peerId)).searchParams.get('unlink_code'), null);
    assert.equal(deletes, before);
    const target = await authorize(); persistence.githubId = '8';
    assert.equal((await finish(target.searchParams.get('unlink_code')!)).status, 409);
    assert.equal(deletes, before);
  });
  await t.test('a fresh proof rechecks alternative identities and expiry before revocation', async () => {
    reset(); const before = deletes, revocations = revoked.length;
    let target = await authorize(); alternatives = 0;
    assert.equal((await finish(target.searchParams.get('unlink_code')!)).status, 409);
    assert.equal(revoked.length, revocations); assert.equal(deletes, before);
    alternatives = 1; target = await authorize(); now += 300_001;
    assert.equal((await finish(target.searchParams.get('unlink_code')!)).status, 400);
    assert.equal(deletes, before);
  });
  await t.test('lost provider response and post-unlink persistence failure remain owner-reconcilable', async () => {
    for (const failure of ['lost-response', 'persistence']) {
      reset(); const target = await authorize();
      deleteMode = failure === 'lost-response' ? failure : 'success'; persistence.failCompletion = failure === 'persistence';
      const response = await finish(target.searchParams.get('unlink_code')!); assert.equal(response.status, 202);
      assert.equal(linked, false); assert.equal(persistence.githubId, ownerGithubId);
      assert.equal((await send('status', {}, peerId)).status, 200);
      persistence.failCompletion = false;
      malformedAdmin = true;
      assert.equal((await send('status')).status, 503, 'missing provider identities never proves a successful unlink');
      assert.equal(persistence.githubId, ownerGithubId);
      malformedAdmin = false;
      const status = await send('status'); assert.equal((await status.json() as { data: { status: string } }).data.status, 'done');
      assert.equal(persistence.githubId, null);
    }
    assert.ok(adminReads >= 2);
  });
  await t.test('provider refusal keeps login linked and normal OAuth state cannot cross purposes', async () => {
    reset(); deleteMode = 'refuse'; const target = await authorize();
    const response = await finish(target.searchParams.get('unlink_code')!);
    assert.equal((await response.json() as { data: { status: string } }).data.status, 'refused');
    assert.equal(linked, true); assert.equal(persistence.githubId, ownerGithubId);
    const state = 'a'.repeat(43); redis.values.set(`oauth:pkce:attempt:${state}`, '{}');
    assert.equal((await fetch(`${origin}/api/auth/github-unlink/continue?unlink_attempt=${state}`, { redirect: 'manual' })).status, 400);
    assert.ok(redis.values.has(`oauth:pkce:attempt:${state}`));
    assert.equal((await fetch(`${origin}/api/v2/onboarding/github-unlink/start`, { method: 'POST' })).status, 401);
  });
  await t.test('actual Redis/SQL intent recovers provider success followed by a real transaction failure', {
    skip: process.env.RUN_DATABASE_INTEGRATION !== '1',
  }, async () => {
    const { assertDisposableDatabase } = await import('../database/disposableDatabase.js'); assertDisposableDatabase();
    const redisUrl = new URL(process.env.REDIS_DATABASE_TEST_URL ?? 'redis://127.0.0.1:56388/15');
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(redisUrl.hostname) && redisUrl.pathname === '/15');
    const [{ sqlClient }, { PostgresGithubUnlink }, { Redis }] = await Promise.all([
      import('../../db/index.js'), import('../../adapters/postgresGithubUnlink.js'), import('ioredis'),
    ]);
    const realRedis = new Redis(redisUrl.toString(), { maxRetriesPerRequest: 1, commandTimeout: 1_000 });
    const written = new Set<string>();
    const actualRedis: GithubUnlinkRedis = { get: key => realRedis.get(key),
      set: (key, value, mode, seconds, condition) => { written.add(key); return realRedis.set(key, value, mode, seconds, condition); },
      eval: (script, count, ...args) => realRedis.eval(script, count, ...args) };
    const actual = new PostgresGithubUnlink();
    const { GitHubImportConsentService } = await import('../../services/githubImportConsentService.js');
    const imports = new GitHubImportConsentService({ collect: async () => { throw new Error('No activity collection during unlink.'); } }, realRedis);
    const revocations: string[] = [];
    const functionName = `unlink_failure_${userId.replaceAll('-', '')}`;
    let triggered = false;
    let wiredServer: ReturnType<typeof app.listen> | undefined;
    let runtimeRedis: { disconnect(): void } | undefined;
    const fixtureOrigin = origin;
    try {
      reset();
      await sqlClient`INSERT INTO auth.users(id) VALUES(${userId}::uuid)`;
      await sqlClient`INSERT INTO app.users(user_id,username,full_name,status,github_id,github_handle,github_identity_verified_at,interests,onboarding_completed)
        VALUES(${userId}::uuid,${'unlink_'+userId.replaceAll('-', '')},'Tarun','active',${ownerGithubId},'fixture',now(),'["databases"]'::jsonb,true)`;
      await sqlClient`INSERT INTO app.user_feed_state(user_id) VALUES(${userId}::uuid)`;
      await sqlClient`INSERT INTO app.social_profiles(provider,provider_subject,handle,profile_kind,claimed_by_user_id)
        VALUES('github',${ownerGithubId},${'unlink-'+ownerGithubId},'user',${userId}::uuid)`;
      await sqlClient`INSERT INTO app.user_github_imports(user_id,github_id,consented_at,accepted_at,baseline,applied) VALUES(${userId}::uuid,${ownerGithubId},now(),now(),'{"interests":["databases"],"skills":[],"tech_stack":[]}'::jsonb,'{"interests":["databases"],"skills":[],"tech_stack":[]}'::jsonb)`;
      activeFlow = new GithubUnlinkFlow({ ...clients, redis: actualRedis, persistence: actual, secret: process.env.JWT_SECRET!, now: () => now,
        revokeImport: async id => { revocations.push(id); await imports.revoke(id); } });
      // Hold the owner lock while a concurrent preview takes its statement
      // snapshot, then commit an intent. Its post-lock read must see the fence.
      let racedPreview: Promise<unknown> | undefined;
      await sqlClient.begin(async tx => {
        await tx`SELECT user_id FROM app.users WHERE user_id=${userId}::uuid FOR UPDATE`;
        racedPreview = imports.preview(userId, true).then(() => new Error('Unexpected preview success'), error => error);
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          await tx`SELECT pg_stat_clear_snapshot()`;
          const [blocked] = await tx`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
            AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%FROM app.users%FOR UPDATE%'`;
          if (Number(blocked.count) > 0) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(waiting, 'observe the concurrent preview actually waiting on the owner lock');
        await tx`INSERT INTO app.user_github_unlinks(user_id,operation_id,github_id,status)
          VALUES(${userId}::uuid,${crypto.randomUUID()}::uuid,${ownerGithubId},'prepared')`;
      });
      assert.match(String(await racedPreview), /disconnect needs verification/);
      await sqlClient`DELETE FROM app.user_github_unlinks WHERE user_id=${userId}::uuid`;
      const target = await authorize();
      const proofKey = [...written].find(value => value.startsWith('oauth:github-unlink:proof:'))!;
      assert.ok((await realRedis.ttl(proofKey)) > 0);
      // A wrong owner/proof must not consume the actual atomic Redis record.
      assert.equal((await finish(target.searchParams.get('unlink_code')!, verifier, peerId)).status, 400);
      assert.ok(await realRedis.get(proofKey));
      await sqlClient.unsafe(`CREATE FUNCTION app.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'disposable unlink commit failure'; END $$`);
      await sqlClient.unsafe(`CREATE TRIGGER ${functionName} BEFORE UPDATE OF status ON app.user_github_unlinks FOR EACH ROW WHEN (NEW.user_id='${userId}'::uuid AND NEW.status='done') EXECUTE FUNCTION app.${functionName}()`);
      triggered = true;
      const response = await finish(target.searchParams.get('unlink_code')!); assert.equal(response.status, 202);
      assert.equal(linked, false); assert.deepEqual(revocations, [userId]);
      assert.equal((await sqlClient`SELECT github_id FROM app.users WHERE user_id=${userId}::uuid`)[0].github_id, ownerGithubId);
      assert.equal((await actual.operation(userId))?.status, 'prepared');
      assert.equal((await imports.status(userId)).active, false);
      assert.equal((await imports.status(userId)).unlink_pending, true);
      await assert.rejects(imports.preview(userId, true), /disconnect needs verification/);
      assert.equal(Number((await sqlClient`SELECT count(*) FROM telemetry.ml_outbox WHERE aggregate_id=${userId}::uuid`)[0].count), 1);
      await sqlClient.unsafe(`DROP TRIGGER ${functionName} ON app.user_github_unlinks; DROP FUNCTION app.${functionName}()`); triggered = false;
      const status = await send('status'); assert.equal((await status.json() as { data: { status: string } }).data.status, 'done');
      const [profile] = await sqlClient`SELECT github_id,github_handle,github_identity_verified_at,profile_version FROM app.users WHERE user_id=${userId}::uuid`;
      assert.deepEqual([profile.github_id, profile.github_handle, profile.github_identity_verified_at], [null, null, null]);
      assert.equal(Number(profile.profile_version), 3);
      const [job] = await sqlClient`SELECT payload,status FROM telemetry.ml_outbox WHERE aggregate_id=${userId}::uuid AND job_type='onboard' ORDER BY created_at DESC`;
      assert.equal(job.status, 'pending'); assert.equal(job.payload.profile.github_username, null);
      assert.equal((await sqlClient`SELECT claimed_by_user_id FROM app.social_profiles WHERE provider='github' AND provider_subject=${ownerGithubId}`)[0].claimed_by_user_id, null);
      assert.equal((await sqlClient`SELECT profile_kind FROM app.social_profiles WHERE provider='github' AND provider_subject=${ownerGithubId}`)[0].profile_kind, 'user');
      await send('status');
      assert.equal(Number((await sqlClient`SELECT profile_version FROM app.users WHERE user_id=${userId}::uuid`)[0].profile_version), 3);
      await sqlClient`UPDATE app.users SET github_id=${ownerGithubId},github_identity_verified_at=now() WHERE user_id=${userId}::uuid`;
      const operationId = crypto.randomUUID(); await actual.prepare({ userId, githubId: ownerGithubId }, operationId);
      await sqlClient`UPDATE app.users SET github_id='9' WHERE user_id=${userId}::uuid`;
      assert.equal(await actual.complete({ userId, githubId: ownerGithubId }, operationId), 'superseded');
      assert.equal((await sqlClient`SELECT github_id FROM app.users WHERE user_id=${userId}::uuid`)[0].github_id, '9');
      // Now traverse the actual production registration and lazy runtime wiring,
      // including the shared callback dispatch and real import revocation.
      linked = true;
      await sqlClient`UPDATE app.users SET github_id=${ownerGithubId},github_handle='fixture',github_identity_verified_at=now() WHERE user_id=${userId}::uuid`;
      const wired = express(); wired.use(express.json()); wired.use(cookieParser());
      wiredServer = wired.listen(0, '127.0.0.1');
      await new Promise<void>(resolve => wiredServer!.listening ? resolve() : wiredServer!.once('listening', resolve));
      const wiredAddress = wiredServer.address(); assert.ok(wiredAddress && typeof wiredAddress === 'object');
      origin = `http://127.0.0.1:${wiredAddress.port}`;
      Object.assign(process.env, { NODE_ENV: 'test', SUPABASE_URL: `http://127.0.0.1:${providerAddress.port}`,
        SUPABASE_KEY: 'fixture-anon-key', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-key',
        CLIENT_URL: `${origin}/callback`, BACKEND_URL: origin, REDIS_URL: redisUrl.toString() });
      const [{ default: authRoutes }, { default: productRoutes }, { default: configuredRedis }] = await Promise.all([
        import('../../routes/authRoutes.js'), import('../../routes/productV2Routes.js'), import('../../config/redis.js'),
      ]);
      runtimeRedis = configuredRedis;
      wired.use('/api/auth', authRoutes); wired.use('/api/v2', productRoutes);
      const wiredProof = await authorize();
      assert.ok(wiredProof.searchParams.get('unlink_code'));
      const wiredFinish = await finish(wiredProof.searchParams.get('unlink_code')!);
      assert.equal(wiredFinish.status, 200, await wiredFinish.clone().text());
      assert.equal((await wiredFinish.json() as { data: { status: string } }).data.status, 'done');
      assert.equal((await imports.status(userId)).linked, false);

    } finally {
      origin = fixtureOrigin;
      if (wiredServer) { wiredServer.closeAllConnections(); await new Promise<void>(resolve => wiredServer!.close(() => resolve())); }
      runtimeRedis?.disconnect();
      activeFlow = flow;
      if (triggered) await sqlClient.unsafe(`DROP TRIGGER IF EXISTS ${functionName} ON app.user_github_unlinks; DROP FUNCTION IF EXISTS app.${functionName}()`);
      if (written.size) await realRedis.del(...written);
      realRedis.disconnect();
      await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${userId}::uuid`;
      await sqlClient`DELETE FROM app.social_profiles WHERE provider='github' AND provider_subject=${ownerGithubId}`;
      await sqlClient`DELETE FROM app.users WHERE user_id=${userId}::uuid`;
      await sqlClient`DELETE FROM auth.users WHERE id=${userId}::uuid`;
      await sqlClient.end({ timeout: 1 });
    }
  });
});
