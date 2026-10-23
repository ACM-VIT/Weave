import assert from 'node:assert/strict';
import test from 'node:test';

// Exercise the real runtime constructor with no external dependency work.
// Each test file runs in its own process; do not inherit deployment knobs.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ML_') || key.startsWith('OUTBOX_') || key.startsWith('FEED_')) delete process.env[key];
}
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/runtime_test',
  REDIS_URL: 'redis://127.0.0.1:1/0',
  JWT_SECRET: 'runtime-configuration-test-only',
  ML_SERVICE_URL: 'http://127.0.0.1:1',
  INTERNAL_API_SECRET: 'runtime-configuration-test-only',
  ML_DELIVERY_TIMEOUT_MS: '60000',
});

const [{ ApplicationRuntime }, { default: redis }, { sqlClient }] = await Promise.all([
  import('../../runtime/applicationRuntime.js'),
  import('../../config/redis.js'),
  import('../../db/index.js'),
]);
redis.disconnect();
test.after(async () => { await sqlClient.end({ timeout: 1 }); });

function configure(recommendations: boolean, feedback: boolean, generation = '60000', foreground = '5000') {
  Object.assign(process.env, {
    ML_V2_RECOMMENDATIONS: String(recommendations),
    ML_FEEDBACK_OUTBOX: String(feedback),
    FEED_GENERATION_TIMEOUT_MS: generation,
    FEED_FOREGROUND_WAIT_MS: foreground,
  });
}

for (const feedback of [false, true]) {
  for (const role of ['api', 'outbox'] as const) {
    test(`disabled generation ignores unused budgets (${role}, feedback=${feedback})`, async () => {
      for (const generation of ['60000', 'not-a-duration']) {
        configure(false, feedback, generation, 'not-a-duration');
        const runtime = new ApplicationRuntime(role);
        try {
          assert.equal(runtime.generation, null);
          assert.equal(runtime.ml !== null, feedback);
          assert.equal('feed-prewarm' in runtime.supervisor.snapshot(), false);
          if (role === 'api') runtime.start();
        } finally { await runtime.supervisor.stop(); }
      }
    });
  }
}

test('enabled generation still rejects an impossible repair budget at startup', () => {
  configure(true, true);
  assert.throws(() => new ApplicationRuntime(), /FEED_GENERATION_TIMEOUT_MS.*ML_ONBOARDING_TIMEOUT_MS/);
});

test('enabled generation validates its foreground wait and starts with valid budgets', async () => {
  configure(true, true, '90000', 'not-a-duration');
  assert.throws(() => new ApplicationRuntime(), /FEED_FOREGROUND_WAIT_MS/);
  configure(true, true, '90000');
  const runtime = new ApplicationRuntime();
  try {
    assert.ok(runtime.generation);
    runtime.start();
  } finally { await runtime.supervisor.stop(); }
});
