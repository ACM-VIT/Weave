import { DataReconciliationService } from '../services/dataReconciliationService.js';
import { OutboxService } from '../services/outboxService.js';

export class DataReconciliationWorker {
  constructor(
    private readonly service = new DataReconciliationService(),
    private readonly outbox = new OutboxService(),
  ) {}
  async runOnce(): Promise<void> {
    await this.service.reconcileCounters();
    await this.service.resetAbandonedClaims();
    await this.outbox.reconcileSupersededRepositoryJobs();
  }
}
