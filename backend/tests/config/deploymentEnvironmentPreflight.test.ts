import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPrivateDeploymentHostname,
  validateDeploymentEnvironment,
} from '../../scripts/deployment-environment-preflight.js';

const productionEnvironment = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://backend:secret@database.example.com/postgres',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_KEY: 'publishable-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  JWT_SECRET: 'j'.repeat(64),
  CLIENT_URL: 'ghsocial://callback',
  BACKEND_URL: 'https://weave-backend.example.com',
  OAUTH_REDIRECT_ORIGINS: 'ghsocial://callback,https://weave.example.com',
  REDIS_URL: 'rediss://redis.example.com:6380',
  GITHUB_TOKEN: 'github-token',
  ML_SERVICE_URL: 'https://ml.example.com',
  INTERNAL_API_SECRET: 'internal-secret',
  DB_SCHEMA_V2_READS: 'true',
  DB_SCHEMA_V2_WRITES: 'true',
  FEED_V2: 'true',
  FEED_RESERVATIONS: 'true',
  FEED_V2_CANARY_PERCENT: '100',
  ML_V2_RECOMMENDATIONS: 'true',
  ML_FEEDBACK_OUTBOX: 'true',
  ML_QDRANT_ONLY: 'true',
  TRENDING_FALLBACK: 'false',
  WORKER_ROLE: '',
} as const;

test('deployment preflight accepts the exact mobile callback and public HTTPS targets', () => {
  assert.doesNotThrow(() => validateDeploymentEnvironment(productionEnvironment));
  assert.equal(isPrivateDeploymentHostname('2606:4700:4700::1111'), false);
});

test('deployment preflight rejects local and private backend callback origins', () => {
  for (const backendUrl of [
    'https://localhost',
    'https://api.localhost',
    'https://127.0.0.1',
    'https://10.0.0.5',
    'https://172.16.0.5',
    'https://192.168.1.5',
    'https://[::1]',
    'https://[fd00::1]',
  ]) {
    assert.throws(
      () => validateDeploymentEnvironment({ ...productionEnvironment, BACKEND_URL: backendUrl }),
      /public hostname/i,
    );
  }
});

test('deployment preflight rejects unsafe OAuth redirect allowlist entries', () => {
  for (const redirect of [
    'http://weave.example.com',
    'https://localhost:3000',
    'https://10.0.0.5/callback',
    'ghsocial://callback/extra',
    'another-app://callback',
  ]) {
    assert.throws(
      () => validateDeploymentEnvironment({
        ...productionEnvironment,
        OAUTH_REDIRECT_ORIGINS: `ghsocial://callback,${redirect}`,
      }),
      /OAUTH_REDIRECT_ORIGINS/i,
    );
  }
});

test('deployment preflight continues to reject unsafe one-time migration flags', () => {
  assert.throws(
    () => validateDeploymentEnvironment({ ...productionEnvironment, ADOPT_LEGACY_SCHEMA: '1' }),
    /forbidden/i,
  );
});

test('deployment preflight requires the complete V2 path and disables non-ML fallback', () => {
  assert.throws(
    () => validateDeploymentEnvironment({
      ...productionEnvironment,
      ML_V2_RECOMMENDATIONS: 'false',
    }),
    /Strict V2 deployment/i,
  );
  assert.throws(
    () => validateDeploymentEnvironment({
      ...productionEnvironment,
      FEED_V2_CANARY_PERCENT: '99',
    }),
    /FEED_V2_CANARY_PERCENT=100/i,
  );
  assert.throws(
    () => validateDeploymentEnvironment({
      ...productionEnvironment,
      TRENDING_FALLBACK: 'true',
    }),
    /TRENDING_FALLBACK=false/i,
  );
});
