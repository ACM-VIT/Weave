import type { RepoRow, UserProfile } from '../types/database.js';
import type { FeedbackInteraction } from '../config/feedback.js';
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

const DEFAULT_ML_TIMEOUT_MS = 30000;

export interface MlRecommendationBatches {
  batch_1?: unknown[];
  batch_2?: unknown[];
  batch_3?: unknown[];
  [key: string]: unknown;
}

export interface MlOnboardPayload {
  user_id: string;
  github_username?: string | null;
  username?: string | null;
  full_name?: string | null;
  bio?: string | null;
  interests?: string[];
  skills?: string[];
  tech_stack?: string[];
  avatar_url?: string | null;
}

export interface MlEmbedRepositoryPayload {
  repo_id: string;
  github_repo: string;
  github_repo_url?: string | null;
  description?: string | null;
  primary_language?: string | null;
  languages?: string[];
  topics?: string[];
  readme_summary?: string | null;
  star_count?: number;
  fork_count?: number;
  created_at?: string | null;
  updated_at?: string | null;
}

function parseTimeout(): number {
  const raw = process.env.ML_TIMEOUT;
  if (!raw) return DEFAULT_ML_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[MLService] Invalid ML_TIMEOUT value "${raw}", using ${DEFAULT_ML_TIMEOUT_MS}ms.`);
    return DEFAULT_ML_TIMEOUT_MS;
  }

  return parsed;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

class MLService {
  private readonly baseURL: string | null;
  private readonly timeoutMs: number;
  private readonly internalSecret: string | null;

  constructor() {
    this.baseURL = process.env.ML_SERVICE_URL?.replace(/\/+$/, '') ?? null;
    this.timeoutMs = parseTimeout();
    this.internalSecret = process.env.INTERNAL_API_SECRET ?? null;
  }

  private async post<TResponse>(path: string, payload: unknown): Promise<TResponse> {
    if (!this.baseURL) {
      throw new Error('ML_SERVICE_URL is not configured.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseURL}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.internalSecret ? { 'x-internal-secret': this.internalSecret } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const responseText = await response.text();
      let responseBody: unknown = null;
      try {
        responseBody = responseText ? JSON.parse(responseText) : null;
      } catch {
        // Not a JSON body - fall through; the ok-check below will surface the status.
      }

      if (!response.ok) {
        const detail = (responseBody as Record<string, unknown>)?.detail ?? response.statusText;
        throw new Error(`status=${response.status} message=${detail}`);
      }

      return responseBody as TResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  async generateRecommendations(userId: string, isColdStart: boolean = false): Promise<MlRecommendationBatches> {
    try {
      const response = await this.post<{ data?: MlRecommendationBatches } & MlRecommendationBatches>('/api/v1/recommendations/generate', {
        user_id: userId,
        is_cold_start: isColdStart,
      });
      return response.data ?? response;
    } catch (error) {
      console.error(`[MLService] generateRecommendations failed for user ${userId}:`, error);
      throw error;
    }
  }

  async sendBatchedActivityFeedback(events: { user_id: string; repo_id: string; action: FeedbackInteraction; dwell_seconds?: number }[]): Promise<void> {
    try {
      await Promise.all(
        events.map((event) => this.post('/api/v1/feedback', event))
      );
    } catch (error) {
      console.error(`[MLService] sendBatchedActivityFeedback failed:`, error);
      // Best effort; do not crash on feedback failure
    }
  }

  async onboardUser(payload: MlOnboardPayload): Promise<void> {
    try {
      await this.post('/api/v1/onboard', payload);
    } catch (error) {
      console.error(`[MLService] onboardUser failed for user ${payload.user_id}:`, error);
      throw error;
    }
  }

  async onboardUserBestEffort(payload: MlOnboardPayload): Promise<void> {
    try {
      await this.onboardUser(payload);
    } catch {
      // Caller flows such as signup/onboarding should not fail because ML is unavailable.
    }
  }

  async embedRepository(payload: MlEmbedRepositoryPayload): Promise<void> {
    try {
      await this.post('/api/v1/embed-repo', payload);
    } catch (error) {
      console.error(`[MLService] embedRepository failed for repo ${payload.repo_id}:`, error);
      throw error;
    }
  }

  async embedRepositoryBestEffort(payload: MlEmbedRepositoryPayload): Promise<void> {
    try {
      await this.embedRepository(payload);
    } catch {
      // Repository import has already succeeded; indexing can be retried out of band.
    }
  }
}

export const mlService = new MLService();

export function buildMlOnboardPayload(userId: string, profile: Partial<UserProfile>): MlOnboardPayload {
  return {
    user_id: userId,
    github_username: profile.github_handle,
    username: profile.username,
    full_name: profile.full_name,
    bio: profile.bio,
    interests: normalizeStringArray(profile.interests),
    skills: normalizeStringArray(profile.skills),
    tech_stack: normalizeStringArray(profile.tech_stack),
    avatar_url: profile.avatar_url,
  };
}

export function buildMlEmbedRepositoryPayload(repo: RepoRow): MlEmbedRepositoryPayload {
  const languageUsed = repo.language_used;
  const languages = Array.isArray(languageUsed)
    ? normalizeStringArray(languageUsed)
    : languageUsed && typeof languageUsed === 'object'
      ? Object.keys(languageUsed)
      : [];

  return {
    repo_id: repo.repo_id,
    github_repo: repo.full_name,
    github_repo_url: repo.github_repo_url,
    description: repo.description,
    primary_language: languages[0] ?? null,
    languages,
    topics: normalizeStringArray(repo.topics),
    readme_summary: repo.readme_summary,
    star_count: repo.star_count ?? 0,
    fork_count: repo.forks_count ?? 0,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
  };
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
