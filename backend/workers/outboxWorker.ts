import { startSpan, httpOutcome } from '../observability/tracing.js';
import { observeStage, type StageOutcome } from '../observability/metrics.js';
import type {
  DeliveryResult,
  MlFeedbackBatch,
  MlOnboardingJob,
  MlRepositoryIndexJob,
  MlRepositoryRefreshJob,
} from '../contracts/ml.v2.js';
import type { OutboxTransportPort } from '../ports/outboxTransportPort.js';
import {
  OutboxService,
  RepositoryIndexCompletionConflictError,
  type OutboxRow,
} from '../services/outboxService.js';
import {
  MlRepositoryIndexContractError,
  parseMlRepositoryIndexResponse,
} from '../services/mlService.js';

export class OutboxWorker {
  constructor(
    private readonly outbox: OutboxService,
    private readonly transport: OutboxTransportPort,
  ) {}

  private deliver(row: OutboxRow) {
    if (row.job_type === 'feedback') {
      return this.transport.deliverFeedback({ schema_version: 2, events: [row.payload as unknown as MlFeedbackBatch['events'][number]] });
    }
    if (row.job_type === 'onboard') return this.transport.deliverOnboarding(row.payload as unknown as MlOnboardingJob);
    if (row.job_type === 'repo_index') return this.transport.deliverRepositoryIndex(row.payload as unknown as MlRepositoryIndexJob);
    // Internal outbox dependency metadata is not part of the strict ML DTO.
    const { job_id, repo_id, feature_version, features } = row.payload as unknown as MlRepositoryRefreshJob;
    return this.transport.deliverRepositoryRefresh({ job_id, repo_id, feature_version, features });
  }

  async runOnce(limit = 1): Promise<number> {
    let processed = 0;
    for (let index = 0; index < limit; index++) {
      // Claim immediately before delivery so rows never wait behind an older
      // sequential request while their database lease is already ticking.
      const [row] = await this.outbox.claim(1);
      if (!row) break;
      await this.deliverClaimed(row);
      processed++;
    }
    return processed;
  }

  /** A caller must already own immediate transport capacity for this claim. */
  async deliverClaimed(row: OutboxRow): Promise<DeliveryResult> {
    if (row.job_type === 'onboard' && !await this.outbox.prepareOnboardingDelivery(row)) {
      return { accepted: false, retryable: false, status_code: 0, detail: 'Onboarding context is no longer current.' };
    }
    // A retry gets a fresh root: no durable enqueue trace is stored today.
    const span = startSpan(row.job_type, 'outbox_delivery', true);
    observeStage(row.job_type, 'outbox_age', 'success', Date.now() - Date.parse(row.created_at));
    let outcome: StageOutcome = 'failure';
    const result = await span.run(async () => {
      try {
        const delivery = await this.deliver(row);
        outcome = delivery.accepted ? 'success' : delivery.failure_kind === 'timeout' ? 'timeout'
          : delivery.status_code >= 400 ? httpOutcome(delivery.status_code) : 'failure';
        return delivery;
      } finally { span.finish(outcome); }
    });
    if (result.accepted) {
      if (row.job_type === 'repo_index') {
        if (!result.response_body) {
          await this.outbox.markFailed(
            row,
            'ML accepted repository index without a versioned card-summary response.',
            true,
          );
        } else {
          try {
            const job = row.payload as unknown as MlRepositoryIndexJob;
            await this.outbox.completeRepositoryIndex(
              row,
              parseMlRepositoryIndexResponse(result.response_body, job),
            );
          } catch (error) {
            if (error instanceof MlRepositoryIndexContractError
              || error instanceof RepositoryIndexCompletionConflictError) {
              await this.outbox.markFailed(row, error.message, false);
            } else {
              // Unknown database/process failures retain the claim so the
              // lease can recover atomic completion after a crash.
              throw error;
            }
          }
        }
      } else {
        await this.outbox.markDelivered(row);
      }
    }
    else await this.outbox.markFailed(
      row, result.detail ?? `status ${result.status_code}`, result.retryable, result.retry_after_ms,
    );
    return result;
  }
}
