import { DataReconciliationService } from '../services/dataReconciliationService.js';
import { OutboxService } from '../services/outboxService.js';

export class DataReconciliationWorker {
  constructor(
    private readonly service = new DataReconciliationService(),
    private readonly outbox = new OutboxService(),
  ) {}
  async runOnce(): Promise<number> {
    const result = await this.service.reconcileCounters();
    return result.hasMore ? 1 : 0;
  }
  async resetAbandonedClaims(): Promise<number> {
    // Both outbox repairs retain the independent five-minute cadence, not the
    // adaptive counter-batch loop. Failures propagate to the next scheduled retry.
    const reset = await this.service.resetAbandonedClaims();
    return reset + await this.outbox.reconcileSupersededRepositoryJobs();
  }
}
