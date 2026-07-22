import type { V2FeatureFlags } from '../config/features.js';

export type MlHealthCheck = {
  healthy: boolean;
  status?: number;
  body: unknown;
  [key: string]: unknown;
};

type MlHealthBody = {
  eligible_repository_points?: unknown;
  eligible_repository_count_exact?: unknown;
  feedback_consumer_release_mismatch?: unknown;
};

function healthBody(value: unknown): MlHealthBody {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as MlHealthBody
    : {};
}

export function applyMlReadinessGate(
  check: MlHealthCheck,
  flags: Pick<V2FeatureFlags, 'ML_V2_RECOMMENDATIONS' | 'ML_FEEDBACK_OUTBOX'>,
): MlHealthCheck & { readiness_errors: string[] } {
  const body = healthBody(check.body);
  const errors: string[] = [];

  if (flags.ML_V2_RECOMMENDATIONS
    && (!Number.isInteger(body.eligible_repository_points)
      || Number(body.eligible_repository_points) <= 0
      || body.eligible_repository_count_exact !== true)) {
    errors.push('ML_V2_RECOMMENDATIONS requires an exact positive eligible_repository_points count.');
  }

  if (flags.ML_FEEDBACK_OUTBOX && body.feedback_consumer_release_mismatch !== false) {
    errors.push('ML_FEEDBACK_OUTBOX requires feedback_consumer_release_mismatch=false.');
  }

  return {
    ...check,
    healthy: check.healthy && errors.length === 0,
    readiness_errors: errors,
  };
}
