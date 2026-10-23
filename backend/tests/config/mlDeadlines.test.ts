import assert from 'node:assert/strict';
import test from 'node:test';
import { feedGenerationBudget, mlTimeoutMs, resolveMlTimeouts } from '../../config/ml.js';

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
