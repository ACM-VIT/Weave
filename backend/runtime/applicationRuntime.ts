import { getScoringCaptureConfig } from '../config/scoringCapture.js';
import { createPrivateScoringPersistence } from '../adapters/postgresScoringPersistence.js';
import redisClient from '../config/redis.js';
import { getV2FeatureFlags, validateFeatureDependencies } from '../config/features.js';
import { sqlClient } from '../db/index.js';
import { PostgresFeedPersistence } from '../adapters/postgresFeedPersistence.js';
import { RedisFeedQueue } from '../redis/feedQueue.js';
import { MlV2Client } from '../services/mlService.js';
import { FeedGenerationService } from '../services/feedGenerationService.js';
import { FeedV2Service } from '../services/feedV2Service.js';
import { OutboxService, resolveOutboxLeaseMs } from '../services/outboxService.js';
import { OutboxDeliveryLanes, feedbackBatchSize } from '../workers/outboxDeliveryLanes.js';
import { OUTBOX_LANES, outboxTaskName } from './outboxLanes.js';
import { FeedReconciliationWorker } from '../workers/feedReconciliationWorker.js';
import { DataReconciliationWorker } from '../workers/dataReconciliationWorker.js';
import { DataReconciliationService, DEFAULT_COUNTER_BATCH_SIZE } from '../services/dataReconciliationService.js';
import { RetentionWorker } from '../workers/retentionWorker.js';
import { WorkerSupervisor } from './workerSupervisor.js';
import { WorkerWakeups } from './workerWakeups.js';
import { workerErrorSummary } from './workerError.js';
import { FeedPrewarmService } from '../services/feedPrewarmService.js';
import { FeedPrewarmWorker } from '../workers/feedPrewarmWorker.js';
import { feedGenerationBudget, mlTimeoutMs } from '../config/ml.js';
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

function indexedFeedRefillConfiguration() {
  // Default off: the operator must first upgrade EVERY reservation/generation
  // writer and drain pre-index reservations (or wait their maximum lease).
  // Mixed/legacy writers can omit the index, so never infer readiness from an
  // empty index or a healthy Redis connection.
  const ready = process.env.FEED_REFILL_INDEX_READY?.trim() ?? 'false';
  if (ready !== 'true' && ready !== 'false') {
    throw new Error('FEED_REFILL_INDEX_READY must be true or false.');
  }
  if (ready === 'false') return undefined;
  const maxQueueDepth = intervalFromEnvironment('FEED_REFILL_TARGET_DEPTH', 45, 2, 100);
  const lowWatermark = intervalFromEnvironment('FEED_REFILL_LOW_WATERMARK', 15, 1, 99);
  if (lowWatermark >= maxQueueDepth) {
    throw new Error('FEED_REFILL_LOW_WATERMARK must be below FEED_REFILL_TARGET_DEPTH.');
  }
  return { maxQueueDepth, lowWatermark };
}

function socialCandidatesConfiguration(): boolean {
  const enabled = process.env.FEED_SOCIAL_CANDIDATES_ENABLED?.trim() ?? 'false';
  if (enabled !== 'true' && enabled !== 'false') throw new Error('FEED_SOCIAL_CANDIDATES_ENABLED must be true or false.');
  return enabled === 'true';
}

export class ApplicationRuntime {
  readonly flags = getV2FeatureFlags();
  readonly featureErrors = validateFeatureDependencies(this.flags);
  readonly persistence = new PostgresFeedPersistence();
  readonly queue = new RedisFeedQueue(
    redisClient,
    intervalFromEnvironment('FEED_RESERVATION_TTL_MS', 60_000, 30_000, 900_000),
  );
  readonly scoringCapture = getScoringCaptureConfig();
  readonly privateScoring = this.flags.ML_V2_RECOMMENDATIONS ? createPrivateScoringPersistence(this.scoringCapture) : null;
  readonly indexedFeedRefill = indexedFeedRefillConfiguration();
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
      this.indexedFeedRefill,
      socialCandidatesConfiguration(),
      feedGenerationBudget(),
      this.scoringCapture.enabled && this.privateScoring
        ? {config:this.scoringCapture,persistence:this.privateScoring.port} : undefined,
    )
    : null;
  readonly shadow = this.ml ? new FeedShadowService(this.persistence, this.ml) : null;
  readonly outbox = new OutboxService();
  readonly prewarm = new FeedPrewarmService(sqlClient, this.generation ? feedGenerationBudget().timeoutMs + 60_000 : 60_000);
  readonly feed = new FeedV2Service(
    this.persistence,
    this.queue,
    this.generation
      ? (userId, limit, excluded, sessionId) => this.generation!.generate(userId, Math.max(45, limit), excluded, 'live', sessionId)
      : undefined,
    false,
    1_500,
    25,
    process.env.JWT_SECRET,
    this.generation ? mlTimeoutMs('FEED_FOREGROUND_WAIT_MS', 5_000) : 5_000,
    this.generation && this.indexedFeedRefill ? {
      lowWatermark: this.indexedFeedRefill.lowWatermark,
      generate: (userId, version, sessionId) => this.generation!.generate(
        userId, this.indexedFeedRefill!.maxQueueDepth, [], 'live', sessionId, undefined,
        { expectedVersion: version, lowWatermark: this.indexedFeedRefill!.lowWatermark },
      ),
    } : undefined,
    userId => this.scoringCapture.enabled && this.scoringCapture.userIds.has(userId),
  );
  readonly supervisor = new WorkerSupervisor();

  constructor(readonly role: 'api' | 'outbox' | 'feed' | 'maintenance' | 'all' = 'api') {
    if (this.scoringCapture.enabled && !this.flags.ML_V2_RECOMMENDATIONS) throw new Error('SCORING_CAPTURE_REQUIRES_ML_RECOMMENDATIONS');
    this.supervisor.onStop(() => this.feed.stop());
    if (this.privateScoring) this.supervisor.onStop(() => this.privateScoring!.close());
    if ((role === 'outbox' || role === 'all') && this.flags.ML_FEEDBACK_OUTBOX && this.ml) {
      resolveOutboxLeaseMs();
      const worker = new OutboxDeliveryLanes(
        this.outbox,
        this.ml,
        feedbackBatchSize(),
        Date.now,
        () => this.supervisor.wake(outboxTaskName('feedback')),
      );
      const activeInterval = intervalFromEnvironment('OUTBOX_ACTIVE_INTERVAL_MS', 1_000, 100, 60_000);
      const idleInterval = intervalFromEnvironment('OUTBOX_IDLE_INTERVAL_MS', 30_000, 1_000, 300_000);
      for (const lane of OUTBOX_LANES) {
        this.supervisor.registerAdaptive(outboxTaskName(lane), activeInterval, idleInterval, () => worker.runOnce(lane));
      }
      if (this.generation) {
        // Capacity is one generation per process; PostgreSQL leases coordinate
        // multiple workers and the durable queue coalesces by user/version.
        const prewarm = new FeedPrewarmWorker(this.prewarm, this.generation);
        this.supervisor.registerAdaptive('feed-prewarm', 1_000, idleInterval, () => prewarm.runOnce());
      }
      const wakeups = new WorkerWakeups(this.supervisor);
      this.supervisor.onStop(() => wakeups.stop());
      this.supervisor.registerAdaptive('outbox-notification-listener', 1_000, 30_000, async () => {
        await wakeups.start().catch(error => {
          console.error('[WorkerWakeups] Listener unavailable; fallback polling remains active:', workerErrorSummary(error));
        });
        return 0;
      });
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
      if (this.scoringCapture.enabled && this.privateScoring) {
        const owners = [...this.scoringCapture.userIds];
        this.supervisor.register('scoring-publication-reconciliation', interval,
          () => this.privateScoring!.port.reconcilePublicationWitnesses(owners, 100));
      }
    }
    if ((role === 'maintenance' || role === 'all') && this.flags.DB_SCHEMA_V2_WRITES) {
      const data = new DataReconciliationWorker(new DataReconciliationService(sqlClient,
        intervalFromEnvironment('COUNTER_RECONCILIATION_BATCH_SIZE', DEFAULT_COUNTER_BATCH_SIZE, 1, 1_000)));
      const retention = new RetentionWorker();
      this.supervisor.registerAdaptive('data-reconciliation', 1_000, 300_000, () => data.runOnce());
      // Faster counter batches must not turn abandoned-claim or superseded-job
      // cleanup into once-per-batch scans. Preserve their five-minute cadence.
      this.supervisor.register('abandoned-outbox-claims', 300_000, () => data.resetAbandonedClaims());
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
