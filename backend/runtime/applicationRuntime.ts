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
import { PersonaRepairService } from '../services/personaRepairService.js';
import { PostgresRepositoryPersistence } from '../adapters/postgresRepositoryPersistence.js';
import { TrendingIngestionWorker } from '../workers/trendingIngestionWorker.js';

function positiveInterval(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : fallback;
}

export class ApplicationRuntime {
  readonly flags = getV2FeatureFlags();
  readonly featureErrors = validateFeatureDependencies(this.flags);
  readonly persistence = new PostgresFeedPersistence();
  readonly queue = new RedisFeedQueue(redisClient);
  readonly ml = this.flags.ML_V2_RECOMMENDATIONS || this.flags.ML_FEEDBACK_OUTBOX
    ? new MlV2Client()
    : null;
  readonly generation = this.ml && this.flags.ML_V2_RECOMMENDATIONS
    ? new FeedGenerationService(
      this.persistence,
      this.queue,
      this.ml,
      600,
      15_000,
      new PersonaRepairService(this.persistence, this.ml),
    )
    : null;
  readonly shadow = this.ml ? new FeedShadowService(this.persistence, this.ml) : null;
  readonly outbox = new OutboxService();
  readonly feed = new FeedV2Service(
    this.persistence,
    this.queue,
    this.generation
      ? (userId, limit, excluded) => this.generation!.generate(userId, Math.max(45, limit), excluded)
      : undefined,
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
      this.supervisor.register('ml-outbox', 1_000, () => worker.runOnce());
    }
    if ((role === 'feed' || role === 'all') && this.flags.FEED_RESERVATIONS) {
      const worker = new FeedReconciliationWorker(this.persistence, this.queue);
      this.supervisor.register('feed-reconciliation', 15_000, () => worker.runOnce());
    }
    if ((role === 'maintenance' || role === 'all') && this.flags.DB_SCHEMA_V2_WRITES) {
      const data = new DataReconciliationWorker();
      const retention = new RetentionWorker();
      this.supervisor.register('data-reconciliation', 300_000, () => data.runOnce());
      this.supervisor.register('retention', 86_400_000, () => retention.runOnce());
      if (this.flags.TRENDING_INGESTION) {
        const trending = new TrendingIngestionWorker(new PostgresRepositoryPersistence());
        this.supervisor.register(
          'github-trending-ingestion',
          positiveInterval(process.env.TRENDING_INGESTION_INTERVAL_MS, 21_600_000),
          () => trending.runOnce(),
        );
      }
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
