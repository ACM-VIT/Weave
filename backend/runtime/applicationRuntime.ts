import redisClient from '../config/redis.js';
import { getV2FeatureFlags, validateFeatureDependencies } from '../config/features.js';
import { sqlClient } from '../db/index.js';
import { PostgresFeedPersistence } from '../adapters/postgresFeedPersistence.js';
import { RedisFeedQueue } from '../redis/feedQueue.js';
import { MlV2Client } from '../services/mlService.js';
import { FeedGenerationService } from '../services/feedGenerationService.js';
import { FeedV2Service } from '../services/feedV2Service.js';
import { OutboxService } from '../services/outboxService.js';
import { OutboxWorker } from '../workers/outboxWorker.js';
import { FeedReconciliationWorker } from '../workers/feedReconciliationWorker.js';
import { DataReconciliationWorker } from '../workers/dataReconciliationWorker.js';
import { RetentionWorker } from '../workers/retentionWorker.js';
import { WorkerSupervisor } from './workerSupervisor.js';
import { FeedShadowService } from '../services/feedShadowService.js';
import { validateProductionIntegrations } from '../config/runtimeConfig.js';
import { applyMlReadinessGate } from './mlReadiness.js';
import { applyOutboxReadinessGate } from './outboxReadiness.js';

function intervalFromEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

export class ApplicationRuntime {
  readonly flags = getV2FeatureFlags();
  readonly featureErrors = validateFeatureDependencies(this.flags);
  readonly persistence = new PostgresFeedPersistence();
  readonly queue = new RedisFeedQueue(
    redisClient,
    intervalFromEnvironment('FEED_RESERVATION_TTL_MS', 60_000, 30_000, 900_000),
  );
  readonly ml = this.flags.ML_V2_RECOMMENDATIONS || this.flags.ML_FEEDBACK_OUTBOX
    ? new MlV2Client()
    : null;
  readonly generation = this.ml && this.flags.ML_V2_RECOMMENDATIONS
    ? new FeedGenerationService(this.persistence, this.queue, this.ml)
    : null;
  readonly shadow = this.ml ? new FeedShadowService(this.persistence, this.ml) : null;
  readonly outbox = new OutboxService();
  readonly feed = new FeedV2Service(
    this.persistence,
    this.queue,
    this.generation
      ? (userId, limit, excluded, sessionId) => this.generation!.generate(userId, Math.max(45, limit), excluded, 'live', sessionId)
      : undefined,
    this.flags.TRENDING_FALLBACK,
    1_500,
    25,
    process.env.JWT_SECRET,
  );
  readonly supervisor = new WorkerSupervisor();

  constructor(readonly role: 'api' | 'outbox' | 'feed' | 'maintenance' | 'all' = 'api') {
    if ((role === 'outbox' || role === 'all') && this.flags.ML_FEEDBACK_OUTBOX && this.ml) {
      const worker = new OutboxWorker(
        this.outbox,
        this.ml,
        this.generation ? async (row) => {
          if (row.job_type === 'onboard') await this.generation!.generate(row.aggregate_id, 45, [], 'prewarm');
        } : undefined,
      );
      const activeInterval = intervalFromEnvironment('OUTBOX_ACTIVE_INTERVAL_MS', 1_000, 100, 60_000);
      const idleInterval = intervalFromEnvironment('OUTBOX_IDLE_INTERVAL_MS', 30_000, 1_000, 300_000);
      this.supervisor.registerAdaptive('ml-outbox', activeInterval, idleInterval, () => worker.runOnce());
    }
    if ((role === 'feed' || role === 'all') && this.flags.FEED_RESERVATIONS) {
      const interval = intervalFromEnvironment(
        'FEED_RECONCILIATION_INTERVAL_MS', 15_000, 1_000, 300_000,
      );
      const reconcileWithin = intervalFromEnvironment(
        'FEED_RECONCILE_WITHIN_MS', 15_000, 1_000, 300_000,
      );
      const reservationTtl = intervalFromEnvironment(
        'FEED_RESERVATION_TTL_MS', 60_000, 30_000, 900_000,
      );
      if (interval > reconcileWithin || reconcileWithin >= reservationTtl) {
        throw new Error(
          'Feed reconciliation requires interval <= reconcile window < reservation TTL.',
        );
      }
      const worker = new FeedReconciliationWorker(this.persistence, this.queue, reconcileWithin);
      this.supervisor.register('feed-reconciliation', interval, () => worker.runOnce());
    }
    if ((role === 'maintenance' || role === 'all') && this.flags.DB_SCHEMA_V2_WRITES) {
      const data = new DataReconciliationWorker();
      const retention = new RetentionWorker();
      this.supervisor.register('data-reconciliation', 300_000, () => data.runOnce());
      this.supervisor.register('retention', 86_400_000, () => retention.runOnce());
    }
  }

  start(): void {
    validateProductionIntegrations();
    if (this.featureErrors.length > 0) {
      throw new Error(`Invalid v2 feature configuration: ${this.featureErrors.join(' ')}`);
    }
    this.supervisor.start();
  }

  async health(): Promise<Record<string, unknown>> {
    const checks: Record<string, unknown> = {};
    try {
      await sqlClient`SELECT 1`;
      checks.postgres = { healthy: true };
    } catch (error) {
      checks.postgres = { healthy: false, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      checks.redis = { healthy: await redisClient.ping() === 'PONG' };
    } catch (error) {
      checks.redis = { healthy: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (this.ml) {
      try { checks.ml = applyMlReadinessGate(await this.ml.health(), this.flags); }
      catch (error) { checks.ml = { healthy: false, error: error instanceof Error ? error.message : String(error) }; }
    } else {
      checks.ml = { healthy: true, disabled: true };
    }
    try {
      const status = await this.outbox.status();
      checks.outbox = applyOutboxReadinessGate(status);
    } catch (error) {
      checks.outbox = { healthy: false, error: error instanceof Error ? error.message : String(error) };
    }
    return {
      healthy: this.featureErrors.length === 0
        && Object.values(checks).every((value) => (value as { healthy?: boolean }).healthy !== false),
      feature_errors: this.featureErrors,
      features: this.flags,
      checks,
      workers: this.supervisor.snapshot(),
      process_role: this.role,
    };
  }
}

let runtime: ApplicationRuntime | undefined;

export function getApplicationRuntime(): ApplicationRuntime {
  runtime ??= new ApplicationRuntime();
  return runtime;
}
