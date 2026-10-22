import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RecommendationPort } from '../ports/recommendationPort.js';
import type { OutboxTransportPort } from '../ports/outboxTransportPort.js';
import type {
  DeliveryResult,
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

  private async request(
    path: string,
    payload: unknown,
    idempotencyKey: string,
    timeoutMs = this.config.timeoutMs,
    responseFormat: 'required-json' | 'optional-json' = 'required-json',
  ): Promise<{ status: number; body: unknown; retryAfterMs?: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.config.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-secret': this.config.internalSecret,
          'x-request-id': crypto.randomUUID(),
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await response.text();
      if (Buffer.byteLength(text) > this.config.maxResponseBytes) {
        if (response.ok && responseFormat === 'required-json') {
          repositoryIndexContractError('ML successful response exceeded size limit.');
        }
        throw new Error('ML response exceeded size limit.');
      }
      let body: unknown = null;
      if (text) {
        try { body = JSON.parse(text); }
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
      return { status: response.status, body, retryAfterMs };
    } finally {
      clearTimeout(timer);
    }
  }

  async generate(input: MlRecommendationRequest): Promise<MlRecommendationResponse> {
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
    let outcome = 'success';
    try {
      const { status, body, retryAfterMs } = await this.request(
        '/api/v2/recommendations/generate',
        input,
        input.generation_id,
      );
      if (status < 200 || status >= 300) {
        const detail = responseDetail(body);
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
      const ids = new Set<string>();
      for (const item of value.items) {
        if (!item || !isValidUuid(item.repo_id) || ids.has(item.repo_id) || !Number.isFinite(item.score)
          || typeof item.source !== 'string' || item.source.length === 0) {
          throw new MlRecommendationError('ML recommendation response contains an invalid or duplicate item.', 200, 'contract');
        }
        ids.add(item.repo_id);
      }
      // A call admitted before a newer opening must not reset that circuit.
      if (epoch === this.circuitEpoch) {
        this.consecutiveGenerateFailures = 0;
        if (probe) this.transitionCircuit('closed', 'success');
      }
      return value;
    } catch (error) {
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

  private async deliver(path: string, payload: unknown, idempotencyKey: string): Promise<DeliveryResult> {
    try {
      const { status, body, retryAfterMs } = await this.request(
        path,
        payload,
        idempotencyKey,
        this.config.deliveryTimeoutMs ?? this.config.timeoutMs,
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
      return { accepted: false, retryable: true, status_code: 0, detail: String(error) };
    }
  }

  deliverFeedback(batch: MlFeedbackBatch): Promise<DeliveryResult> {
    const key = batch.events.map((event) => event.event_id).join(',');
    return this.deliver('/api/v2/feedback/batch', batch, key);
  }

  deliverOnboarding(job: MlOnboardingJob): Promise<DeliveryResult> {
    return this.deliver('/api/v2/users/onboard', { schema_version: 2, ...job }, job.job_id);
  }

  async deliverRepositoryIndex(job: MlRepositoryIndexJob): Promise<DeliveryResult> {
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
      };
    }
  }

  deliverRepositoryRefresh(job: MlRepositoryRefreshJob): Promise<DeliveryResult> {
    return this.deliver('/api/v2/repositories/refresh', { schema_version: 2, ...job }, job.job_id);
  }

  async health(): Promise<{ healthy: boolean; status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.baseUrl}/api/v2/health`, {
        headers: {
          'x-internal-secret': this.config.internalSecret,
          'x-request-id': crypto.randomUUID(),
        },
        signal: controller.signal,
      });
      const text = await response.text();
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      return { healthy: response.ok, status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  }
}
