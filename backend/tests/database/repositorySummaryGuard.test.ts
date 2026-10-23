import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('summary fixture validates disposable target even when all test names are filtered', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test',
    RUN_DATABASE_INTEGRATION: '1', DATABASE_URL: 'postgresql://fixture@127.0.0.1:9/not_disposable' };
  delete env.NODE_TEST_CONTEXT;
  assert.throws(() => execFileSync(process.execPath, ['--import', 'tsx', '--test',
    '--test-name-pattern=__no_summary_fixture_test_matches__',
    fileURLToPath(new URL('./repositorySummary.integration.test.ts', import.meta.url)),
  ], { timeout: 10_000, stdio: 'pipe', env }),
  (error: unknown) => {
    const failure = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
    assert.equal(failure.status, 1);
    assert.match(String(failure.stdout) + String(failure.stderr), /Use the disposable loopback weave_scroll database outside production/);
    return true;
  });
});
