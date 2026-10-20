import crypto from 'node:crypto';
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

function exactObjectKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function boundedVersion(value: unknown, maximum = 200): value is string {
  return typeof value === 'string' && value === value.trim()
    && value.length >= 1 && value.length <= maximum;
}

function hasTwoOrThreeCompleteSentences(value: string): boolean {
  // These inline abbreviations introduce examples/explanations, not sentences.
  const prose = value.replace(/\b(?:e\.g|i\.e)\./giu, (match) => match.replaceAll('.', ''))
    .replace(/\b(?:Mr|Mrs|Ms|Dr|Prof|Jr|Sr)\.(?=\s+\p{L})/gu, (match) => match.slice(0, -1));
  const endings = prose.match(/[.!?](?:["')\]]+)?(?=\s|$)/gu) ?? [];
  return (endings.length === 2 || endings.length === 3)
    && /[.!?](?:["')\]]+)?(?=\s|$)/u.test(value.slice(-4));
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
  return /(?:^|\n)\s*#{1,6}\s|```|~~~|`/.test(value)
    || /(?:^|\n)\s*(?:[-+*]|\d+[.)])\s+/u.test(value)
    || /!?\[[^\]\n]*\]\([^)\n]+\)/u.test(value)
    || /(?:^|[.!?]\s+|\n)[ \t]*(?:installation(?: instructions?)?|license(?: text)?|contribut(?:ing|ors?)(?: section)?|changelog|table of contents|API (?:reference|documentation))\s*[:\-]/i.test(value)
    || /\b(?:licensed under|MIT License|Apache License|GNU (?:General Public )?License|GPL)\b/i.test(value)
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

  if (!value.card_summary || typeof value.card_summary !== 'object'
    || Array.isArray(value.card_summary)) {
    repositoryIndexContractError('ML repository-index response is missing card_summary.');
  }
  const artifact = value.card_summary as Record<string, unknown>;
  if (!exactObjectKeys(artifact, [
    'format_version', 'highlights', 'model_version', 'prompt_version', 'source', 'summary',
  ])) repositoryIndexContractError('ML repository-index card_summary violated the versioned artifact contract.');

  const summary = artifact.summary;
  const highlights = artifact.highlights;
  const allowedFallbackSource = artifact.source === 'description_fallback'
    ? job.repository.description
    : null;
  if (typeof summary !== 'string' || summary !== summary.trim()
    || summary.length < 1 || summary.length > 360
    || !hasTwoOrThreeCompleteSentences(summary)
    || hasForbiddenCardContent(summary)
    || containsCopiedPassage(summary, job.repository.readme, allowedFallbackSource)
    || !Array.isArray(highlights) || highlights.length > 3
    || !highlights.every((item) => typeof item === 'string'
      && item === item.trim() && item.length >= 1 && item.length <= 96
      && !hasForbiddenCardContent(item)
      && !containsCopiedPassage(item, job.repository.readme, allowedFallbackSource))
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
  return body as MlRepositoryIndexResponse;
}

export class MlV2Client implements RecommendationPort, OutboxTransportPort {
  private consecutiveGenerateFailures = 0;
  private circuitOpenedAt = 0;
  private readonly circuitFailureThreshold = Number(process.env.ML_CIRCUIT_FAILURE_THRESHOLD ?? 5);
  private readonly circuitOpenMs = Number(process.env.ML_CIRCUIT_OPEN_MS ?? 30_000);

  constructor(private readonly config: MlRuntimeConfig = getMlRuntimeConfig()) {}

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
      const oversized = Buffer.byteLength(text) > this.config.maxResponseBytes;
      if (oversized && response.ok) {
        if (path === '/api/v2/repositories/embed' && response.ok) {
          throw new MlRepositoryIndexContractError('ML response exceeded size limit.');
        }
        throw new Error('ML response exceeded size limit.');
      }
      let body: unknown = oversized ? text.slice(0, 4_000) : null;
      if (text && !oversized) {
        try { body = JSON.parse(text); }
        catch {
          if (responseFormat === 'required-json' && response.ok) {
            if (path === '/api/v2/repositories/embed' && response.ok) {
              throw new MlRepositoryIndexContractError('ML returned invalid JSON.');
            }
            throw new Error('ML returned invalid JSON.');
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
    if (this.circuitOpenedAt && Date.now() - this.circuitOpenedAt < this.circuitOpenMs) {
      throw new Error('ML recommendation circuit is open.');
    }
    try {
      const { status, body } = await this.request('/api/v2/recommendations/generate', input, input.generation_id);
      if (status < 200 || status >= 300) throw new Error(`ML recommendation request failed with status ${status}.`);
      const value = body as MlRecommendationResponse;
      if (!value || value.schema_version !== 2 || value.generation_id !== input.generation_id
        || value.user_id !== input.user_id || value.feed_version !== input.feed_version
        || typeof value.model_version !== 'string' || typeof value.embedding_version !== 'string'
        || !Array.isArray(value.items)) {
        throw new Error('ML recommendation response violated the v2 envelope.');
      }
      if (value.items.length === 0) {
        throw new Error('ML recommendation response contained no items.');
      }
      const ids = new Set<string>();
      for (const item of value.items) {
        if (!isValidUuid(item.repo_id) || ids.has(item.repo_id) || !Number.isFinite(item.score)
          || typeof item.source !== 'string' || item.source.length === 0) {
          throw new Error('ML recommendation response contains an invalid or duplicate item.');
        }
        ids.add(item.repo_id);
      }
      this.consecutiveGenerateFailures = 0;
      this.circuitOpenedAt = 0;
      return value;
    } catch (error) {
      this.consecutiveGenerateFailures++;
      if (this.consecutiveGenerateFailures >= this.circuitFailureThreshold) this.circuitOpenedAt = Date.now();
      throw error;
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
