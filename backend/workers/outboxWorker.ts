import type {
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
    private readonly scheduleOnboardingPrewarm = false,
  ) {}

  private deliver(row: OutboxRow) {
    if (row.job_type === 'feedback') {
      return this.transport.deliverFeedback({ schema_version: 2, events: [row.payload as unknown as MlFeedbackBatch['events'][number]] });
    }
    if (row.job_type === 'onboard') return this.transport.deliverOnboarding(row.payload as unknown as MlOnboardingJob);
    if (row.job_type === 'repo_index') return this.transport.deliverRepositoryIndex(row.payload as unknown as MlRepositoryIndexJob);
    return this.transport.deliverRepositoryRefresh(row.payload as unknown as MlRepositoryRefreshJob);
  }

  async runOnce(limit = 1): Promise<number> {
    let processed = 0;
    for (let index = 0; index < limit; index++) {
      // Claim immediately before delivery so rows never wait behind an older
      // sequential request while their database lease is already ticking.
      const [row] = await this.outbox.claim(1);
      if (!row) break;
      const result = await this.deliver(row);
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
          await this.outbox.markDelivered(row, this.scheduleOnboardingPrewarm);
        }
      }
      else await this.outbox.markFailed(
        row, result.detail ?? `status ${result.status_code}`, result.retryable, result.retry_after_ms,
      );
      processed++;
    }
    return processed;
  }
}
