import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveRedisUrl,
  validateProductionIntegrations,
} from '../../config/runtimeConfig.js';

test('Redis uses localhost only outside production', () => {
  assert.equal(resolveRedisUrl(undefined, 'test'), 'redis://127.0.0.1:6379');
  assert.equal(
    resolveRedisUrl(
      ' redis://backend-runtime:strong-test-password@redis.internal:6379/0 ',
      'production',
    ),
    'redis://backend-runtime:strong-test-password@redis.internal:6379/0',
  );
  assert.equal(
    resolveRedisUrl(
      ' rediss://backend-runtime:strong-test-password@redis.example:6380/0 ',
      'production',
    ),
    'rediss://backend-runtime:strong-test-password@redis.example:6380/0',
  );
  assert.throws(
    () => resolveRedisUrl(undefined, 'production'),
    /REDIS_URL/,
  );
  assert.throws(
    () => resolveRedisUrl('redis://redis.internal:6379/0', 'production'),
    /ACL username and password/,
  );
  assert.throws(
    () => resolveRedisUrl(
      'http://backend-runtime:strong-test-password@redis.internal:6379/0',
      'production',
    ),
    /redis:\/\/ or rediss:\/\//,
  );
});

test('production refuses to start without the GitHub persona credential', () => {
  assert.doesNotThrow(() => validateProductionIntegrations({ NODE_ENV: 'test' }));
  assert.throws(
    () => validateProductionIntegrations({ NODE_ENV: 'production' }),
    /GITHUB_TOKEN/,
  );
  assert.doesNotThrow(() => validateProductionIntegrations({
    NODE_ENV: 'production',
    GITHUB_TOKEN: 'github_pat_configured',
  }));
});
