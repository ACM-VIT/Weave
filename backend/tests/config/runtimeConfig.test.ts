import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveRedisUrl,
  validateProductionIntegrations,
} from '../../config/runtimeConfig.js';

test('Redis uses localhost only outside production', () => {
  assert.equal(resolveRedisUrl(undefined, 'test'), 'redis://127.0.0.1:6379');
  assert.equal(resolveRedisUrl(' rediss://redis.example:6380 ', 'production'), 'rediss://redis.example:6380');
  assert.throws(
    () => resolveRedisUrl(undefined, 'production'),
    /REDIS_URL/,
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
