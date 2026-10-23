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

test('publication repair is scheduled only by an enabled capture feed worker',async()=>{
  const previous={...process.env};
  try {
    configure(true,false,'90000');
    Object.assign(process.env,{
      FEED_RESERVATIONS:'true',SCORING_CAPTURE_ENABLED:'true',
      SCORING_CAPTURE_POLICY_ID:'fixture',SCORING_CAPTURE_POLICY_VERSION:'1',SCORING_CAPTURE_RETENTION_DAYS:'30',
      SCORING_CAPTURE_USER_IDS:'00000000-0000-0000-0000-000000000001',
      SCORING_CAPTURE_CAPABILITY:'a'.repeat(64),
      SCORING_CAPTURE_DATABASE_URL:'postgresql://capture@127.0.0.1:1/runtime_test',
    });
    for(const role of ['api','outbox','maintenance','feed','all'] as const){
      const runtime=new ApplicationRuntime(role);
      try { assert.equal('scoring-publication-reconciliation' in runtime.supervisor.snapshot(),role==='feed'||role==='all'); }
      finally { await runtime.supervisor.stop(); }
    }
    process.env.SCORING_CAPTURE_ENABLED='false';
    const disabled=new ApplicationRuntime('feed');
    try {
      assert.equal(disabled.privateScoring,null);
      assert.equal('scoring-publication-reconciliation' in disabled.supervisor.snapshot(),false);
    } finally { await disabled.supervisor.stop(); }
  } finally {
    for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];
    Object.assign(process.env,previous);
  }
});

test('enabled private retention refuses absent and whitespace-only operational cadences', async () => {
  const previous = { ...process.env };
  try {
    configure(false, false);
    Object.assign(process.env, { SCORING_CAPTURE_ENABLED: 'false', SCORING_RETENTION_ENABLED: 'true',
      SCORING_RETENTION_DATABASE_URL: 'postgresql://retention@127.0.0.1:1/runtime_test',
      SCORING_RETENTION_STATEMENT_TIMEOUT_MS: '1000', SCORING_RETENTION_BATCH_SIZE: '1' });
    for (const cadence of [undefined, '', ' ', '\t\n']) {
      if (cadence === undefined) delete process.env.SCORING_RETENTION_INTERVAL_MS;
      else process.env.SCORING_RETENTION_INTERVAL_MS = cadence;
      assert.throws(() => new ApplicationRuntime('maintenance'), /SCORING_RETENTION_INTERVAL_REQUIRED/);
    }
    process.env.SCORING_RETENTION_INTERVAL_MS = '1000';
    const runtime = new ApplicationRuntime('maintenance');
    try { assert.equal('private-scoring-retention' in runtime.supervisor.snapshot(), true); }
    finally { await runtime.supervisor.stop(); }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
