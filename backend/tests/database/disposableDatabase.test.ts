import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('activity fixtures allow only plain disposable destinations before selecting or connecting any test', () => {
  for (const [databaseUrl, nodeEnv, allowed] of [
    ['postgres://fixture@db.invalid/weave_scroll', 'test', false],
    ['postgres://fixture@127.0.0.1/product', 'test', false],
    ['postgres://fixture@127.0.0.1/weave_scroll', 'production', false],
    ['postgres://fixture@127.0.0.1/weave_scroll?host=db.invalid', 'test', false],
    ['postgres://fixture@127.0.0.1/weave_scroll', 'test', true],
  ] as const) {
    const env: NodeJS.ProcessEnv = { ...process.env, RUN_DATABASE_INTEGRATION: '1', DATABASE_URL: databaseUrl, NODE_ENV: nodeEnv };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-name-pattern=guard-only',
      fileURLToPath(new URL('./activityBatch.integration.test.ts', import.meta.url))], {
      env,
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, allowed ? 0 : 1, `${databaseUrl} / ${nodeEnv}: allowed=${allowed}`);
    if (!allowed) assert.match(result.stdout + result.stderr, /disposable.*weave_scroll/i);
  }
});
