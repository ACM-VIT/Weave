import type { MlModelOperationBatch, MlModelOperationResponse, MlProfileWithdrawalBatch, MlProfileWithdrawalResponse, MlModelOperationStatusRequest, MlModelOperationStatusResponse, MlModelAuthorityRequest, MlModelAuthorityResponse } from '../contracts/ml.v2.js';
import { parseModelAcknowledgement, parseWithdrawalAcknowledgement, parseModelOperationStatus, parseAppliedModelContext,modelRecord } from './modelOperationValidation.js';
import { ModelOperationError } from '../contracts/modelOperations.js';
import crypto from 'node:crypto';
import { rejectDuplicateJsonKeys, validateCapturedRecommendation } from './capturedRecommendation.js';
import { startSpan, mlOperation, httpOutcome } from '../observability/tracing.js';
import type { StageOutcome } from '../observability/metrics.js';
import { performance } from 'node:perf_hooks';
import type { RecommendationPort } from '../ports/recommendationPort.js';
import type { OutboxTransportPort } from '../ports/outboxTransportPort.js';
import type {
  DeliveryResult,
  MlPostPath,
  MlRequest,
  MlDeliveryPath,
  MlFeedbackBatch,
  MlOnboardingJob,
  MlRecommendationRequest,
  MlRecommendationResponse,
  MlRepositoryIndexJob,
  MlRepositoryIndexResponse,
  MlRepositoryRefreshJob,
} from '../contracts/ml.v2.js';
import { ML_DESCRIPTION_FALLBACK_MODEL_VERSION } from '../contracts/ml.v2.js';
import { getMlRuntimeConfig, type MlRuntimeConfig } from '../config/ml.js';
import { isValidUuid } from '../utils/validators.js';
import { incrementMetric, observeMetric } from '../observability/metrics.js';

class MlTransportTimeoutError extends Error {}

type RecommendationFailureKind = 'dependency' | 'contract';
type RecommendationCircuitState = 'closed' | 'open' | 'half-open';

interface RecommendationCircuitOptions {
  /** Monotonic milliseconds; injectable for deterministic recovery checks. */
  now?: () => number;
  failureThreshold?: number;
  openMs?: number;
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isDependencyStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export type MlRecommendationFailureKind =
  | 'persona_unavailable'
  | 'authentication'
  | 'service_unavailable'
  | 'contract';

export class MlRecommendationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: MlRecommendationFailureKind,
    readonly detail?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'MlRecommendationError';
  }
  get statusCode(): number { return this.status; }
}

export class MlRepositoryIndexContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MlRepositoryIndexContractError';
  }
}

function repositoryIndexContractError(message: string): never {
  throw new MlRepositoryIndexContractError(message);
}

function responseDetail(body: unknown): string | undefined {
  if (typeof body === 'string') return body.trim() || undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  for (const key of ['detail', 'error', 'message', 'code']) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  return undefined;
}

function recommendationFailureKind(status: number, body: unknown): MlRecommendationFailureKind {
  const detail = `${responseDetail(body) ?? ''} ${JSON.stringify(body ?? '')}`.toLowerCase();
  const mentionsPersona = /(user|persona|profile)/.test(detail);
  const mentionsVector = /(vector|embedding)/.test(detail);
  const mentionsMissing = /(missing|unavailable|not[ _-]?found|does not exist)/.test(detail);
  if (mentionsPersona && mentionsVector && mentionsMissing) return 'persona_unavailable';
  if (status === 401 || status === 403) return 'authentication';
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return 'service_unavailable';
  }
  return 'contract';
}

function exactObjectKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function boundedVersion(value: unknown, maximum = 200): value is string {
  return typeof value === 'string' && value === value.trim()
    && value.length >= 1 && value.length <= maximum;
}

const SUMMARY_SENTENCE_END_PATTERN = String.raw`[.!?](?:["'”’)\]]+)?(?=\s|$)`;
const SUMMARY_SENTENCE_START_PATTERN = String.raw`(?:^|${SUMMARY_SENTENCE_END_PATTERN}\s+|\n)[ \t]*`;

function maskSummaryAbbreviations(value: string): string {
  // Keep the ASCII boundary case-sensitive: Unicode /iu folds K and ſ into it.
  return value.replace(/(?<![A-Za-z0-9_])(?:[eE]\.[gG]|[iI]\.[eE])\./gu, (match) => match.replaceAll('.', '·'))
    .replace(/(?<![A-Za-z0-9_])(?:Mr|Mrs|Ms|Dr|Prof|Jr|Sr|vs)\.(?=\s+\p{L})/gu, (match) => match.replaceAll('.', '·'))
    // Ambiguous abbreviations retain their ending before a new capitalized sentence.
    .replace(/(?<![A-Za-z0-9_])(?:etc\.|(?:[A-Z]\.){2,})(?=\s+\p{Ll})/gu, (match) => match.replaceAll('.', '·'));
}

function hasTwoOrThreeCompleteSentences(value: string): boolean {
  const prose = maskSummaryAbbreviations(value);
  const endings = prose.match(new RegExp(SUMMARY_SENTENCE_END_PATTERN, 'gu')) ?? [];
  return (endings.length === 2 || endings.length === 3)
    && new RegExp(`${SUMMARY_SENTENCE_END_PATTERN}$`, 'u').test(prose);
}

function normalizedProse(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function containsCopiedPassage(
  summary: string,
  readme: string | null | undefined,
  allowedSource?: string | null,
): boolean {
  if (!readme) return false;
  const candidate = normalizedProse(summary);
  const source = normalizedProse(readme);
  const allowed = allowedSource ? normalizedProse(allowedSource) : '';
  if (candidate.length < 80 || source.length < 80) return false;
  for (let index = 0; index <= candidate.length - 80; index++) {
    const passage = candidate.slice(index, index + 80);
    if (source.includes(passage) && !allowed.includes(passage)) return true;
  }
  return false;
}

function hasForbiddenCardContent(value: string): boolean {
  const prose = maskSummaryAbbreviations(value);
  return /(?:^|\n)\s*#{1,6}\s|```|~~~|`/.test(value)
    || /(?:^|\n)\s*(?:[-+*]|\d+[.)])\s+/u.test(value)
    || /!?\[[^\]\n]*\]\([^)\n]+\)/u.test(value)
    || new RegExp(String.raw`${SUMMARY_SENTENCE_START_PATTERN}(?:installation(?: instructions?)?|license(?: text)?|contribut(?:ing|ors?)(?: section)?|changelog|table of contents|API (?:reference|documentation))\s*[:\-]`, 'iu').test(prose)
    || /\b(?:licensed under|MIT License|Apache License|GNU (?:General Public )?License)\b/i.test(value)
    || new RegExp(String.raw`${SUMMARY_SENTENCE_START_PATTERN}GPL(?:[ \t-]*v?\d+(?:\.\d+)*(?:\+|[ \t]+or[ \t]+later)?|[ \t]*\+|[ \t]+or[ \t]+later)?[ \t]*(?:[.!?:]|$)`, 'iu').test(prose)
    || /\b(?:npm|pnpm|yarn|pip|pipx|uv|cargo|go|brew)\s+(?:install|add|run|get)\b/i.test(value);
}

/**
 * Validates the durable repository-index response before the outbox worker is
 * allowed to persist it or mark its request delivered.
 */
export function parseMlRepositoryIndexResponse(
  body: unknown,
  job: MlRepositoryIndexJob,
): MlRepositoryIndexResponse {
  if (typeof job.repository.content_hash !== 'string'
    || job.repository.content_hash !== job.repository.content_hash.trim()
    || job.repository.content_hash.length < 1
    || job.repository.content_hash.length > 256) {
    repositoryIndexContractError('ML repository-index request is missing a valid content hash.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    repositoryIndexContractError('ML repository-index response must be a JSON object.');
  }
  const value = body as Record<string, unknown>;
  if (!exactObjectKeys(value, [
    'accepted', 'card_summary', 'content_version', 'embedding_version', 'job_id',
    'repo_id', 'schema_version', 'status',
  ])) repositoryIndexContractError('ML repository-index response violated the v2 envelope.');
  if (value.schema_version !== 2 || value.accepted !== true
    || !['applied', 'duplicate', 'current'].includes(String(value.status))
    || value.job_id !== job.job_id || value.repo_id !== job.repo_id
    || value.content_version !== job.content_version
    || !boundedVersion(value.embedding_version)) {
    repositoryIndexContractError('ML repository-index response did not match the requested repository version.');
  }

  validateRepositoryCardSummary(value.card_summary, job.repository);
  return body as MlRepositoryIndexResponse;
}

export function isMissingPersonaRecommendationError(error: unknown): boolean {
  return error instanceof MlRecommendationError && error.kind === 'persona_unavailable';
}

/** The same acceptance policy applies to incoming and already persisted artifacts. */
export function validateRepositoryCardSummary(
  body: unknown,
  repository: { readme?: string | null; description?: string | null },
): void {
  if (!body || typeof body !== 'object'
    || Array.isArray(body)) {
    repositoryIndexContractError('ML repository-index response is missing card_summary.');
  }
  const artifact = body as Record<string, unknown>;
  if (!exactObjectKeys(artifact, [
    'format_version', 'highlights', 'model_version', 'prompt_version', 'source', 'summary',
  ])) repositoryIndexContractError('ML repository-index card_summary violated the versioned artifact contract.');

  const summary = artifact.summary;
  const highlights = artifact.highlights;
  const allowedFallbackSource = artifact.source === 'description_fallback'
    ? repository.description
    : null;
  if (typeof summary !== 'string' || summary !== summary.trim()
    // Python len(str) and PostgreSQL char_length count Unicode codepoints.
    || [...summary].length < 1 || [...summary].length > 360
    || !hasTwoOrThreeCompleteSentences(summary)
    || hasForbiddenCardContent(summary)
    || containsCopiedPassage(summary, repository.readme, allowedFallbackSource)
    || !Array.isArray(highlights) || highlights.length > 3
    || !highlights.every((item) => typeof item === 'string'
      && item === item.trim() && [...item].length >= 1 && [...item].length <= 96
      && !hasForbiddenCardContent(item)
      && !containsCopiedPassage(item, repository.readme, allowedFallbackSource))
    || !boundedVersion(artifact.prompt_version)
    || !boundedVersion(artifact.model_version, 256)
    || !boundedVersion(artifact.format_version)
    || (artifact.source !== 'generated' && artifact.source !== 'description_fallback')
    || (artifact.source === 'description_fallback'
      && artifact.model_version !== ML_DESCRIPTION_FALLBACK_MODEL_VERSION)
    || (artifact.source === 'generated'
      && artifact.model_version === ML_DESCRIPTION_FALLBACK_MODEL_VERSION)) {
    repositoryIndexContractError('ML repository-index card_summary contains invalid bounded content or provenance.');
  }
}

/** Bound decoded transport bytes before UTF-8 decoding or JSON parsing. */
async function readBoundedResponse(response: Response, maximum: number, fatal = false): Promise<{ text: string; oversized: boolean }> {
  if (!response.body) return { text: '', oversized: false };
  const reader = response.body.getReader();
  let buffer = Buffer.alloc(0);
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        return { text: new TextDecoder('utf-8', { fatal }).decode(buffer.subarray(0, size)), oversized: false };
      }
      const retained = Math.min(value.byteLength, maximum - size);
      const required = size + retained;
      if (required > buffer.length) {
        // Grow with actual work, without retaining one allocation per network
        // chunk or a large backing buffer from an oversized chunk.
        const grown = Buffer.allocUnsafe(Math.min(maximum, Math.max(required, buffer.length * 2, 16_384)));
        buffer.copy(grown, 0, 0, size);
        buffer = grown;
      }
      buffer.set(value.subarray(0, retained), size);
      size = required;
      if (retained < value.byteLength) {
        // Diagnostics need only a small prefix. Streaming decode omits a final
        // split UTF-8 sequence rather than inserting a replacement character.
        return { text: new TextDecoder().decode(buffer.subarray(0, Math.min(size, 4_000)), { stream: true }), oversized: true };
      }
    }
  } finally {
    // Cancellation is initiated synchronously; do not wait for a remote peer's
    // cancellation acknowledgement or convert overflow into deadline abort.
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class MlV2Client implements RecommendationPort, OutboxTransportPort {
  private consecutiveGenerateFailures = 0;
  private circuitState: RecommendationCircuitState = 'closed';
  private circuitEpoch = 0;
  private circuitOpenedAt = 0;
  private probeInFlight = false;
  private readonly circuitFailureThreshold: number;
  private readonly circuitOpenMs: number;
  private readonly now: () => number;

  constructor(
    private readonly config: MlRuntimeConfig = getMlRuntimeConfig(),
    circuit: RecommendationCircuitOptions = {},
  ) {
    this.circuitFailureThreshold = positiveInt(circuit.failureThreshold ?? process.env.ML_CIRCUIT_FAILURE_THRESHOLD, 5);
    this.circuitOpenMs = positiveInt(circuit.openMs ?? process.env.ML_CIRCUIT_OPEN_MS, 30_000);
    this.now = circuit.now ?? (() => performance.now());
  }

  private transitionCircuit(state: RecommendationCircuitState, reason: string): void {
    const previous = this.circuitState;
    this.circuitState = state;
    this.circuitEpoch++;
    if (state === 'open') this.circuitOpenedAt = this.now();
    incrementMetric('ml_recommendation_circuit_transition_total', { from: previous, to: state, reason });
  }

  private async request<Path extends MlPostPath>(
    path: Path,
    payload: MlRequest<NoInfer<Path>>,
    idempotencyKey: string,
    timeoutMs = this.config.timeoutMs,
    responseFormat: 'required-json' | 'optional-json' = 'required-json',
    scoringCaptureCapability?: string,
  ): Promise<{ status: number; body: unknown; retryAfterMs?: number }> {
    const span = startSpan(mlOperation(path), 'ml_transport');
    let outcome: StageOutcome = 'failure';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.config.baseUrl}${path}`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-internal-secret': this.config.internalSecret,
          ...(scoringCaptureCapability ? { 'x-scoring-capture-capability': scoringCaptureCapability } : {}),
          'x-request-id': crypto.randomUUID(),
          traceparent: span.traceparent,
          'idempotency-key': idempotencyKey,
          // Relative duration only: ML creates its own monotonic deadline and
          // old deployments safely ignore the optional read-only header.
          ...(path === '/api/v2/recommendations/generate' ? {
            'x-request-timeout-ms': String(Math.max(1, Math.floor(timeoutMs - Math.min(1_000, timeoutMs / 10)))),
          } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      let text: string, oversized: boolean;
      try {
        ({ text, oversized } = await readBoundedResponse(response,
          scoringCaptureCapability ? Math.min(this.config.maxResponseBytes, 1_000_000) : this.config.maxResponseBytes,
          Boolean(scoringCaptureCapability)));
      } catch (error) {
        if (controller.signal.aborted) throw error;
        if (scoringCaptureCapability) throw new MlRecommendationError('ML captured response decoding failed.', response.status, 'contract');
        throw error;
      }
      if (oversized && response.ok) {
        if (responseFormat === 'required-json') {
          if (path === '/api/v2/recommendations/generate') {
            throw new MlRecommendationError('ML response exceeded size limit.', response.status, 'contract');
          }
          repositoryIndexContractError('ML successful response exceeded size limit.');
        }
        throw new Error('ML response exceeded size limit.');
      }
      let body: unknown = oversized ? text.slice(0, 4_000) : null;
      if (text && !oversized) {
        try { body = JSON.parse(text); if (scoringCaptureCapability) rejectDuplicateJsonKeys(text); }
        catch {
          if (responseFormat === 'required-json' && response.ok) {
            if (path === '/api/v2/recommendations/generate') throw new MlRecommendationError('ML returned invalid JSON.', response.status, 'contract');
            repositoryIndexContractError('ML returned invalid JSON.');
          }
          body = text;
        }
      }
      const retryAfter = response.headers.get('retry-after');
      let retryAfterMs: number | undefined;
      if (retryAfter) {
        const seconds = Number(retryAfter);
        const parsed = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(parsed) && parsed > 0) retryAfterMs = Math.min(15 * 60_000, Math.round(parsed));
      }
      outcome = httpOutcome(response.status);
      return { status: response.status, body, retryAfterMs };
    } catch (error) {
      if (controller.signal.aborted) throw new MlTransportTimeoutError('ML transport deadline exceeded.', scoringCaptureCapability ? undefined : { cause: error });
      if (scoringCaptureCapability && !(error instanceof MlRecommendationError)) throw new Error('ML captured transport failed.');
      throw error;
    } finally {
      clearTimeout(timer);
      span.finish(controller.signal.aborted ? 'timeout' : outcome);
    }
  }

  async generate(input: MlRecommendationRequest, work?: { deadline: number; scoringCaptureCapability?: string }): Promise<MlRecommendationResponse> {
    if (input.scoring_capture && (input.scoring_capture.schema_version !== 1
      || input.scoring_capture.encoding !== 'float32-le-v1'
      || !/^[1-9][0-9]{0,18}$/.test(String(input.feed_version)) || typeof input.feed_version !== 'string'
      || BigInt(input.feed_version) > 9223372036854775807n
      || !work?.scoringCaptureCapability || work.scoringCaptureCapability.length !== 64
      || !/^[0-9a-f]{64}$/.test(work.scoringCaptureCapability))) {
      throw new MlRecommendationError('ML captured request configuration is invalid.', 0, 'contract');
    }
    const remaining = work ? Math.floor(work.deadline - performance.now()) : Infinity;
    if (remaining <= 0 || (work && !Number.isFinite(work.deadline))) {
      throw new MlTransportTimeoutError('ML generation budget exhausted before transport.');
    }
    if (this.circuitState === 'open' && this.now() - this.circuitOpenedAt >= this.circuitOpenMs) {
      this.transitionCircuit('half-open', 'cooldown');
    }
    // Admission is synchronous, before the first await. Recovery has exactly one slot.
    if (this.circuitState === 'open' || (this.circuitState === 'half-open' && this.probeInFlight)) {
      incrementMetric('ml_recommendation_generate_total', { outcome: this.circuitState });
      throw new Error('ML recommendation circuit is open.');
    }
    const probe = this.circuitState === 'half-open';
    if (probe) this.probeInFlight = true;
    const epoch = this.circuitEpoch;
    const started = this.now();
    const localBudgetLimited = remaining < (this.config.generationTimeoutMs ?? this.config.timeoutMs);
    let outcome = 'success';
    try {
      const { status, body, retryAfterMs } = await this.request(
        '/api/v2/recommendations/generate',
        input,
        input.generation_id,
        Math.min(this.config.generationTimeoutMs ?? this.config.timeoutMs, remaining),
        'required-json', input.scoring_capture ? work?.scoringCaptureCapability : undefined,
      );
      if (status < 200 || status >= 300) {
        const detail = input.scoring_capture ? undefined : responseDetail(body);
        throw new MlRecommendationError(
          detail
            ? `ML recommendation request failed with status ${status}: ${detail}`
            : `ML recommendation request failed with status ${status}.`,
          status,
          recommendationFailureKind(status, body),
          detail,
          retryAfterMs,
        );
      }
      const value = body as MlRecommendationResponse;
      if (!value || value.schema_version !== 2 || value.generation_id !== input.generation_id
        || value.user_id !== input.user_id || value.feed_version !== input.feed_version
        || typeof value.model_version !== 'string' || typeof value.embedding_version !== 'string'
        || !Array.isArray(value.items)) {
        throw new MlRecommendationError('ML recommendation response violated the v2 envelope.', 200, 'contract');
      }
      const context = value.context_status;
      const nullableText = (field: unknown) => field === null || typeof field === 'string';
      if (!boundedVersion(value.model_version, 512) || !boundedVersion(value.embedding_version, 1048)
        || !Array.isArray(value.embedding_versions) || !value.embedding_versions.every(version => typeof version === 'string')
        || !['heavy', 'hybrid'].includes(value.served_ranker)
        || typeof value.heavy_ranker_selected !== 'boolean' || typeof value.ranker_applied !== 'boolean'
        || !nullableText(value.fallback_code) || !nullableText(value.fallback_reason)
        || typeof value.retrieval_mode !== 'string'
        || !context || typeof context !== 'object' || Array.isArray(context)
        || typeof context.cold_start_applied !== 'boolean'
        || !['reserved_unused', 'not_provided'].includes(context.locale)
        || value.items.length > 150) {
        throw new MlRecommendationError('ML recommendation response violated the v2 provenance contract.', 200, 'contract');
      }
      const ids = new Set<string>();
      for (const item of value.items) {
        if (!item || !isValidUuid(item.repo_id) || ids.has(item.repo_id) || !Number.isFinite(item.score)
          || typeof item.source !== 'string' || item.source.length === 0) {
          throw new MlRecommendationError('ML recommendation response contains an invalid or duplicate item.', 200, 'contract');
        }
        if (item.retrieval_scores !== undefined) {
          const scores = item.retrieval_scores;
          if (!scores || typeof scores !== 'object' || Array.isArray(scores)
            || Object.keys(scores).length > 16
            || !Object.entries(scores).every(([key, score]) => /^[a-z_]{1,32}$/.test(key)
              && typeof score === 'number' && Number.isFinite(score))) {
            throw new MlRecommendationError('ML recommendation response contains invalid source scores.', 200, 'contract');
          }
        }
        ids.add(item.repo_id);
      }
      try { validateCapturedRecommendation(value, input); }
      catch { throw new MlRecommendationError('ML captured recommendation contract is invalid.', 200, 'contract'); }
      // A call admitted before a newer opening must not reset that circuit.
      if (epoch === this.circuitEpoch) {
        this.consecutiveGenerateFailures = 0;
        if (probe) this.transitionCircuit('closed', 'success');
      }
      return value;
    } catch (error) {
      if (localBudgetLimited && error instanceof MlTransportTimeoutError) {
        outcome = 'job_deadline';
        // A locally shortened observer says nothing about provider health.
        // Half-open admission is released in finally without changing state.
        throw error;
      }
      outcome = error instanceof MlRecommendationError ? (error.kind === 'service_unavailable' ? 'dependency' : 'contract') : 'dependency';
      if (epoch === this.circuitEpoch) {
        if (outcome === 'dependency') this.consecutiveGenerateFailures++;
        if (probe || this.consecutiveGenerateFailures >= this.circuitFailureThreshold) {
          this.transitionCircuit('open', outcome);
        }
      }
      throw error;
    } finally {
      // Includes fetch/body aborts and validation failures; no failed probe can retain the slot.
      if (probe) {
        this.probeInFlight = false;
        incrementMetric('ml_recommendation_probe_total', { outcome });
      }
      incrementMetric('ml_recommendation_generate_total', { outcome });
      observeMetric('ml_recommendation_generate_duration_ms', Math.max(0, this.now() - started), { outcome });
    }
  }

  private async deliver<Path extends MlDeliveryPath>(path: Path, payload: MlRequest<NoInfer<Path>>, idempotencyKey: string,
    timeoutMs = this.config.deliveryTimeoutMs ?? this.config.timeoutMs): Promise<DeliveryResult> {
    try {
      const { status, body, retryAfterMs } = await this.request(
        path,
        payload,
        idempotencyKey,
        timeoutMs,
        'optional-json',
      );
      return {
        accepted: status >= 200 && status < 300,
        retryable: status === 408 || status === 425 || status === 429 || status >= 500,
        status_code: status,
        detail: typeof (body as { detail?: unknown } | null)?.detail === 'string'
          ? (body as { detail: string }).detail
          : typeof body === 'string' ? body.slice(0, 4_000) : undefined,
        ...(retryAfterMs ? { retry_after_ms: retryAfterMs } : {}),
        ...(status >= 200 && status < 300 ? { response_body: body } : {}),
      };
    } catch (error) {
      return { accepted: false, retryable: true, status_code: 0, detail: String(error),
        ...(error instanceof MlTransportTimeoutError ? { failure_kind: 'timeout' as const } : {}) };
    }
  }

  async deliverModelOperations(batch:MlModelOperationBatch):Promise<DeliveryResult<MlModelOperationResponse>> {
    const result=await this.deliver('/api/v2/model-operations',batch,'model-operations');
    if(!result.accepted)return {...result,detail:'Model operation delivery unavailable.',response_body:undefined};
    try{return {...result,response_body:parseModelAcknowledgement(result.response_body)};}
    catch{return {accepted:false,retryable:true,status_code:502,detail:'Invalid model operation acknowledgement.'};}
  }
  async deliverProfileWithdrawals(batch:MlProfileWithdrawalBatch):Promise<DeliveryResult<MlProfileWithdrawalResponse>> {
    const result=await this.deliver('/api/v2/model-operation-withdrawals',batch,'model-withdrawals');
    if(!result.accepted)return {...result,detail:'Model withdrawal delivery unavailable.',response_body:undefined};
    try{return {...result,response_body:parseWithdrawalAcknowledgement(result.response_body)};}
    catch{return {accepted:false,retryable:true,status_code:502,detail:'Invalid model withdrawal acknowledgement.'};}
  }
  async modelOperationStatus(input:MlModelOperationStatusRequest):Promise<MlModelOperationStatusResponse>{
    try{const result=await this.request('/api/v2/model-operation-status',input,input.operation_id);
      if(result.status!==200)throw new ModelOperationError();
      const status=parseModelOperationStatus(result.body);
      if(status.user_id!==input.user_id || status.operation_id!==input.operation_id || status.model_operation_version!==input.model_operation_version
        || status.source_envelope_sha256!==input.source_envelope_sha256)throw new ModelOperationError();
      return status;
    }catch{throw new ModelOperationError();}
  }
  async modelAuthority(input:MlModelAuthorityRequest):Promise<MlModelAuthorityResponse>{
    try{const result=await this.request('/api/v2/model-authority',input,input.user_id);
      if(result.status!==200)throw new ModelOperationError();
      const body=modelRecord(result.body);if(body.schema_version!==1||Object.keys(body).sort().join(',')!=='model_context,schema_version')throw new ModelOperationError();
      return {schema_version:1,model_context:parseAppliedModelContext(body.model_context)};
    }catch{throw new ModelOperationError();}
  }

  deliverFeedback(batch: MlFeedbackBatch): Promise<DeliveryResult> {
    const key = batch.events.map((event) => event.event_id).join(',');
    return this.deliver('/api/v2/feedback/batch', batch, key);
  }

  deliverOnboarding(job: MlOnboardingJob): Promise<DeliveryResult> {
    return this.deliver('/api/v2/users/onboard', { schema_version: 2, ...job }, job.job_id,
      this.config.onboardingTimeoutMs ?? this.config.deliveryTimeoutMs ?? this.config.timeoutMs);
  }

  async deliverRepositoryIndex(job: MlRepositoryIndexJob): Promise<DeliveryResult<MlRepositoryIndexResponse>> {
    try {
      const { status, body, retryAfterMs } = await this.request(
        '/api/v2/repositories/embed',
        { schema_version: 2, ...job },
        job.job_id,
        this.config.repositoryIndexTimeoutMs ?? 240_000,
        'required-json',
      );
      if (status < 200 || status >= 300) {
        return {
          accepted: false,
          retryable: status === 408 || status === 425 || status === 429 || status >= 500,
          status_code: status,
          detail: responseDetail(body),
          ...(retryAfterMs ? { retry_after_ms: retryAfterMs } : {}),
        };
      }
      const response = parseMlRepositoryIndexResponse(body, job);
      return {
        accepted: true,
        retryable: false,
        status_code: status,
        response_body: response,
      };
    } catch (error) {
      return {
        accepted: false,
        retryable: !(error instanceof MlRepositoryIndexContractError),
        status_code: 0,
        detail: String(error),
        ...(error instanceof MlTransportTimeoutError ? { failure_kind: 'timeout' as const } : {}),
      };
    }
  }

  deliverRepositoryRefresh(job: MlRepositoryRefreshJob): Promise<DeliveryResult> {
    return this.deliver('/api/v2/repositories/refresh', { schema_version: 2, ...job }, job.job_id,
      this.config.repositoryRefreshTimeoutMs ?? this.config.deliveryTimeoutMs ?? this.config.timeoutMs);
  }

  async health(): Promise<{ healthy: boolean; status: number; body: unknown }> {
    const span = startSpan('health', 'ml_transport');
    let outcome: StageOutcome = 'failure';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.baseUrl}/api/v2/health`, {
        redirect: 'error',
        headers: {
          'x-internal-secret': this.config.internalSecret,
          'x-request-id': crypto.randomUUID(),
          traceparent: span.traceparent,
        },
        signal: controller.signal,
      });
      const { text, oversized } = await readBoundedResponse(response, this.config.maxResponseBytes);
      if (oversized) throw new Error('ML response exceeded size limit.');
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      outcome = httpOutcome(response.status);
      return { healthy: response.ok, status: response.status, body };
    } finally {
      clearTimeout(timer);
      span.finish(controller.signal.aborted ? 'timeout' : outcome);
    }
  }
}
