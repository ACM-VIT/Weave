import type { DeliveryResult, MlFeedbackBatch } from '../contracts/ml.v2.js';
import type { OutboxTransportPort } from '../ports/outboxTransportPort.js';
import type { AdaptiveWorkerReport } from '../runtime/workerSupervisor.js';
import type { OutboxLane } from '../runtime/outboxLanes.js';
import { OutboxService, type OutboxClaimOptions, type OutboxRow } from '../services/outboxService.js';
import { acknowledgedFeedbackIds } from '../services/mlFeedbackAcknowledgement.js';
import { incrementMetric, observeMetric, observeStage } from '../observability/metrics.js';
import { startSpan, httpOutcome } from '../observability/tracing.js';
import type { StageOutcome } from '../observability/metrics.js';
import { OutboxWorker } from './outboxWorker.js';

export function feedbackBatchSize(value = process.env.OUTBOX_FEEDBACK_BATCH_SIZE): number {
  if (value === undefined || !value.trim()) return 20;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('OUTBOX_FEEDBACK_BATCH_SIZE must be an integer between 1 and 100.');
  }
  return parsed;
}

/** Four fixed RPC slots. Claims start only when that lane has immediate capacity. */
export class OutboxDeliveryLanes {
  private readonly active = new Set<OutboxLane>();
  private readonly cooldowns = new Map<OutboxRow['job_type'], number>();
  private repositoryKind: 'repo_index' | 'repo_refresh' = 'repo_index';
  private readonly worker: OutboxWorker;

  constructor(
    private readonly outbox: OutboxService,
    private readonly transport: OutboxTransportPort,
    private readonly batchSize = feedbackBatchSize(),
    private readonly now = Date.now,
    private readonly wakeFirstFeedback: () => void = () => {},
  ) {
    feedbackBatchSize(String(batchSize));
    this.worker = new OutboxWorker(outbox, transport);
  }

  private remaining(type: OutboxRow['job_type']): number {
    return Math.max(0, (this.cooldowns.get(type) ?? 0) - this.now());
  }

  private backpressure(type: OutboxRow['job_type'], result: DeliveryResult): void {
    if ((result.status_code === 429 || result.status_code === 503) && result.retry_after_ms) {
      this.cooldowns.set(type, Math.max(this.cooldowns.get(type) ?? 0, this.now() + result.retry_after_ms));
    }
  }

  private async feedback(rows: OutboxRow[]): Promise<boolean> {
    const events = rows.map(row => row.payload as unknown as MlFeedbackBatch['events'][number]);
    rows.forEach(row => observeStage('feedback', 'outbox_age', 'success', this.now() - Date.parse(row.created_at)));
    observeMetric('outbox_feedback_events_per_request', events.length);
    const span = startSpan('feedback', 'outbox_delivery', true);
    let outcome: StageOutcome = 'failure';
    const result = await span.run(async () => {
      try {
        const delivery = await this.transport.deliverFeedback({ schema_version: 2, events });
        outcome = delivery.accepted ? 'success' : delivery.failure_kind === 'timeout' ? 'timeout'
          : delivery.status_code >= 400 ? httpOutcome(delivery.status_code) : 'failure';
        return delivery;
      } finally { span.finish(outcome); }
    });
    this.backpressure('feedback', result);
    let ids = new Set<string>();
    let detail = result.detail ?? `Feedback delivery status ${result.status_code}.`;
    if (result.accepted) {
      try { ids = acknowledgedFeedbackIds(result.response_body, events); }
      catch (error) { detail = error instanceof Error ? error.message : 'Invalid feedback acknowledgement.'; }
    }
    let delivered = false;
    for (const row of rows) {
      if (ids.has(String(row.payload.event_id).toLowerCase())) {
        delivered = (await this.outbox.markDelivered(row)) || delivered;
      }
      else {
        // A multi-event failure can follow partial durable acceptance. Retry each
        // unknown member as a singleton; only an unambiguous singleton can be terminal.
        const retryable = rows.length > 1 || result.accepted || result.retryable;
        await this.outbox.markFailed(row, detail, retryable, result.retry_after_ms);
        incrementMetric('outbox_feedback_unacknowledged_total');
      }
    }
    return delivered;
  }

  async runOnce(lane: OutboxLane): Promise<AdaptiveWorkerReport> {
    if (this.active.has(lane)) return { processed: 0 };
    this.active.add(lane);
    try {
      let options: OutboxClaimOptions;
      let limit = 1;
      if (lane === 'feedback' || lane === 'feedback-retry') {
        const remaining = this.remaining('feedback');
        if (remaining) return { processed: 0, nextRunInMs: remaining };
        options = { jobTypes: ['feedback'], attempts: lane === 'feedback' ? 'first' : 'retry' };
        if (lane === 'feedback') limit = this.batchSize;
      } else if (lane === 'onboard') {
        const remaining = this.remaining('onboard');
        if (remaining) return { processed: 0, nextRunInMs: remaining };
        options = { jobTypes: ['onboard'] };
      } else {
        options = { jobTypes: [this.repositoryKind] };
        this.repositoryKind = this.repositoryKind === 'repo_index' ? 'repo_refresh' : 'repo_index';
      }
      let rows: OutboxRow[] = [];
      if (!this.remaining(options.jobTypes![0]!)) rows = await this.outbox.claim(limit, undefined, options);
      if (!rows.length && lane === 'repository') {
        options = { jobTypes: [this.repositoryKind] };
        if (!this.remaining(this.repositoryKind)) rows = await this.outbox.claim(1, undefined, options);
      }
      if (!rows.length) {
        if (lane === 'repository') options = { jobTypes: ['repo_index', 'repo_refresh'] };
        const hint = await this.outbox.nextRunInMs(options);
        const delays = [hint, ...options.jobTypes!.map(type => this.remaining(type))]
          .filter((value): value is number => value !== undefined && value > 0);
        return { processed: 0, nextRunInMs: delays.length ? Math.min(...delays) : undefined };
      }
      if (lane === 'feedback' || lane === 'feedback-retry') {
        const delivered = await this.feedback(rows);
        if (lane === 'feedback-retry' && delivered) this.wakeFirstFeedback();
      }
      else this.backpressure(rows[0]!.job_type, await this.worker.deliverClaimed(rows[0]!));
      return { processed: rows.length };
    } finally { this.active.delete(lane); }
  }
}
