import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { assertDisposableDatabase } from './disposableDatabase.js';

const enabled = process.env.RUN_DATABASE_INTEGRATION === '1';
if (enabled) assertDisposableDatabase();
const integration = enabled ? test : test.skip;

integration('registered GitHub OAuth callback verifies identity without collecting or applying activity', async () => {
  const redisUrl = new URL(process.env.REDIS_DATABASE_TEST_URL ?? 'redis://127.0.0.1:56388/15');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(redisUrl.hostname) && redisUrl.pathname === '/15');
  const [{ default: express }, { default: cookieParser }, { default: jwt }] = await Promise.all([import('express'), import('cookie-parser'), import('jsonwebtoken')]);
  const userId = crypto.randomUUID(), githubId = String(crypto.randomInt(1_000_000_000, 2_000_000_000));
  const handle = `consent-${githubId}`;
  let tokenRequests = 0;
  const supabase = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(new URL(req.url!, 'http://localhost').pathname, '/auth/v1/token');
    assert.equal(body.auth_code, 'fixture-provider-code');
    assert.ok(body.code_verifier.length >= 43);
    tokenRequests++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ access_token: jwt.sign({ sub: userId, exp: Math.floor(Date.now() / 1_000) + 3_600, aud: 'authenticated' }, 'disposable-provider-secret'),
      refresh_token: crypto.randomUUID(), token_type: 'bearer', expires_in: 3_600,
      user: { id: userId, aud: 'authenticated', role: 'authenticated', email: 'fixture@invalid.test', created_at: new Date().toISOString(),
        app_metadata: { provider: 'github', providers: ['github'] },
        user_metadata: { provider_id: githubId, user_name: handle, full_name: 'Tarun' },
        identities: [{ id: githubId, identity_id: crypto.randomUUID(), provider: 'github', user_id: userId,
          identity_data: { sub: githubId, provider_id: githubId, user_name: handle } }] } }));
  });
  await new Promise<void>(resolve => supabase.listen(0, '127.0.0.1', resolve));
  const providerAddress = supabase.address(); assert.ok(providerAddress && typeof providerAddress === 'object');
  const app = express(); app.use(express.json()); app.use(cookieParser());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.listening ? resolve() : server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'consent-callback-fixture-secret', REDIS_URL: redisUrl.toString(),
    SUPABASE_URL: `http://127.0.0.1:${providerAddress.port}`, SUPABASE_KEY: 'fixture', SUPABASE_SERVICE_ROLE_KEY: 'fixture',
    CLIENT_URL: 'http://127.0.0.1:8081', BACKEND_URL: origin, GITHUB_TOKEN: 'fixture-not-real' });
  const [{ default: routes }, { sqlClient }, { default: redis }] = await Promise.all([
    import('../../routes/authRoutes.js'), import('../../db/index.js'), import('../../config/redis.js'),
  ]);
  app.use('/api/auth', routes);
  const originalFetch = globalThis.fetch;
  let forbiddenRequests = 0;
  globalThis.fetch = (input, init) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (target.hostname !== '127.0.0.1') { forbiddenRequests++; throw new Error('This fixture forbids external/provider activity calls.'); }
    return originalFetch(input, init);
  };
  let state: string | null = null;
  try {
    await sqlClient`INSERT INTO auth.users(id) VALUES(${userId}::uuid)`;
    const challenge = crypto.createHash('sha256').update('v'.repeat(64), 'ascii').digest('base64url');
    const initiation = await fetch(`${origin}/api/auth/oauth/github?${new URLSearchParams({
      auth_intent: 'signup', date_of_birth: '2005-01-01', redirect_uri: 'http://127.0.0.1:8081', code_challenge: challenge,
    })}`);
    assert.equal(initiation.status, 200, await initiation.clone().text());
    const result = await initiation.json() as { data: { url: string } };
    state = new URL(result.data.url).searchParams.get('oauth_attempt'); assert.ok(state);
    const continuation = await fetch(result.data.url, { redirect: 'manual' });
    assert.equal(continuation.status, 302);
    const cookie = continuation.headers.getSetCookie().find(value => value.startsWith('oauth_attempt='))?.split(';')[0]; assert.ok(cookie);
    assert.ok(continuation.headers.getSetCookie().some(value => value.startsWith('github_unlink_attempt=;')),
      'ordinary sign-in retires the separate unlink-purpose cookie');
    const callback = await fetch(`${origin}/api/auth/callback?code=fixture-provider-code`, { redirect: 'manual', headers: { Cookie: cookie } });
    assert.equal(callback.status, 302);
    assert.ok(new URL(callback.headers.get('location')!).searchParams.get('code'), callback.headers.get('location')!);
    assert.equal(tokenRequests, 1);
    assert.equal(forbiddenRequests, 0, 'authentication must not infer consent to fetch GitHub activity');
    const [profile] = await sqlClient`SELECT github_id,github_identity_verified_at,onboarding_completed,interests,skills,tech_stack FROM app.users WHERE user_id=${userId}::uuid`;
    assert.equal(profile.github_id, githubId);
    assert.ok(profile.github_identity_verified_at);
    assert.equal(profile.onboarding_completed, false);
    assert.deepEqual([profile.interests, profile.skills, profile.tech_stack], [[], [], []]);
    assert.equal(Number((await sqlClient`SELECT count(*) FROM telemetry.ml_outbox WHERE aggregate_id=${userId}::uuid`)[0].count), 0);
  } finally {
    globalThis.fetch = originalFetch;
    server.closeAllConnections(); supabase.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => supabase.close(() => resolve()))]);
    if (state) await redis.del(`oauth:pkce:attempt:${state}`);
    await sqlClient`DELETE FROM telemetry.ml_outbox WHERE aggregate_id=${userId}::uuid`;
    await sqlClient`DELETE FROM app.social_profiles WHERE provider='github' AND provider_subject=${githubId}`;
    await sqlClient`DELETE FROM app.users WHERE user_id=${userId}::uuid`;
    await sqlClient`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    redis.disconnect(); await sqlClient.end({ timeout: 1 });
  }
});
