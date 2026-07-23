import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cohortBucket,
  getV2FeatureFlags,
  inRolloutCohort,
  validateFeatureDependencies,
  validateWorkerRoleDependencies,
} from '../../config/features.js';

test('V2 is the fail-closed default and non-ML fallback is dark', () => {
  const previous = Object.fromEntries(Object.keys(process.env).filter((key) => key.startsWith('DB_SCHEMA_V2')
    || key.startsWith('FEED_V2') || key.startsWith('FEED_RESERVATIONS') || key.startsWith('ML_')
    || key === 'TRENDING_FALLBACK').map((key) => [key, process.env[key]]));
  for (const key of Object.keys(previous)) delete process.env[key];
  try {
    assert.deepEqual(getV2FeatureFlags(), {
      DB_SCHEMA_V2_READS: true, DB_SCHEMA_V2_WRITES: true, FEED_V2: true,
      FEED_RESERVATIONS: true, ML_V2_RECOMMENDATIONS: true, ML_FEEDBACK_OUTBOX: true,
      ML_QDRANT_ONLY: true, TRENDING_FALLBACK: false,
    });
    assert.equal(
      inRolloutCohort('00000000-0000-4000-8000-000000000001', 'FEED_V2_CANARY'),
      true,
    );
    assert.equal(
      inRolloutCohort('00000000-0000-4000-8000-000000000001', 'FEED_V2_SHADOW'),
      false,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value !== undefined) process.env[key] = value;
  }
});

test('rollout cohorts are deterministic and feature dependencies fail closed', () => {
  assert.equal(cohortBucket('00000000-0000-4000-8000-000000000001', 'FEED_V2_CANARY'),
    cohortBucket('00000000-0000-4000-8000-000000000001', 'FEED_V2_CANARY'));
  assert.deepEqual(validateFeatureDependencies({
    DB_SCHEMA_V2_READS: true, DB_SCHEMA_V2_WRITES: false, FEED_V2: true,
    FEED_RESERVATIONS: false, ML_V2_RECOMMENDATIONS: true, ML_FEEDBACK_OUTBOX: true,
    ML_QDRANT_ONLY: false, TRENDING_FALLBACK: true,
  }), [
    'DB_SCHEMA_V2_READS requires DB_SCHEMA_V2_WRITES.',
    'FEED_V2 requires FEED_RESERVATIONS.',
    'ML_V2_RECOMMENDATIONS requires FEED_V2 and ML_QDRANT_ONLY.',
    'ML_FEEDBACK_OUTBOX requires DB_SCHEMA_V2_WRITES.',
  ]);
});

test('dedicated worker roles fail closed when their owning feature is disabled', () => {
  const flags = {
    DB_SCHEMA_V2_READS: true,
    DB_SCHEMA_V2_WRITES: true,
    FEED_V2: true,
    FEED_RESERVATIONS: true,
    ML_V2_RECOMMENDATIONS: false,
    ML_FEEDBACK_OUTBOX: false,
    ML_QDRANT_ONLY: true,
    TRENDING_FALLBACK: true,
  };

  assert.deepEqual(validateWorkerRoleDependencies('outbox', flags), [
    'WORKER_ROLE=outbox requires ML_FEEDBACK_OUTBOX=true.',
  ]);
  assert.deepEqual(validateWorkerRoleDependencies('feed', flags), []);
  assert.deepEqual(validateWorkerRoleDependencies('maintenance', flags), []);
});
