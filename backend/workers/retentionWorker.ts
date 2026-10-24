import { sqlClient } from '../db/index.js';

export class RetentionWorker {
  async pruneModelCopies(batchSize=1000):Promise<{contexts:number;feedbackCopies:number}>{
    const [row]=await sqlClient`SELECT * FROM telemetry.prune_model_transients(${batchSize}::integer)`;
    return {contexts:Number(row.contexts),feedbackCopies:Number(row.feedback_copies)};
  }
  async runOnce(deliveredDays = 30, generationDays = 30): Promise<{ outbox: number; generations: number }> {
    const [row] = await sqlClient`SELECT * FROM telemetry.prune_runtime_history(${deliveredDays}::integer,${generationDays}::integer)`;
    await this.pruneModelCopies();
    return { outbox: Number(row.outbox), generations: Number(row.generations) };
  }
}
