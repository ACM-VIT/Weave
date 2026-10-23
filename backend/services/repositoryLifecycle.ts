import type { MlRepositorySource } from '../contracts/ml.v2.js';

export type RepositoryLifecycleObservation = NonNullable<MlRepositorySource['lifecycle']>;
export const LIFECYCLE_POLICY = 'verified-status-v1';

/** Accept complete observations only; 404s/timeouts never assert deletion. */
export function validateRepositoryLifecycle(value: unknown): asserts value is RepositoryLifecycleObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid lifecycle observation.');
  const item = value as Record<string, unknown>;
  const keys = new Set(['status', 'source', 'observed_at', 'archived', 'disabled']);
  if (Object.keys(item).some(key => !keys.has(key))) throw new Error('Unknown lifecycle observation field.');
  if (typeof item.source !== 'string' || !['github-graphql-repository', 'github-rest-repository'].includes(item.source)) throw new Error('Invalid lifecycle source.');
  const match = typeof item.observed_at === 'string'
    ? /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d{1,6})?(Z|([+-])(\d\d):(\d\d))$/.exec(item.observed_at) : null;
  const parsed = typeof item.observed_at === 'string' ? Date.parse(item.observed_at) : NaN;
  const offset = match && match[2] !== 'Z'
    ? (Number(match[4]) * 60 + Number(match[5])) * (match[3] === '+' ? 1 : -1) : 0;
  if (!match || !Number.isFinite(parsed) || parsed > Date.now()
    || new Date(parsed + offset * 60_000).toISOString().slice(0, 19) !== match[1]) {
    throw new Error('Invalid lifecycle observation time.');
  }
  if (item.status === 'verified') {
    if (typeof item.archived !== 'boolean' || typeof item.disabled !== 'boolean') throw new Error('Verified lifecycle requires both flags.');
  } else if (item.status !== 'unavailable' || item.archived != null || item.disabled != null) {
    throw new Error('Unavailable lifecycle cannot assert status.');
  }
}

/** Disabled by default until the cross-repository policy/release is approved. */
export function lifecycleForMl(value: RepositoryLifecycleObservation | null | undefined): RepositoryLifecycleObservation | undefined {
  const mode = process.env.ML_REPOSITORY_LIFECYCLE_OBSERVATIONS ?? 'disabled';
  if (!['disabled', LIFECYCLE_POLICY].includes(mode)) throw new Error('Invalid ML_REPOSITORY_LIFECYCLE_OBSERVATIONS.');
  if (value == null) return undefined;
  validateRepositoryLifecycle(value);
  return mode === LIFECYCLE_POLICY ? structuredClone(value) : undefined;
}
