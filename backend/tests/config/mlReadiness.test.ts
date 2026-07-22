import assert from 'node:assert/strict';
import test from 'node:test';

import { applyMlReadinessGate, type MlHealthCheck } from '../../runtime/mlReadiness.js';

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
