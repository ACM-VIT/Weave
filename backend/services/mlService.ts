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
  MlRepositoryRefreshJob,
} from '../contracts/ml.v2.js';
import { getMlRuntimeConfig, type MlRuntimeConfig } from '../config/ml.js';
import { isValidUuid } from '../utils/validators.js';
import { incrementMetric, observeMetric } from '../observability/metrics.js';

type RecommendationFailureKind = 'dependency' | 'contract';
type RecommendationCircuitState = 'closed' | 'open' | 'half-open';

export class MlRecommendationError extends Error {
  constructor(message: string, readonly kind: RecommendationFailureKind, readonly statusCode?: number) {
    super(message);
    this.name = 'MlRecommendationError';
  }
}

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
        throw new MlRecommendationError('ML response exceeded size limit.',
          isDependencyStatus(response.status) ? 'dependency' : 'contract', response.status);
      }
      let body: unknown = null;
      if (text) {
        try { body = JSON.parse(text); }
        catch {
          // Error bodies need not be JSON: preserve their HTTP failure classification.
          if (responseFormat === 'required-json' && response.ok) {
            throw new MlRecommendationError('ML returned invalid JSON.', 'contract', response.status);
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
      const { status, body } = await this.request('/api/v2/recommendations/generate', input, input.generation_id);
      if (status < 200 || status >= 300) {
        throw new MlRecommendationError(`ML recommendation request failed with status ${status}.`,
          isDependencyStatus(status) ? 'dependency' : 'contract', status);
      }
      const value = body as MlRecommendationResponse;
      if (!value || value.schema_version !== 2 || value.generation_id !== input.generation_id
        || value.user_id !== input.user_id || value.feed_version !== input.feed_version
        || typeof value.model_version !== 'string' || typeof value.embedding_version !== 'string'
        || !Array.isArray(value.items)) {
        throw new MlRecommendationError('ML recommendation response violated the v2 envelope.', 'contract');
      }
      const ids = new Set<string>();
      for (const item of value.items) {
        if (!item || !isValidUuid(item.repo_id) || ids.has(item.repo_id) || !Number.isFinite(item.score)
          || typeof item.source !== 'string' || item.source.length === 0) {
          throw new MlRecommendationError('ML recommendation response contains an invalid or duplicate item.', 'contract');
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
      outcome = error instanceof MlRecommendationError ? error.kind : 'dependency';
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

  deliverRepositoryIndex(job: MlRepositoryIndexJob): Promise<DeliveryResult> {
    return this.deliver('/api/v2/repositories/embed', { schema_version: 2, ...job }, job.job_id);
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
