import crypto from 'node:crypto';
import type { ScoringExportPolicy } from '../contracts/scoringExport.js';

export class ScoringExportConfigurationError extends Error {
  constructor() { super('SCORING_EXPORT_CONFIGURATION_INVALID'); this.name = 'ScoringExportConfigurationError'; }
}
const invalid = (): never => { throw new ScoringExportConfigurationError(); };
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;

export function validateScoringExportPolicy(value: ScoringExportPolicy): void {
  if (Object.keys(value).sort().join(',') !== 'clockSkewSeconds,labelHorizonSeconds,labelerVersion,lateArrivalSeconds,policyId,policyVersion,snapshotTtlSeconds'
    || ![value.policyId,value.policyVersion].every(text => typeof text === 'string' && text.length >= 1
      && Buffer.byteLength(text) <= 128 && text === text.trim())
    || value.labelerVersion !== 'scoring-labels-v1'
    || !integer(value.snapshotTtlSeconds,60,86_400) || !integer(value.labelHorizonSeconds,1,604_800)
    || !integer(value.lateArrivalSeconds,0,604_800) || !integer(value.clockSkewSeconds,0,3_600)) invalid();
}

/** Stable approved-policy digest. These are explicit choices, never defaults. */
export function scoringExportPolicyJson(policy: ScoringExportPolicy): string {
  validateScoringExportPolicy(policy);
  return JSON.stringify(Object.fromEntries(Object.keys(policy).sort().map(key => [key,policy[key as keyof ScoringExportPolicy]])));
}
export function scoringExportPolicyDigest(policy: ScoringExportPolicy): string {
  return crypto.createHash('sha256').update(scoringExportPolicyJson(policy)).digest('hex');
}

export type ScoringExportConfig = { enabled: false } | {
  enabled: true;
  policy: Readonly<ScoringExportPolicy>;
  exporterDatabaseUrl: string;
  statementTimeoutMs: number;
};

function requiredInteger(environment: Readonly<Record<string,string|undefined>>, name: string, minimum: number, maximum: number): number {
  const raw = environment[name] ?? '';
  if (!/^(0|[1-9][0-9]{0,6})$/.test(raw) || !integer(Number(raw),minimum,maximum)) return invalid();
  return Number(raw);
}

/** Disabled means no pool, no principal lookup and no inferred retention/labels. */
export function getScoringExportConfig(environment: Readonly<Record<string,string|undefined>> = process.env): ScoringExportConfig {
  const enabled = environment.SCORING_EXPORT_ENABLED;
  if (enabled === undefined || enabled === '' || enabled === 'false') return { enabled: false };
  if (enabled !== 'true') return invalid();
  const policy: ScoringExportPolicy = {
    policyId: environment.SCORING_EXPORT_POLICY_ID ?? '', policyVersion: environment.SCORING_EXPORT_POLICY_VERSION ?? '',
    snapshotTtlSeconds: requiredInteger(environment,'SCORING_EXPORT_SNAPSHOT_TTL_SECONDS',60,86_400),
    labelHorizonSeconds: requiredInteger(environment,'SCORING_EXPORT_LABEL_HORIZON_SECONDS',1,604_800),
    lateArrivalSeconds: requiredInteger(environment,'SCORING_EXPORT_LATE_ARRIVAL_SECONDS',0,604_800),
    clockSkewSeconds: requiredInteger(environment,'SCORING_EXPORT_CLOCK_SKEW_SECONDS',0,3_600), labelerVersion: 'scoring-labels-v1',
  };
  validateScoringExportPolicy(policy);
  const exporterDatabaseUrl = environment.SCORING_EXPORT_DATABASE_URL ?? '';
  try {
    const uri = new URL(exporterDatabaseUrl);
    if (!['postgres:','postgresql:'].includes(uri.protocol) || !uri.username
      || [environment.DATABASE_URL,environment.SCORING_CAPTURE_DATABASE_URL,environment.SCORING_RETENTION_DATABASE_URL].includes(exporterDatabaseUrl)) invalid();
  } catch { return invalid(); }
  return { enabled: true, policy: Object.freeze(policy), exporterDatabaseUrl,
    statementTimeoutMs: requiredInteger(environment,'SCORING_EXPORT_STATEMENT_TIMEOUT_MS',100,10_000) };
}
