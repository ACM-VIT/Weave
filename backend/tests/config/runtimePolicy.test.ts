import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import { feedGenerationBudget, mlTimeoutMs, resolveMlTimeouts } from "../../config/ml.js";
import { applyMlReadinessGate, type MlHealthCheck } from "../../runtime/mlReadiness.js";
import { applyOutboxReadinessGate, getOutboxDeadLimit } from "../../runtime/outboxReadiness.js";
import { resolveRedisUrl, validateProductionIntegrations } from "../../config/runtimeConfig.js";

describe("mlDeadlines", () => {
  test('operation budgets separate health, generation, and durable writes', () => {
    assert.deepEqual(resolveMlTimeouts({}), {
      timeoutMs: 5_000, generationTimeoutMs: 15_000, deliveryTimeoutMs: 30_000,
      onboardingTimeoutMs: 35_000, repositoryRefreshTimeoutMs: 50_000, repositoryIndexTimeoutMs: 240_000,
    });
    assert.deepEqual(feedGenerationBudget({}), { timeoutMs: 60_000, repairTimeoutMs: 35_000 });
  });

  test('explicit legacy timeouts remain effective until operation budgets are configured', () => {
    const legacy = { ML_TIMEOUT_MS: '5000', ML_DELIVERY_TIMEOUT_MS: '30000' };
    const budgets = resolveMlTimeouts(legacy);
    assert.equal(budgets.generationTimeoutMs, 5_000);
    assert.equal(budgets.onboardingTimeoutMs, 30_000);
    assert.equal(budgets.repositoryRefreshTimeoutMs, 30_000);
    const configured = resolveMlTimeouts({ ...legacy,
      ML_GENERATION_TIMEOUT_MS: '15000', ML_ONBOARDING_TIMEOUT_MS: '35000', ML_REPOSITORY_REFRESH_TIMEOUT_MS: '50000',
    });
    assert.equal(configured.generationTimeoutMs, 15_000);
    assert.equal(configured.onboardingTimeoutMs, 35_000);
    assert.equal(configured.repositoryRefreshTimeoutMs, 50_000);
    assert.equal(configured.timeoutMs, 5_000);
  });

  test('generation configuration rejects a repair that cannot fit its acknowledgement margin', () => {
    for (const environment of [
      { ML_DELIVERY_TIMEOUT_MS: '60000' },
      { ML_ONBOARDING_TIMEOUT_MS: '60000' },
      { ML_ONBOARDING_TIMEOUT_MS: '59000', FEED_GENERATION_TIMEOUT_MS: '60000' },
    ]) {
      assert.throws(() => feedGenerationBudget(environment),
        /FEED_GENERATION_TIMEOUT_MS.*ML_ONBOARDING_TIMEOUT_MS.*1000/);
    }
    assert.deepEqual(feedGenerationBudget({
      ML_DELIVERY_TIMEOUT_MS: '60000', FEED_GENERATION_TIMEOUT_MS: '90000',
    }), { timeoutMs: 90_000, repairTimeoutMs: 60_000 });
    assert.deepEqual(feedGenerationBudget({
      ML_DELIVERY_TIMEOUT_MS: '60000', ML_ONBOARDING_TIMEOUT_MS: '35000',
    }), { timeoutMs: 60_000, repairTimeoutMs: 35_000 });
  });

  test('invalid durations cannot overflow a Node timer into an immediate timeout', () => {
    for (const value of ['0', '-1', 'NaN', 'Infinity', '1.5', '2147483648']) {
      assert.throws(() => mlTimeoutMs('ML_TIMEOUT_MS', 5_000, { ML_TIMEOUT_MS: value }), /integer between/);
    }
    assert.equal(mlTimeoutMs('ML_TIMEOUT_MS', 5_000, { ML_TIMEOUT_MS: ' ' }), 5_000);
  });
});

describe("mlReadiness", () => {
  const readyCheck = (body: Record<string, unknown>): MlHealthCheck => ({
    healthy: true,
    status: 200,
    body,
  });

  test('recommendation readiness fails closed for a zero eligible corpus', () => {
    const result = applyMlReadinessGate(readyCheck({
      eligible_repository_points: 0,
      eligible_repository_count_exact: true,
      feedback_consumer_release_mismatch: false,
    }), { ML_V2_RECOMMENDATIONS: true, ML_FEEDBACK_OUTBOX: false });

    assert.equal(result.healthy, false);
    assert.deepEqual(result.readiness_errors, [
      'ML_V2_RECOMMENDATIONS requires an exact positive eligible_repository_points count.',
    ]);
  });

  test('recommendation readiness requires an exact eligible count from ML', () => {
    const result = applyMlReadinessGate(readyCheck({
      eligible_repository_points: 500,
      eligible_repository_count_exact: false,
    }), { ML_V2_RECOMMENDATIONS: true, ML_FEEDBACK_OUTBOX: false });

    assert.equal(result.healthy, false);
  });

  test('feedback readiness fails closed for a release mismatch', () => {
    const result = applyMlReadinessGate(readyCheck({
      feedback_consumer_release_mismatch: true,
    }), { ML_V2_RECOMMENDATIONS: false, ML_FEEDBACK_OUTBOX: true });

    assert.equal(result.healthy, false);
    assert.deepEqual(result.readiness_errors, [
      'ML_FEEDBACK_OUTBOX requires feedback_consumer_release_mismatch=false.',
    ]);
  });

  test('enabled ML features fail closed when required health fields are absent', () => {
    const result = applyMlReadinessGate(readyCheck({}), {
      ML_V2_RECOMMENDATIONS: true,
      ML_FEEDBACK_OUTBOX: true,
    });

    assert.equal(result.healthy, false);
    assert.equal(result.readiness_errors.length, 2);
  });

  test('healthy exact eligibility and matching feedback releases pass the gate', () => {
    const result = applyMlReadinessGate(readyCheck({
      eligible_repository_points: 500,
      eligible_repository_count_exact: true,
      feedback_consumer_release_mismatch: false,
    }), { ML_V2_RECOMMENDATIONS: true, ML_FEEDBACK_OUTBOX: true });

    assert.equal(result.healthy, true);
    assert.deepEqual(result.readiness_errors, []);
  });
});

describe("outboxReadiness", () => {
  const status = {
    pending: 0,
    claimed: 0,
    delivered: 12,
    dead: 1,
    superseded: 2,
    oldest_pending_seconds: 0,
  };

  test('production readiness rejects any dead outbox row by default', () => {
    assert.equal(getOutboxDeadLimit({ NODE_ENV: 'production' }), 0);
    assert.equal(applyOutboxReadinessGate(status, { NODE_ENV: 'production' }).healthy, false);
  });

  test('an explicit non-negative dead-row limit overrides the environment default', () => {
    assert.equal(getOutboxDeadLimit({ NODE_ENV: 'production', OUTBOX_MAX_DEAD: '2' }), 2);
    assert.equal(
      applyOutboxReadinessGate(status, { NODE_ENV: 'production', OUTBOX_MAX_DEAD: '2' }).healthy,
      true,
    );
  });

  test('invalid limits stay permissive outside production', () => {
    assert.equal(getOutboxDeadLimit({ NODE_ENV: 'development', OUTBOX_MAX_DEAD: '-1' }), Number.MAX_SAFE_INTEGER);
    assert.equal(getOutboxDeadLimit({ NODE_ENV: 'development', OUTBOX_MAX_DEAD: '' }), Number.MAX_SAFE_INTEGER);
    assert.equal(applyOutboxReadinessGate(status, { NODE_ENV: 'test' }).healthy, true);
  });
});

describe("runtimeConfig", () => {
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
});

test('scoped persistence overrides emit one complete timing per operation', async () => {
  const {measureFeedPersistence}=await import('../../observability/feedPersistence.js');
  const {snapshotMetrics}=await import('../../observability/metrics.js');
  const count=(operation:string,outcome:string)=>Object.entries(snapshotMetrics().distributions as Record<string,{count:number}>)
    .find(([key])=>key===`feed_persistence_duration_ms:${JSON.stringify([['operation',operation],['outcome',outcome]])}`)?.[1].count??0;
  const before=count('getGenerationContext','success');
  const failedBefore=count('getRecentPersonalizedEntries','failure');
  const work:string[]=[];
  const persistence=measureFeedPersistence({
    async getGenerationContext(){work.push('context');return {delivered:false};},
    async getRecentPersonalizedEntries():Promise<string[]>{work.push('recent');return ['entry'];},
  }, raw=>{
    const context=raw.getGenerationContext.bind(raw);
    raw.getGenerationContext=async()=>({...await context(),delivered:true});
    const recent=raw.getRecentPersonalizedEntries.bind(raw);
    raw.getRecentPersonalizedEntries=async()=>{await recent();work.push('scope');throw new Error('scope lookup failed');};
  });
  assert.deepEqual(await persistence.getGenerationContext(),{delivered:true});
  await assert.rejects(persistence.getRecentPersonalizedEntries(),/scope lookup failed/);
  assert.deepEqual(work,['context','recent','scope']);
  assert.equal(count('getGenerationContext','success')-before,1);
  assert.equal(count('getRecentPersonalizedEntries','failure')-failedBefore,1);
});
