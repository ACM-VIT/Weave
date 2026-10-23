import crypto from 'node:crypto';
import type { CaptureRetentionPolicy, ScoringCandidateSubmission, ScoringGenerationSelector, ScoringInputReference } from '../contracts/scoringCapture.js';

const contextKeys = ['encoding','dimensions','user_id','generation_id','scored_at','feed_version','profile_version',
  'feedback_version','feedback_state_revision','embedding_model','embedding_revision','user_embedding_version',
  'repository_embedding_versions','user_vector_sha256','model_version','model_sha256','scaler_sha256','manifest_sha256',
  'feature_spec_version','feature_order_sha256','code_commit'];
const snapshotKeys = ['repo_id','content_version','feature_version','content_hash','source_hash','embedding_version_index'];
const featureOrder = ['doc_quality','code_health','readme_length','star_count','fork_count','open_issues_count',
  'pushed_days_ago','activity_score','trend_velocity','skill_match_score'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const revision = /^[0-9a-f]{40}$/;
const maximumVersion = 9_223_372_036_854_775_807n;
export const SCORING_INPUT_BYTES = 3112;
export const SCORING_WIRE_BYTES = 1_000_000;
export const SCORING_MAX_ITEMS = 150;

export class ScoringCaptureValidationError extends Error {
  constructor() { super('SCORING_CAPTURE_INVALID'); this.name = 'ScoringCaptureValidationError'; }
}
function invalid(): never { throw new ScoringCaptureValidationError(); }
const sha = (value: crypto.BinaryLike) => crypto.createHash('sha256').update(value).digest('hex');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid();
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum * 2
    && [...value].length <= maximum && Buffer.from(value,'utf8').toString('utf8') === value;
}
function matches(value: unknown, pattern: RegExp): value is string { return typeof value === 'string' && pattern.test(value); }
function decimal(value: unknown, positive = false): boolean {
  return matches(value, /^(0|[1-9][0-9]{0,18})$/) && BigInt(value) <= maximumVersion && (!positive || value !== '0');
}
function utcTime(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|\+00:00)$/.exec(value);
  if (!parts || parts[1] === '0000') return false;
  const parsed = new Date(value);
  return [parsed.getUTCFullYear(),parsed.getUTCMonth()+1,parsed.getUTCDate(),parsed.getUTCHours(),parsed.getUTCMinutes(),parsed.getUTCSeconds()]
    .every((component, index) => component === Number(parts[index+1]));
}

/** Fixed ASCII codec keys, with only strings, integers and string arrays. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key =>
    JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function validateCaptureRetentionPolicy(policy: CaptureRetentionPolicy): void {
  if (!text(policy.policyId, 128) || !text(policy.policyVersion, 128)
    || policy.policyId !== policy.policyId.trim() || policy.policyVersion !== policy.policyVersion.trim()
    || !Number.isInteger(policy.retentionDays) || policy.retentionDays < 1 || policy.retentionDays > 365) invalid();
}

interface PersistedCandidate { snapshot_json: string; input_base64: string; binding_sha256: string;
  stage_json: string; record_digest: string }

/** Private fields keep accidental JSON/log serialization from exposing tensors. */
export class ValidatedScoringGeneration {
  #context: string;
  #items: readonly PersistedCandidate[];
  readonly references: readonly ScoringInputReference[];
  private constructor(context: string, items: readonly PersistedCandidate[], generationId: string) {
    this.#context = context;
    this.#items = items;
    this.references = Object.freeze(items.map(item => Object.freeze({ generation_id: generationId,
      repo_id: String(JSON.parse(item.snapshot_json).repo_id), record_digest: item.record_digest })));
  }

  static validate(rawContext: unknown, candidates: readonly ScoringCandidateSubmission[], expected: ScoringGenerationSelector): ValidatedScoringGeneration {
    if (!uuid.test(expected.userId) || !uuid.test(expected.generationId)
      || expected.feedVersion <= 0n || expected.feedVersion > maximumVersion
      || !Array.isArray(candidates) || candidates.length < 1 || candidates.length > SCORING_MAX_ITEMS) invalid();
    const context = object(rawContext); exact(context, contextKeys);
    if (context.encoding !== 'float32-le-v1' || context.dimensions !== 778 || context.feature_spec_version !== 'v2'
      || context.user_id !== expected.userId || context.generation_id !== expected.generationId
      || context.feed_version !== expected.feedVersion.toString() || !decimal(context.feed_version, true)
      || !decimal(context.profile_version, true) || !decimal(context.feedback_version) || !decimal(context.feedback_state_revision)
      || !text(context.scored_at, 40) || !utcTime(context.scored_at)
      || !text(context.embedding_model, 128) || !matches(context.embedding_revision, revision)
      || !(context.user_embedding_version === null || text(context.user_embedding_version, 128))
      || !text(context.model_version, 512) || !matches(context.code_commit, revision)
      || !['user_vector_sha256','model_sha256','scaler_sha256','manifest_sha256','feature_order_sha256']
        .every(key => matches(context[key], digest))
      || context.feature_order_sha256 !== sha(canonical(featureOrder))) invalid();
    const versions = context.repository_embedding_versions;
    if (!Array.isArray(versions) || versions.length < 1 || versions.length > 8
      || versions.some(value => !text(value, 128)) || new Set(versions).size !== versions.length) invalid();
    const contextJson = canonical(context), contextBytes = Buffer.from(contextJson);
    if (contextBytes.length > 16_384) invalid();
    const seen = new Set<string>();
    const items = candidates.map((submission, providerPosition) => {
      const candidate = object(submission);
      exact(candidate, ['packet','rawHeavyScore','finalScore','source','retrievalScores']);
      const packet = object(candidate.packet); exact(packet, ['snapshot','input_base64','binding_sha256']);
      const snapshot = object(packet.snapshot); exact(snapshot, snapshotKeys);
      if (!matches(snapshot.repo_id, uuid) || seen.has(snapshot.repo_id) || !decimal(snapshot.content_version, true)
        || !decimal(snapshot.feature_version) || !text(snapshot.content_hash, 128) || !matches(snapshot.source_hash, digest)
        || typeof snapshot.embedding_version_index !== 'number' || !Number.isInteger(snapshot.embedding_version_index)
        || snapshot.embedding_version_index < 0 || snapshot.embedding_version_index >= versions.length
        || !text(packet.input_base64, 4152) || packet.input_base64.length !== 4152
        || !matches(packet.binding_sha256, digest)) invalid();
      seen.add(snapshot.repo_id);
      const raw = Buffer.from(packet.input_base64, 'base64');
      if (raw.length !== SCORING_INPUT_BYTES || raw.toString('base64') !== packet.input_base64
        || sha(raw.subarray(0, 1536)) !== context.user_vector_sha256) invalid();
      for (let offset = 0; offset < raw.length; offset += 4) if (!Number.isFinite(raw.readFloatLE(offset))) invalid();
      const snapshotJson = canonical(snapshot);
      const binding = Buffer.concat([Buffer.from('{"context":' + contextJson + ',"snapshot":' + snapshotJson + '}'), raw]);
      if (sha(binding) !== packet.binding_sha256) invalid();
      if (!Number.isFinite(candidate.rawHeavyScore) || !Number.isFinite(candidate.finalScore) || !text(candidate.source, 128) || candidate.source !== candidate.source.trim()) invalid();
      const scores = object(candidate.retrievalScores);
      if (Object.keys(scores).length > 16 || Object.entries(scores).some(([key, value]) =>
        !/^[a-z_]{1,32}$/.test(key) || typeof value !== 'number' || !Number.isFinite(value))) invalid();
      const stageJson = canonical({ provider_position: providerPosition, raw_heavy_score: candidate.rawHeavyScore, final_score: candidate.finalScore,
        source: candidate.source, retrieval_scores: scores });
      const recordDigest = sha(Buffer.concat([contextBytes, Buffer.from(snapshotJson), raw, Buffer.from(stageJson)]));
      return Object.freeze({ snapshot_json: snapshotJson, input_base64: packet.input_base64,
        binding_sha256: packet.binding_sha256, stage_json: stageJson, record_digest: recordDigest });
    });
    return new ValidatedScoringGeneration(contextJson, Object.freeze(items), expected.generationId);
  }

  /** Only the private persistence adapter should bind this parameter to SQL. */
  serializeForPersistence(policy: CaptureRetentionPolicy): string {
    validateCaptureRetentionPolicy(policy);
    const payload = JSON.stringify({ schema_version: 1, context_json: this.#context, context_digest: sha(this.#context),
      items: this.#items, policy_id: policy.policyId, policy_version: policy.policyVersion, retention_days: policy.retentionDays });
    if (Buffer.byteLength(payload) > SCORING_WIRE_BYTES) invalid();
    return payload;
  }
}
