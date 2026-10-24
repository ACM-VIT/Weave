import type { CaptureRetentionPolicy } from '../contracts/scoringCapture.js';
import { validateCaptureRetentionPolicy } from '../services/scoringCaptureValidation.js';

export type ScoringCaptureConfig = { enabled: false } | {
  enabled: true;
  policy: CaptureRetentionPolicy;
  userIds: ReadonlySet<string>;
  writerDatabaseUrl: string;
  capability: string;
  writeTimeoutMs: number;
};
const invalid = (): never => { throw new Error('SCORING_CAPTURE_CONFIGURATION_INVALID'); };

/** No policy, principal, pool or collection is inferred when disabled. */
export function getScoringCaptureConfig(environment: Readonly<Record<string, string | undefined>> = process.env): ScoringCaptureConfig {
  const enabled = environment.SCORING_CAPTURE_ENABLED;
  if (enabled === undefined || enabled === '' || enabled === 'false') return { enabled: false };
  if (enabled !== 'true') return invalid();
  const retention = environment.SCORING_CAPTURE_RETENTION_DAYS ?? '';
  if (!/^[1-9][0-9]{0,2}$/.test(retention)) return invalid();
  const policy = { policyId: environment.SCORING_CAPTURE_POLICY_ID ?? '',
    policyVersion: environment.SCORING_CAPTURE_POLICY_VERSION ?? '', retentionDays: Number(retention) };
  try { validateCaptureRetentionPolicy(policy); } catch { return invalid(); }
  const users = (environment.SCORING_CAPTURE_USER_IDS ?? '').split(',');
  if (users.length < 1 || users.length > 100 || users.some(user =>
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(user))) return invalid();
  const capability = environment.SCORING_CAPTURE_CAPABILITY ?? '';
  if (capability.length !== 64 || !/^[0-9a-f]{64}$/.test(capability)) return invalid();
  const writerDatabaseUrl = environment.SCORING_CAPTURE_DATABASE_URL ?? '';
  try {
    const url = new URL(writerDatabaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || writerDatabaseUrl === environment.DATABASE_URL) return invalid();
  } catch { return invalid(); }
  const writeTimeout = environment.SCORING_CAPTURE_WRITE_TIMEOUT_MS ?? '2000';
  if (!/^[1-9][0-9]{0,4}$/.test(writeTimeout) || Number(writeTimeout) > 10_000) return invalid();
  return { enabled: true, policy: Object.freeze(policy), userIds: new Set(users), writerDatabaseUrl,
    capability, writeTimeoutMs: Number(writeTimeout) };
}
