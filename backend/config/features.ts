import crypto from 'node:crypto';

export const V2_FEATURE_NAMES = [
  'DB_SCHEMA_V2_READS',
  'DB_SCHEMA_V2_WRITES',
  'FEED_V2',
  'FEED_RESERVATIONS',
  'ML_V2_RECOMMENDATIONS',
  'ML_FEEDBACK_OUTBOX',
  'ML_QDRANT_ONLY',
  'TRENDING_FALLBACK',
] as const;

export type V2FeatureName = typeof V2_FEATURE_NAMES[number];
export type V2FeatureFlags = Record<V2FeatureName, boolean>;
export type DedicatedWorkerRole = 'outbox' | 'feed' | 'maintenance';

function enabled(name: V2FeatureName, fallback = false): boolean {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function percentage(name: string, fallback = 0): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function getV2FeatureFlags(): V2FeatureFlags {
  return {
    DB_SCHEMA_V2_READS: enabled('DB_SCHEMA_V2_READS', true),
    DB_SCHEMA_V2_WRITES: enabled('DB_SCHEMA_V2_WRITES', true),
    FEED_V2: enabled('FEED_V2', true),
    FEED_RESERVATIONS: enabled('FEED_RESERVATIONS', true),
    ML_V2_RECOMMENDATIONS: enabled('ML_V2_RECOMMENDATIONS', true),
    ML_FEEDBACK_OUTBOX: enabled('ML_FEEDBACK_OUTBOX', true),
    ML_QDRANT_ONLY: enabled('ML_QDRANT_ONLY', true),
    TRENDING_FALLBACK: enabled('TRENDING_FALLBACK', false),
  };
}

export function cohortBucket(subjectId: string, salt: string): number {
  const digest = crypto.createHash('sha256').update(`${salt}:${subjectId}`).digest();
  return digest.readUInt32BE(0) % 10_000 / 100;
}

export function inRolloutCohort(subjectId: string, name: 'FEED_V2_CANARY' | 'FEED_V2_SHADOW'): boolean {
  return cohortBucket(subjectId, name) < percentage(
    `${name}_PERCENT`,
    name === 'FEED_V2_CANARY' ? 100 : 0,
  );
}

export function validateFeatureDependencies(flags = getV2FeatureFlags()): string[] {
  const errors: string[] = [];
  if (flags.DB_SCHEMA_V2_READS && !flags.DB_SCHEMA_V2_WRITES) {
    errors.push('DB_SCHEMA_V2_READS requires DB_SCHEMA_V2_WRITES.');
  }
  if (flags.FEED_V2 && !flags.FEED_RESERVATIONS) {
    errors.push('FEED_V2 requires FEED_RESERVATIONS.');
  }
  if (flags.ML_V2_RECOMMENDATIONS && (!flags.FEED_V2 || !flags.ML_QDRANT_ONLY)) {
    errors.push('ML_V2_RECOMMENDATIONS requires FEED_V2 and ML_QDRANT_ONLY.');
  }
  if (flags.ML_FEEDBACK_OUTBOX && !flags.DB_SCHEMA_V2_WRITES) {
    errors.push('ML_FEEDBACK_OUTBOX requires DB_SCHEMA_V2_WRITES.');
  }
  return errors;
}

export function validateWorkerRoleDependencies(
  role: DedicatedWorkerRole | 'all',
  flags = getV2FeatureFlags(),
): string[] {
  if (role === 'all') return [];
  const requiredFlag: Record<DedicatedWorkerRole, V2FeatureName> = {
    outbox: 'ML_FEEDBACK_OUTBOX',
    feed: 'FEED_RESERVATIONS',
    maintenance: 'DB_SCHEMA_V2_WRITES',
  };
  const required = requiredFlag[role];
  return flags[required] ? [] : [`WORKER_ROLE=${role} requires ${required}=true.`];
}
