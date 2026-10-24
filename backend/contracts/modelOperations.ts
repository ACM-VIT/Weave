import { createHash } from 'node:crypto';
import type { MlOnboardingJob } from './ml.v2.js';

export const MODEL_POLICY_VERSION = 'long-session-v1' as const;
export const MAX_MODEL_OPERATION_BYTES = 131072;
export type CanonicalValue = null | boolean | number | string | readonly CanonicalValue[] | { readonly [key: string]: CanonicalValue };
export function canonicalJson(value: CanonicalValue): string {
  if (typeof value === 'string') {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new Error('Invalid model operation text.');
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || Object.is(value, -0))) throw new Error('Invalid model operation number.');
  if (Array.isArray(value)) return '[' + Array.from(value,item => canonicalJson(item)).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort((a,b)=>Buffer.compare(Buffer.from(a,'utf8'),Buffer.from(b,'utf8'))).map(key => canonicalJson(key) + ':' + canonicalJson((value as { readonly [key: string]: CanonicalValue })[key])).join(',') + '}';
  }
  if (value === undefined) throw new Error('Missing model operation value.');
  return JSON.stringify(value);
}
export const modelDigest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
export function decimalInt64(value: string, positive = false): string {
  if (value.length>19 || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 9223372036854775807n || (positive && value === '0')) throw new Error('Invalid model operation revision.');
  return value;
}
export type CanonicalAttribution = {
  user_id: string; session_id: string; epoch: string; epoch_started_ms: string;
  active_at_acceptance: boolean; witness_sha256: string;
}
export type ModelOperationInput =
  | { kind: 'profile'; operation: { job_id: string; profile_version: string; allow_genesis: boolean; original_profile_context: MlOnboardingJob['profile'] } }
  | { kind: 'begin'; operation: { session_id: string; epoch: string; epoch_started_ms: string; witness_sha256: string } }
  | { kind: 'feedback'; operation: { original_feedback_json: string; canonical_attribution?: CanonicalAttribution } }
  | { kind: 'reset'; operation: { session_id: string; old_epoch: string; new_epoch: string; new_epoch_started_ms: string; witness_sha256: string } }
  | { kind: 'end'; operation: { session_id: string; epoch: string; epoch_started_ms: string; retired: true; witness_sha256: string } };
export interface FrozenModelOperation {
  operationId: string; userId: string; version: string; previousVersion: string;
  acceptedAtMs: string; sourceSha256: string; operationJson: string;
}
export class ModelOperationError extends Error {
  constructor(readonly code = 'MODEL_OPERATION_UNAVAILABLE', readonly statusCode = 503) { super(code); this.name = 'ModelOperationError'; }
}
