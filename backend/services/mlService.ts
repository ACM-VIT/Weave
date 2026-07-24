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
  MlRepositoryRefreshJob,
} from '../contracts/ml.v2.js';
import { getMlRuntimeConfig, type MlRuntimeConfig } from '../config/ml.js';
import { isValidUuid } from '../utils/validators.js';

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
      if (Buffer.byteLength(text) > this.config.maxResponseBytes) throw new Error('ML response exceeded size limit.');
      let body: unknown = null;
      if (text) {
        try { body = JSON.parse(text); }
        catch {
          if (responseFormat === 'required-json') throw new Error('ML returned invalid JSON.');
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
