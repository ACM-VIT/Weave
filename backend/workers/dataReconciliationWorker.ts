import { DataReconciliationService } from '../services/dataReconciliationService.js';

export class DataReconciliationWorker {
  constructor(private readonly service = new DataReconciliationService()) {}
  async runOnce(): Promise<number> {
    const result = await this.service.reconcileCounters();
    return result.hasMore ? 1 : 0;
  }
  async resetAbandonedClaims(): Promise<number> { return this.service.resetAbandonedClaims(); }
}
