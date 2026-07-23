import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';

Object.assign(process.env, {
  CLIENT_URL: 'ghsocial://callback',
  BACKEND_URL: 'http://127.0.0.1:5000',
  JWT_SECRET: 'signup-username-unit-test-secret',
  SUPABASE_URL: 'https://signup-username-test.supabase.co',
  SUPABASE_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
  REDIS_URL: 'redis://127.0.0.1:1/15',
});

const [{ signUp }, { default: redisClient }, { sqlClient }] = await Promise.all([
  import('../../controllers/authController.js'),
  import('../../config/redis.js'),
  import('../../db/index.js'),
]);

test.after(async () => {
  redisClient.disconnect(false);
  await sqlClient.end({ timeout: 0 });
});

test('email signup rejects username characters outside the shared profile rule', async () => {
  let statusCode = 0;
  let responseBody: unknown;
  const response = {
    status(code: number) { statusCode = code; return this; },
    json(body: unknown) { responseBody = body; return this; },
  } as unknown as Response;

  await signUp({
    body: {
      email: 'user@example.com',
      password: 'valid-test-password',
      full_name: 'Test User',
      username: 'invalid username!',
    },
  } as Request, response);

  assert.equal(statusCode, 400);
  assert.deepEqual(responseBody, {
    success: false,
    error: 'Username must be 1-50 characters using only letters, numbers, underscores, or hyphens',
  });
});
